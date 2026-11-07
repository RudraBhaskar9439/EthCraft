import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {keccak256,parseEventLogs,parseAbi,zeroAddress,formatUnits,formatEther} from 'viem'
import {buildLp,lpApprovalCalls,displayAmounts,positionAbi,readPool,readPosition,tokenAbi} from './v4.mjs'
import {previewGuardedSwap} from './swaps.mjs'
import {stable} from '../world-assets/canonical.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}
const hash=value=>createHash('sha256').update(value).digest('hex')
const normalized=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v))
const stageId=(id,index)=>{const h=hash(id+':investment:'+index);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`}
const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
export const investmentRisk='Optional testnet investment. Fees are variable; LP principal can lose value through price movement, adverse selection and LVR. Same-pool TWAP is not an independent fair-price oracle. Public submission is not sandwich-proof.'

/** Native consent authorizes immutable stages; refreshed terms always require new consent. */
export async function createInvestmentService({pool,manifest,client,identity,serverId,gameSession,verifyDeployment,getSigner,getRecoverySigner=getSigner,now=Date.now}) {
  if(manifest.chainId!==1301||manifest.mode!=='marketplace'||manifest.rpcUrl!=='https://sepolia.unichain.org')fail('INVEST_TESTNET_ONLY')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_investment_operations(
    operation_id uuid PRIMARY KEY,principal_id uuid NOT NULL,player_id uuid NOT NULL,subject_hash text NOT NULL,
    connection_id uuid NOT NULL,terms jsonb NOT NULL,wallet jsonb NOT NULL,consent_nonce text NOT NULL,
    consent jsonb,state jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION protect_investment_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (NEW.operation_id,NEW.principal_id,NEW.player_id,NEW.subject_hash,NEW.connection_id,NEW.terms,NEW.wallet,NEW.consent_nonce,NEW.created_at)
      IS DISTINCT FROM (OLD.operation_id,OLD.principal_id,OLD.player_id,OLD.subject_hash,OLD.connection_id,OLD.terms,OLD.wallet,OLD.consent_nonce,OLD.created_at)
      OR (OLD.consent IS NOT NULL AND NEW.consent IS DISTINCT FROM OLD.consent)
    THEN RAISE EXCEPTION 'INVEST_IMMUTABLE_TERMS'; END IF; RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS protect_investment_operation ON ac_investment_operations;
    CREATE TRIGGER protect_investment_operation BEFORE UPDATE ON ac_investment_operations FOR EACH ROW EXECUTE FUNCTION protect_investment_operation();`)
  async function account(input) {
    if(!UUID.test(input.playerId||'')||!UUID.test(input.connectionId||''))fail('INVEST_CURRENT_CONNECTION_REQUIRED')
    const owner=await identity.getMinecraftOwner(serverId,input.playerId),session=await gameSession({playerId:input.playerId})
    if(!UUID.test(owner?.ownerId||'')||!owner.privySubject||owner.minecraftPlayerId?.toLowerCase()!==input.playerId.toLowerCase()||
      session?.online!==true||session.pendingAuthentication!==false||session.connectionId?.toLowerCase()!==input.connectionId.toLowerCase()||
      session.principalId!==owner.ownerId||session.playerId?.toLowerCase()!==input.playerId.toLowerCase()||session.playerName?.toLowerCase()!==owner.ownerName?.toLowerCase()||
      !['discord_approved_local_profile','minecraft_online_mode'].includes(session.authenticationKind)||session.serverId&&session.serverId!==serverId)fail('INVEST_APPROVED_PLAYER_REQUIRED')
    const rows=(await pool.query(`SELECT w.*,a.principal_id,a.address AS alias_address,a.provider_account_id AS alias_provider
      FROM ac_playable_testnet_wallets w JOIN ac_discord_wallet_aliases a USING(wallet_id) WHERE w.wallet_id=$1`,['UNICHAIN_SEPOLIA_PLAYABLE:'+owner.ownerId])).rows
    const w=rows[0]
    if(rows.length!==1||w.provider_type!=='privy'||w.environment!=='UNICHAIN_SEPOLIA_PLAYABLE'||w.auth_subject_hash!==hash(owner.privySubject)||w.principal_id!==owner.ownerId||
      w.alias_address?.toLowerCase()!==w.address?.toLowerCase()||w.alias_provider!==w.provider_account_id)fail('INVEST_EXISTING_PRIVY_GAME_WALLET_REQUIRED')
    return {owner,wallet:{address:w.address.toLowerCase(),walletId:w.wallet_id,providerAccountId:w.provider_account_id,externalId:w.external_id},subjectHash:hash(owner.privySubject)}
  }
  const save=row=>pool.query('UPDATE ac_investment_operations SET state=$2 WHERE operation_id=$1',[row.operation_id,normalized(row.state)])
  async function owned(input) {
    const actor=await account(input)
    if(!UUID.test(input.operationId||''))fail('INVEST_OPERATION_REQUIRED')
    const row=(await pool.query('SELECT * FROM ac_investment_operations WHERE operation_id=$1',[input.operationId])).rows[0]
    if(!row||row.principal_id!==actor.owner.ownerId||row.player_id!==input.playerId.toLowerCase()||row.subject_hash!==actor.subjectHash||row.wallet.address!==actor.wallet.address||row.wallet.providerAccountId!==actor.wallet.providerAccountId)fail('INVEST_OPERATION_OWNER_REQUIRED')
    return {row,...actor}
  }
  async function snapshot(tokenId,owner) {
    const pins=await verifyDeployment(),block=await client.getBlock()
    if(Number(block.timestamp)*1000>now()+10000||now()-Number(block.timestamp)*1000>60000)fail('INVEST_STALE_CHAIN')
    const pool=await readPool(client,manifest,block.number)
    const value={blockNumber:block.number,pool,pins,timestamp:Number(block.timestamp)}
    if(tokenId)value.position=await readPosition(client,manifest,tokenId,owner,value)
    if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)fail('INVEST_SNAPSHOT_REORGANIZED')
    return value
  }
  function view(row) {
    const t=row.terms
    return {mode:'investment',operationId:row.operation_id,action:t.action,chainId:1301,walletAddress:row.wallet.address,consentNonce:row.consent_nonce,
      status:row.state.replacementOperationId?'refreshed':row.state.complete?'complete':row.state.reverted?'reverted':row.consent?'pending':'preview',confirmed:!!row.consent,
      tokenId:row.state.tokenId||t.tokenId,lines:[...t.lines,...(row.state.actualFeesCollected?[`Actual fees collected (token/base units): ${JSON.stringify(row.state.actualFeesCollected)}`]:[]),
        ...(row.state.received&&t.action==='withdraw'?[`Actual principal plus fees received (base units): ${JSON.stringify(row.state.received)}`]:[])],risk:investmentRisk,deadline:t.deadline,stages:row.state.stages||[],
      canConfirm:!t.fundingIssues?.length,blocker:row.state.blocker||t.fundingIssues?.[0]||null,realTransaction:!!row.consent&&Boolean(row.state.stages?.some(s=>s.hash)),simulated:false}
  }
  async function funding(terms,address) {
    const issues=[]
    const spends=['deposit','increase'].includes(terms.action)?terms.amounts.map((amount,i)=>({token:manifest.pools.cityUsdc['currency'+i],amount})):
      terms.action==='swap'?[{token:terms.tokenIn==='CITY'?manifest.city:manifest.usdc,amount:terms.maximumInput}]:[]
    for(const {token,amount}of spends){const balance=await client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[address]});const stable=token.toLowerCase()===manifest.usdc.toLowerCase(),decimals=stable?6:18;if(balance<BigInt(amount))issues.push(`Needs ${formatUnits(BigInt(amount),decimals)} ${stable?'tUSDC':'CITY'}; balance ${formatUnits(balance,decimals)}.`)}
    const native=await client.getBalance({address}),required=BigInt(terms.limits.maxNativeCostWei)*BigInt(terms.calls.length)
    if(native<required)issues.push(`Needs maximum gas reserve ${formatEther(required)} test ETH; balance ${formatEther(native)}.`)
    return issues
  }
  async function preview(input) {
    const actor=await account(input),snap=await snapshot(input.tokenId,actor.wallet.address)
    const id=randomUUID()
    if(['deposit','increase'].includes(input.action)) {
      const guard=await client.readContract({address:manifest.hook,abi:[{type:'function',name:'marketReference',stateMutability:'view',inputs:[],outputs:[{type:'bool'},{type:'int24'},{type:'uint64'},{type:'uint64'}]}],functionName:'marketReference',blockNumber:snap.blockNumber})
      if(!guard[0])fail('INVEST_REFERENCE_NOT_READY')
    }
    const terms=input.action==='swap'?await previewGuardedSwap({manifest,client,snapshot:snap,input,owner:actor.wallet.address,operationId:id})
      :buildLp(manifest,snap,input,actor.wallet.address,snap.timestamp+300)
    const calls=terms.calls||[...lpApprovalCalls(manifest,terms),terms.call]
    const maxGas=Math.min(Number(manifest.maxGas),1000000),maxNativeCostWei=String(BigInt(manifest.maxNativeCostWei)<30000000000000n?manifest.maxNativeCostWei:30000000000000n)
    const amountLabels=displayAmounts(snap.pool.key,manifest,terms.amounts||['0','0'])
    const label=i=>snap.pool.key['currency'+i].toLowerCase()===manifest.usdc.toLowerCase()?'tUSDC':'CITY'
    const maxTotalGas=BigInt(maxNativeCostWei)*BigInt(calls.length)
    terms.calls=calls;terms.pins=snap.pins;terms.limits={maxGas,maxNativeCostWei};terms.deploymentId=manifest.deploymentId
    terms.reviewInput=Object.fromEntries(['action','tokenId','amount0','amount1','tickLower','tickUpper','withdrawBps','tokenIn','tokenOut','amountOut','maximumInput','slippageBps'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))
    terms.lines=terms.lines||[`Action: ${terms.action}`,`Wallet: ${actor.wallet.address}`,`Pool: CITY / tUSDC (chain 1301)`,
      `${['deposit','increase'].includes(terms.action)?'Maximum deposits':'Minimum principal outputs'}: ${amountLabels.map((a,i)=>a+' '+label(i)).join(' + ')}`,
      `Range: ${terms.range.join(' to ')} ${label(1)} / ${label(0)}`,`Ticks: ${terms.tickLower} to ${terms.tickUpper}`,
      `Position: ${terms.tokenId||'new NFT owned by your wallet'}`,`In range: ${snap.position?.inRange??true}`,
      `Accrued fees now: ${displayAmounts(snap.pool.key,manifest,snap.position?.fees||['0','0']).map((a,i)=>a+' '+label(i)).join(' + ')}`,
      `Slippage: ${terms.slippageBps/100}%`, `Gas ceiling: ${formatEther(maxTotalGas)} test ETH across ${calls.length} transactions (actual gas varies)`,
      `Expiry: ${new Date(Number(terms.deadline)*1000).toISOString()}`,`Permit2 allowance expires with review; ERC20 approvals remain bounded.`,investmentRisk]
    if(input.action==='swap')terms.lines.push(`Gas ceiling: ${formatEther(maxTotalGas)} test ETH across ${calls.length} transactions.`,investmentRisk)
    terms.fundingIssues=await funding(terms,actor.wallet.address)
    terms.lines.push(...terms.fundingIssues)
    const nonce=randomBytes(32).toString('base64url')
    await pool.query(`INSERT INTO ac_investment_operations(operation_id,principal_id,player_id,subject_hash,connection_id,terms,wallet,consent_nonce)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,actor.owner.ownerId,input.playerId.toLowerCase(),actor.subjectHash,input.connectionId.toLowerCase(),normalized(terms),actor.wallet,nonce])
    return view((await pool.query('SELECT * FROM ac_investment_operations WHERE operation_id=$1',[id])).rows[0])
  }
  async function locked(input,work) {
    const db=await pool.connect()
    try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['invest:'+input.operationId]);return await work(await owned(input))}
    finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['invest:'+input.operationId]);db.release()}
  }
  async function freshReview(row,input) {
    if(row.state.replacementOperationId){
      const {row:next}=await owned({...input,operationId:row.state.replacementOperationId})
      return !next.consent&&now()>=Number(next.terms.deadline)*1000?freshReview(next,input):view(next)
    }
    const t=row.terms
    const request=t.reviewInput||(t.action==='swap'?{action:t.action,tokenIn:t.tokenIn,tokenOut:t.tokenOut,amountOut:t.amountOut,maximumInput:t.maximumInput}:
      ['deposit','increase','collect'].includes(t.action)?{action:t.action,tokenId:t.tokenId,amount0:t.amounts[0],amount1:t.amounts[1],tickLower:t.tickLower,tickUpper:t.tickUpper,slippageBps:t.slippageBps}:null)
    if(!request)return {...view(row),status:'expired',canConfirm:false,blocker:'Open this LP position to review a fresh withdrawal.'}
    const next=await preview({...request,playerId:input.playerId,connectionId:input.connectionId})
    row.state.replacementOperationId=next.operationId;await save(row)
    return {...next,lines:['Quote refreshed. Review the new terms and confirm again; no new payment is authorized.',...next.lines]}
  }
  async function advance(row,actor,signer,allowNew) {
    const pins=await verifyDeployment()
    if(stable(pins)!==stable(row.terms.pins))fail('INVEST_DEPLOYMENT_CHANGED')
    const t=row.terms;row.state.stages||=[]
    for(let index=0;index<t.calls.length;index++) {
      const operationId=stageId(row.operation_id,index),call=t.calls[index]
      let stage=row.state.stages[index]
      if(stage?.status==='confirmed') {
        // Recheck canonicality before issuing the next stage or claiming completion.
        const receipt=await signer.reconcile({operationId,playerId:actor.owner.ownerId,subject:actor.owner.privySubject})
        if((receipt.hash||receipt.transactionHash)!==stage.hash)fail('INVEST_RETAINED_TRANSACTION_CHANGED')
        if(receipt.status!=='confirmed'){stage.status=receipt.status;row.state.complete=false;await save(row);return view(row)}
        continue
      }
      if(!stage&&!allowNew)return view(row)
      if(!stage){
        if(now()>=Number(t.deadline)*1000)fail('INVEST_EXPIRED_REVIEW_NEW_TERMS_REQUIRED')
        // Immutable call bytes come only from our bounded official-v4 builder, never a model or API response.
        stage={operationId,to:call.to,dataHash:keccak256(call.data),status:'preparing'};row.state.stages[index]=stage;await save(row)
      }
      const request={operationId,playerId:actor.owner.ownerId,subject:actor.owner.privySubject,...call,limits:t.limits}
      if(stage.to!==call.to||stage.dataHash!==keccak256(call.data))fail('INVEST_STAGE_CHANGED')
      if(now()>=Number(t.deadline)*1000&&!stage.hash) {
        const retained=(await pool.query('SELECT 1 FROM ac_playable_testnet_requests WHERE operation_id=$1',[operationId])).rowCount
        if(!retained)fail('INVEST_EXPIRED_REVIEW_NEW_TERMS_REQUIRED')
      }
      if(!stage.hash){const prepared=await signer.prepare(request);stage.hash=prepared.hash||prepared.transactionHash;await save(row)}
      const result=await signer.reconcile(request)
      if((result.hash||result.transactionHash)!==stage.hash)fail('INVEST_RETAINED_TRANSACTION_CHANGED')
      stage.status=result.status
      if(result.status==='reverted'){row.state.reverted=true;await save(row);return view(row)}
      if(result.status!=='confirmed') {
        // Resends the journal's original bytes only; a fresh nonce is never a recovery strategy.
        if(!['reorganized','confirming'].includes(result.status))await signer.broadcast(request)
        await save(row);return view(row)
      }
      if(index===t.calls.length-1) {
        const receipt=result.receipt||await client.getTransactionReceipt({hash:stage.hash})
        if(t.action==='deposit') {
          const minted=parseEventLogs({abi:positionAbi,eventName:'Transfer',logs:receipt.logs.filter(l=>l.address.toLowerCase()===manifest.positionManager.toLowerCase()),strict:true})
            .filter(l=>l.args.from===zeroAddress&&l.args.to.toLowerCase()===row.wallet.address)
          if(minted.length!==1)fail('INVEST_POSITION_MINT_RECEIPT_REQUIRED')
          row.state.tokenId=String(minted[0].args.tokenId)
        }
        if(t.action==='collect'||t.action==='withdraw') {
          row.state.received=Object.fromEntries([manifest.city,manifest.usdc].map(token=>{
            const events=parseEventLogs({abi:transferAbi,eventName:'Transfer',logs:receipt.logs.filter(l=>l.address.toLowerCase()===token.toLowerCase()),strict:true})
            return [token.toLowerCase(),events.filter(l=>l.args.to.toLowerCase()===row.wallet.address&&l.args.from.toLowerCase()===manifest.poolManager.toLowerCase()).reduce((sum,l)=>sum+l.args.value,0n).toString()]
          }))
          if(t.action==='collect')row.state.actualFeesCollected=row.state.received
        }
      }
      await save(row)
    }
    row.state.complete=true;await save(row);return view(row)
  }
  async function execute(input,confirm) {
    return locked(input,async actor=>{
      const {row}=actor
      try{
      if(confirm&&!row.consent) {
        if(input.consentNonce!==row.consent_nonce||!UUID.test(input.confirmationId||'')||row.connection_id!==input.connectionId.toLowerCase())fail('INVEST_FRESH_NATIVE_CONFIRMATION_REQUIRED')
        if(now()>=Number(row.terms.deadline)*1000)return freshReview(row,input)
        // A missing wallet policy must fail before marking consent or reserving a transaction.
        const signer=await getSigner(actor)
        if((await funding(row.terms,row.wallet.address)).length)fail('INVEST_INSUFFICIENT_TEST_FUNDS')
        row.consent={confirmationId:input.confirmationId,connectionId:input.connectionId,at:now(),purpose:'optional-investment-only'}
        await pool.query('UPDATE ac_investment_operations SET consent=$2 WHERE operation_id=$1',[row.operation_id,row.consent])
        return await advance(row,actor,signer,true)
      }
      if(!row.consent)return now()>=Number(row.terms.deadline)*1000?freshReview(row,input):view(row)
      return await advance(row,actor,await getRecoverySigner(actor),true)
      }catch(error){
        if(error.code==='INVEST_EXPIRED_REVIEW_NEW_TERMS_REQUIRED')return freshReview(row,input)
        throw error
      }
    })
  }
  async function portfolio(input) {
    const actor=await account(input),snap=await snapshot(input.tokenId,actor.wallet.address)
    const rows=(await pool.query(`SELECT * FROM ac_investment_operations WHERE principal_id=$1
      ORDER BY (consent IS NOT NULL AND state->>'complete' IS DISTINCT FROM 'true' AND state->>'reverted' IS DISTINCT FROM 'true' AND state->>'replacementOperationId' IS NULL
        AND ((terms->>'deadline')::bigint>$2 OR jsonb_array_length(COALESCE(state->'stages','[]'::jsonb))>0)) DESC,created_at DESC LIMIT 30`,[actor.owner.ownerId,Math.floor(now()/1000)])).rows
    const ids=[...new Set([input.tokenId,...rows.map(r=>r.state.tokenId||r.terms.tokenId)].filter(Boolean))]
    const positions=[]
    for(const id of ids)try{
      const p=await readPosition(client,manifest,id,actor.wallet.address,snap)
      positions.push({tokenId:p.tokenId,owner:p.owner,liquidity:p.liquidity,tickLower:p.tickLower,tickUpper:p.tickUpper,inRange:p.inRange,
        principal:displayAmounts(snap.pool.key,manifest,p.principal),fees:displayAmounts(snap.pool.key,manifest,p.fees)})
    }catch(error){if(error.code!=='INVEST_POSITION_OWNER_REQUIRED')throw error}
    return {mode:'investment',chainId:1301,walletAddress:actor.wallet.address,tick:snap.pool.tick,positions,operations:rows.map(view),risk:investmentRisk}
  }
  return {preview,confirm:input=>execute(input,true),status:input=>execute(input,false),portfolio}
}
