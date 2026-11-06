import {randomUUID,createHash} from 'node:crypto'
import {keccak256,stringToHex} from 'viem'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value
const hash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
const schema=`CREATE TABLE IF NOT EXISTS ac_discord_work_requests (
 id uuid PRIMARY KEY,interaction_id text NOT NULL UNIQUE,requester_id uuid NOT NULL,target_owner_id uuid NOT NULL,
 target_agent text,specification text NOT NULL,state text NOT NULL DEFAULT 'requested',quote jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS request_digest text;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS source_discord_id text;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS active_quote_id uuid;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS accepted_quote_id uuid;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS acceptance jsonb;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS terminal_receipt jsonb;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS funding jsonb;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS execution jsonb;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS settlement jsonb;
ALTER TABLE ac_discord_work_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS ac_discord_work_quotes (
 quote_id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES ac_discord_work_requests(id),version integer NOT NULL,
 author_owner_id uuid NOT NULL,recipient_owner_id uuid NOT NULL,author_kind text NOT NULL,
 author_agent_id text,policy_id text,terms jsonb NOT NULL,digest text NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(work_id,version)
);
CREATE OR REPLACE FUNCTION protect_discord_work_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WORK_QUOTE_VERSION_IMMUTABLE'; END; $$;
DROP TRIGGER IF EXISTS discord_work_quote_immutable ON ac_discord_work_quotes;
CREATE TRIGGER discord_work_quote_immutable BEFORE UPDATE OR DELETE ON ac_discord_work_quotes FOR EACH ROW EXECUTE FUNCTION protect_discord_work_quote();
CREATE OR REPLACE FUNCTION protect_discord_work_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.interaction_id,NEW.requester_id,NEW.target_owner_id,NEW.target_agent,NEW.specification,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.interaction_id,OLD.requester_id,OLD.target_owner_id,OLD.target_agent,OLD.specification,OLD.created_at)
 OR (OLD.acceptance IS NOT NULL AND NEW.acceptance IS DISTINCT FROM OLD.acceptance)
 OR (OLD.accepted_quote_id IS NOT NULL AND NEW.accepted_quote_id IS DISTINCT FROM OLD.accepted_quote_id)
 OR (OLD.accepted_quote_id IS NOT NULL AND NEW.quote IS DISTINCT FROM OLD.quote)
 OR (OLD.funding IS NOT NULL AND (NEW.funding IS NULL
   OR NEW.funding->>'operationId' IS DISTINCT FROM OLD.funding->>'operationId'
   OR NEW.funding->>'quoteId' IS DISTINCT FROM OLD.funding->>'quoteId'
   OR NEW.funding->>'digest' IS DISTINCT FROM OLD.funding->>'digest'))
 OR (OLD.funding->>'status'='confirmed' AND NEW.funding IS DISTINCT FROM OLD.funding)
 OR (OLD.execution->'start' IS NOT NULL AND NEW.execution->'start' IS DISTINCT FROM OLD.execution->'start')
 OR (OLD.execution->'complete' IS NOT NULL AND NEW.execution->'complete' IS DISTINCT FROM OLD.execution->'complete')
 OR (OLD.settlement IS NOT NULL AND NEW.settlement IS DISTINCT FROM OLD.settlement)
 THEN RAISE EXCEPTION 'WORK_REQUEST_ACCEPTED_TERMS_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS discord_work_terms_immutable ON ac_discord_work_requests;
CREATE TRIGGER discord_work_terms_immutable BEFORE UPDATE ON ac_discord_work_requests FOR EACH ROW EXECUTE FUNCTION protect_discord_work_terms();`

function money(price,asset){
 if(typeof price!=='string'||!['GAME_COINS','CITY'].includes(asset)||! /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/.test(price))fail('WORK_PRICE_DECIMAL_STRING_REQUIRED')
 const decimals=asset==='CITY'?18:0,[whole,fraction='']=price.split('.')
 if(fraction.length>decimals)fail('WORK_ASSET_DECIMAL_PRECISION')
 const units=BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0')
 if(units<=0n)fail('WORK_POSITIVE_PRICE_REQUIRED')
 const tail=fraction.replace(/0+$/,'')
 return{price:whole+(tail?'.'+tail:''),asset,amountBaseUnits:String(units),decimals}
}
function materialBill(input={}){
 if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length>64)fail('WORK_MATERIAL_BILL_REQUIRED')
 for(const[item,count]of Object.entries(input))if(!/^(?:minecraft:)?[a-z0-9_]{1,64}$/.test(item)||!Number.isSafeInteger(count)||count<1||count>4096)fail('WORK_MATERIAL_BILL_REQUIRED')
 return ordered(input)
}

// The optional projection accepts only externally verified canonical escrow receipts.
export async function createWorkOrders({pool,authorizeAgentQuote,verifyEscrowReceipt,now=()=>Date.now(),allowLegacyGameCoinsFixture=false}={}){
 if(!pool?.connect||typeof now!=='function')fail('WORK_ORDERS_CONFIGURATION_REQUIRED')
 await pool.query(schema)
 const transaction=async work=>{const tx=await pool.connect();try{await tx.query('BEGIN');const value=await work(tx);await tx.query('COMMIT');return value}catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
 const actor=value=>{if(!UUID.test(value||''))fail('WORK_CANONICAL_OWNER_REQUIRED');return value.toLowerCase()}
 const termsState='terms_accepted_awaiting_funding'
 const requestTerms=row=>({requesterOwnerId:row.requester_id,targetOwnerId:row.target_owner_id,targetAgent:row.target_agent,request:row.specification})
 const quoteView=row=>row?{quoteId:row.quote_id,workId:row.work_id,version:row.version,digest:row.digest,authorOwnerId:row.author_owner_id,recipientOwnerId:row.recipient_owner_id,actorKind:row.author_kind,agentId:row.author_agent_id,...row.terms,deadline:new Date(row.expires_at).toISOString()}:null
 const view=row=>({workId:row.id,id:row.id,...requestTerms(row),state:row.state,quote:row.quote,activeQuoteId:row.active_quote_id,acceptedQuoteId:row.accepted_quote_id,acceptance:row.acceptance,terminalReceipt:row.terminal_receipt,
  funding:row.funding||null,execution:row.execution||null,settlement:row.settlement||null,
  executionAuthorized:Boolean(row.funding?.status==='confirmed'&&row.execution?.start),funded:row.funding?.status==='confirmed',paid:row.settlement?.kind==='accept'})
 async function load(tx,workId,actorOwnerId){
  if(!UUID.test(workId||''))fail('WORK_REQUEST_REQUIRED')
  const row=(await tx.query('SELECT * FROM ac_discord_work_requests WHERE id=$1 FOR UPDATE',[workId])).rows[0]
  if(!row||![row.requester_id,row.target_owner_id].includes(actor(actorOwnerId)))fail('WORK_PARTICIPANT_REQUIRED')
  return row
 }
 async function createRequest({interactionId,requesterOwnerId,targetOwnerId,targetAgent=null,request,sourcedDiscordId}){
  const requester=actor(requesterOwnerId),target=actor(targetOwnerId)
  if(typeof interactionId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(interactionId)||typeof request!=='string'||!request.trim()||request.length>3000||
    targetAgent!==null&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(targetAgent)||! /^[0-9]{5,22}$/.test(sourcedDiscordId||''))fail('WORK_REQUEST_INVALID')
  const identity=(await pool.query('SELECT principal_id FROM ac_discord_identities WHERE discord_user_id=$1',[sourcedDiscordId])).rows[0]
  if(identity?.principal_id!==requester)fail('WORK_DISCORD_ACTOR_BINDING_REQUIRED')
  const targetIdentity=(await pool.query('SELECT principal_id FROM ac_discord_identities WHERE principal_id=$1',[target])).rows[0]
  if(!targetIdentity)fail('WORK_TARGET_ONBOARDING_REQUIRED')
  const terms={requesterOwnerId:requester,targetOwnerId:target,targetAgent,request:request.trim()},digest=hash(terms)
  return transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['discord-work:'+interactionId])
   const existing=(await tx.query('SELECT * FROM ac_discord_work_requests WHERE interaction_id=$1',[interactionId])).rows[0]
   if(existing){if(hash(requestTerms(existing))!==digest||existing.source_discord_id&&existing.source_discord_id!==sourcedDiscordId)fail('WORK_REQUEST_IMMUTABLE_TERMS');return view(existing)}
   return view((await tx.query(`INSERT INTO ac_discord_work_requests(id,interaction_id,requester_id,target_owner_id,target_agent,specification,request_digest,source_discord_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),interactionId,requester,target,targetAgent,terms.request,digest,sourcedDiscordId])).rows[0])
  })
 }
 async function proposeQuote({workId,actorOwnerId,price,asset=allowLegacyGameCoinsFixture?'GAME_COINS':'CITY',materials={},scope,deadline,actorKind='human',agentId}){
  if(!allowLegacyGameCoinsFixture&&asset!=='CITY')fail('GAME_COINS_RETIRED')
  const owner=actor(actorOwnerId),amount=money(price,asset),bill=materialBill(materials)
  if(!['human','agent'].includes(actorKind)||actorKind==='agent'&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(agentId||''))fail('WORK_QUOTE_ACTOR_REQUIRED')
  return transaction(async tx=>{
   const row=await load(tx,workId,owner)
   if(row.target_owner_id!==owner)fail('WORK_EXECUTOR_OWNER_QUOTE_REQUIRED')
   if(!['requested','quoted'].includes(row.state))fail('WORK_TERMS_ALREADY_CLOSED')
   const current=row.active_quote_id?(await tx.query('SELECT * FROM ac_discord_work_quotes WHERE quote_id=$1',[row.active_quote_id])).rows[0]:null
   const expiry=deadline===undefined?(current?+new Date(current.expires_at):now()+86400000):+new Date(deadline)
   if(!Number.isFinite(expiry)||expiry<=now()||expiry>now()+7*86400000)fail('WORK_QUOTE_DEADLINE_REQUIRED')
   const specification=scope===undefined?row.specification:scope
   if(typeof specification!=='string'||!specification.trim()||specification.length>3000)fail('WORK_QUOTE_SCOPE_REQUIRED')
   let policyId=null
   if(actorKind==='agent'){
    if(row.target_agent&&row.target_agent!==agentId)fail('WORK_TARGET_AGENT_BINDING_REQUIRED')
    const grant=typeof authorizeAgentQuote==='function'&&await authorizeAgentQuote({workId,actorOwnerId:owner,agentId,...amount,materials:bill,scope:specification,deadline:new Date(expiry).toISOString()})
    if(grant?.allowed!==true||grant.ownerId!==owner||grant.agentId!==agentId||typeof grant.policyId!=='string'||!grant.policyId||!Number.isFinite(+new Date(grant.expiresAt))||+new Date(grant.expiresAt)<=now())fail('EXPLICIT_OWNER_AGENT_QUOTE_POLICY_REQUIRED')
    policyId=grant.policyId
   }
   const terms={...requestTerms(row),...amount,materials:bill,scope:specification.trim(),deadline:new Date(expiry).toISOString(),authorOwnerId:owner,recipientOwnerId:row.requester_id,actorKind,agentId:actorKind==='agent'?agentId:null,policyId}
   const fingerprint=hash(terms)
   if(current?.digest===fingerprint)return quoteView(current)
   const version=Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM ac_discord_work_quotes WHERE work_id=$1',[workId])).rows[0].version)
   const quote=(await tx.query(`INSERT INTO ac_discord_work_quotes(quote_id,work_id,version,author_owner_id,recipient_owner_id,author_kind,author_agent_id,policy_id,terms,digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[randomUUID(),workId,version,owner,row.requester_id,actorKind,actorKind==='agent'?agentId:null,policyId,terms,fingerprint,new Date(expiry)])).rows[0]
   await tx.query("UPDATE ac_discord_work_requests SET state='quoted',active_quote_id=$2,quote=$3,updated_at=now() WHERE id=$1",[workId,quote.quote_id,quoteView(quote)])
   return quoteView(quote)
  })
 }
 async function acceptQuote({workId,actorOwnerId,quoteId,digest}){
  return transaction(async tx=>{
   const row=await load(tx,workId,actorOwnerId)
   if(row.requester_id!==actor(actorOwnerId))fail('WORK_REQUESTER_ACCEPTANCE_REQUIRED')
   if(!UUID.test(quoteId||'')||! /^[a-f0-9]{64}$/.test(digest||''))fail('WORK_EXACT_QUOTE_ID_AND_DIGEST_REQUIRED')
   if(row.state===termsState){if(row.accepted_quote_id!==quoteId||row.acceptance?.digest!==digest)fail('WORK_ACCEPTANCE_IMMUTABLE_TERMS');return view(row)}
   if(row.state!=='quoted'||row.active_quote_id!==quoteId)fail('WORK_QUOTE_REVISED_OR_CLOSED')
   const quote=(await tx.query('SELECT * FROM ac_discord_work_quotes WHERE quote_id=$1 AND work_id=$2',[quoteId,workId])).rows[0]
   if(!quote||quote.digest!==digest||hash(quote.terms)!==digest)fail('WORK_QUOTE_DIGEST_MISMATCH')
   if(!allowLegacyGameCoinsFixture&&quote.terms.asset!=='CITY')fail('GAME_COINS_RETIRED')
   for(const[field,value]of Object.entries(requestTerms(row)))if(quote.terms[field]!==value)fail('WORK_QUOTE_PARTICIPANT_OR_SPECIFICATION_CHANGED')
   if(+new Date(quote.expires_at)<=now())fail('WORK_QUOTE_EXPIRED')
   const acceptance={quoteId,digest,requesterOwnerId:row.requester_id,executorOwnerId:row.target_owner_id,acceptedAt:new Date(now()).toISOString(),fundingRequired:true,executionAuthorized:false}
   return view((await tx.query('UPDATE ac_discord_work_requests SET state=$2,accepted_quote_id=$3,acceptance=$4,updated_at=now() WHERE id=$1 RETURNING *',[workId,termsState,quoteId,acceptance])).rows[0])
  })
 }
 async function terminal({workId,actorOwnerId,quoteId,reason=''},state){
  if(typeof reason!=='string'||reason.length>500)fail('WORK_TERMINAL_REASON_INVALID')
  return transaction(async tx=>{
   const row=await load(tx,workId,actorOwnerId)
   if(state==='cancelled'&&row.requester_id!==actor(actorOwnerId))fail('WORK_REQUESTER_CANCELLATION_REQUIRED')
   if(row.state===state)return view(row)
   if(!['requested','quoted',termsState].includes(row.state))fail('WORK_TERMS_ALREADY_CLOSED')
   if(quoteId!==undefined&&row.active_quote_id!==quoteId)fail('WORK_QUOTE_REVISED_OR_CLOSED')
   const receipt={actorOwnerId:actor(actorOwnerId),reason,state,recordedAt:new Date(now()).toISOString(),moneyMoved:false}
   return view((await tx.query('UPDATE ac_discord_work_requests SET state=$2,terminal_receipt=$3,updated_at=now() WHERE id=$1 RETURNING *',[workId,state,receipt])).rows[0])
  })
 }
 async function list({actorOwnerId,direction='all',limit=25}={}){
  const owner=actor(actorOwnerId)
  if(!['all','inbox','outbox'].includes(direction)||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('WORK_LIST_SCOPE_INVALID')
  return(await pool.query(`SELECT * FROM ac_discord_work_requests WHERE ($2='all' AND (requester_id=$1 OR target_owner_id=$1))
   OR ($2='inbox' AND target_owner_id=$1) OR ($2='outbox' AND requester_id=$1) ORDER BY created_at DESC,id LIMIT $3`,[owner,direction,limit])).rows.map(view)
 }
 async function reserveFunding({workId,actorOwnerId,quoteId,digest,operationId}){
  if(typeof verifyEscrowReceipt!=='function')fail('WORK_ESCROW_VERIFIER_REQUIRED')
  if(!UUID.test(operationId||''))fail('WORK_FUNDING_OPERATION_REQUIRED')
  return transaction(async tx=>{
   const row=await load(tx,workId,actorOwnerId)
   if(row.requester_id!==actor(actorOwnerId)||row.accepted_quote_id!==quoteId||row.acceptance?.digest!==digest)fail('WORK_ACCEPTED_FUNDING_TERMS_REQUIRED')
   if(row.funding){if(row.funding.operationId!==operationId||row.funding.quoteId!==quoteId||row.funding.digest!==digest)fail('WORK_FUNDING_INTENT_IMMUTABLE');return view(row)}
   if(row.state!==termsState)fail('WORK_FUNDING_STATE_REQUIRED')
   const funding={operationId,quoteId,digest,status:'pending'}
   return view((await tx.query("UPDATE ac_discord_work_requests SET state='funding_pending',funding=$2,updated_at=now() WHERE id=$1 RETURNING *",[workId,funding])).rows[0])
  })
 }
 async function projectEscrow({workId,actorOwnerId,kind,proof}){
  if(typeof verifyEscrowReceipt!=='function'||!['fund','start','complete','accept','refund'].includes(kind))fail('WORK_ESCROW_VERIFIER_REQUIRED')
  return transaction(async tx=>{
   const row=await load(tx,workId,actorOwnerId)
   if(!row.funding||!row.acceptance||!row.accepted_quote_id)fail('WORK_FUNDING_INTENT_REQUIRED')
   const events={fund:'WorkFunded',start:'WorkStarted',complete:'WorkCompleted',accept:'WorkAccepted',refund:'WorkRefunded'}
   if(!proof?.confirmed||proof.eventName!==events[kind]||!/^0x[a-f0-9]{64}$/i.test(proof.transactionHash||''))fail('WORK_CANONICAL_ESCROW_RECEIPT_REQUIRED')
   if(String(proof.args?.workId).toLowerCase()!==keccak256(stringToHex(workId)))fail('WORK_EXACT_ESCROW_WORK_REQUIRED')
   const verified=await verifyEscrowReceipt({kind,proof,workId,quote:row.quote,acceptance:row.acceptance,funding:row.funding})
   if(verified!==true&&verified?.confirmed!==true)fail('WORK_CANONICAL_ESCROW_RECEIPT_REQUIRED')
   if(['fund','accept','refund'].includes(kind)&&String(proof.args?.amount)!==String(row.quote.amountBaseUnits))fail('WORK_EXACT_ESCROW_AMOUNT_REQUIRED')
   if(['fund','start','complete'].includes(kind)&&String(proof.args?.termsHash).toLowerCase()!=='0x'+row.acceptance.digest)fail('WORK_EXACT_ESCROW_TERMS_REQUIRED')
   if(kind==='accept'&&(proof.args?.resultHash!==row.execution?.complete?.args?.resultHash||proof.args?.worker!==row.funding.proof?.args?.worker))fail('WORK_EXACT_ESCROW_RESULT_REQUIRED')
   if(kind==='refund'&&proof.args?.requester!==row.funding.proof?.args?.requester)fail('WORK_EXACT_ESCROW_REQUESTER_REQUIRED')
   const execution=row.execution||{},previous=kind==='fund'?row.funding.proof:kind==='start'?execution.start:kind==='complete'?execution.complete:row.settlement?.proof
   const receiptIdentity=value=>hash({chainId:value.chainId,transactionHash:value.transactionHash,blockHash:value.blockHash,logIndex:value.logIndex,eventName:value.eventName,args:value.args})
   if(previous){if(receiptIdentity(previous)!==receiptIdentity(proof))fail('WORK_ESCROW_RECEIPT_IMMUTABLE');return view(row)}
   const allowed={fund:['funding_pending'],start:['funded'],complete:['running'],accept:['completed'],refund:['funded','running','completed']}
   if(!allowed[kind].includes(row.state))fail('WORK_ESCROW_PROJECTION_ORDER_REQUIRED')
   let funding=row.funding,settlement=row.settlement,state={fund:'funded',start:'running',complete:'completed',accept:'paid',refund:'refunded'}[kind]
   if(kind==='fund')funding={...funding,status:'confirmed',proof}
   if(kind==='start')execution.start=proof
   if(kind==='complete')execution.complete=proof
   if(kind==='accept'||kind==='refund')settlement={kind,proof}
   return view((await tx.query('UPDATE ac_discord_work_requests SET state=$2,funding=$3,execution=$4,settlement=$5,updated_at=now() WHERE id=$1 RETURNING *',[workId,state,funding,execution,settlement])).rows[0])
  })
 }
 return{createRequest,proposeQuote,acceptQuote,decline:input=>terminal(input,'declined'),cancel:input=>terminal(input,'cancelled'),list,
  reserveFunding,projectEscrow,
  get:input=>transaction(async tx=>view(await load(tx,input.workId,input.actorOwnerId)))}
}
