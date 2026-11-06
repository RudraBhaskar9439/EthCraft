import {encodeFunctionData,parseAbi,parseEventLogs} from 'viem'
import {digest,lower,json} from '../world-assets/canonical.mjs'
import {TEST_CITY_GRANT_AMOUNT,TEST_CITY_GRANT_RECIPIENT,TEST_CITY_GRANT_TOKEN,testCityGrantOperationId} from '../bank/operator-wallets.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH=/^0x[a-f0-9]{64}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}
const abi=parseAbi(['function transfer(address to,uint256 value) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)'])
const disclosure='One-time 100 test CITY onboarding grant. This is not earnings, USD value or a reward for Minecraft work. No tokens are minted.'

export async function inventoryShopCityGrantStatus(pool,principalId,recipient){
  if(!(await pool.query("SELECT to_regclass('ac_inventory_shop_city_grants') IS NOT NULL AS present")).rows[0].present)return null
  const row=(await pool.query('SELECT state,operation_id,transaction_hash,receipt FROM ac_inventory_shop_city_grants WHERE principal_id=$1 AND recipient=$2',[principalId,lower(recipient)])).rows[0]
  return row?{status:row.state,operationId:row.operation_id,transactionHash:row.transaction_hash,amountCity:'100',disclosure}:null
}

/** A single transfer from existing free operator funds, using its original gas/nonce journal. */
export async function createInventoryShopFunding({pool,manifest,wallets,client,resolveIdentity,authorize}={}){
  if(!pool?.connect||!wallets?.testCityGrant||typeof resolveIdentity!=='function'||typeof authorize!=='function'||!client)fail('INVENTORY_SHOP_FUNDING_CONFIGURATION_REQUIRED')
  const operationId=testCityGrantOperationId(manifest),signer=wallets.testCityGrant(),source=lower(signer.address)
  if(signer.operationId!==operationId)fail('INVENTORY_SHOP_FUNDING_ORIGINAL_JOURNAL_REQUIRED')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_inventory_shop_city_grants(
    grant_id integer PRIMARY KEY CHECK(grant_id=1),operation_id uuid NOT NULL UNIQUE,principal_id uuid NOT NULL UNIQUE,
    subject_hash text NOT NULL,recipient text NOT NULL UNIQUE,source text NOT NULL,city text NOT NULL,
    terms_digest text NOT NULL,state text NOT NULL DEFAULT 'preview',consent jsonb,transaction_hash text,receipt jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION ac_protect_inventory_shop_city_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (NEW.operation_id,NEW.principal_id,NEW.subject_hash,NEW.recipient,NEW.source,NEW.city,NEW.terms_digest,NEW.created_at)
        IS DISTINCT FROM (OLD.operation_id,OLD.principal_id,OLD.subject_hash,OLD.recipient,OLD.source,OLD.city,OLD.terms_digest,OLD.created_at)
        OR (OLD.consent IS NOT NULL AND NEW.consent IS DISTINCT FROM OLD.consent)
        OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
        OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
        OR (OLD.state='complete' AND NEW.state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'INVENTORY_SHOP_CITY_GRANT_IMMUTABLE'; END IF;
      RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS protect_inventory_shop_city_grant ON ac_inventory_shop_city_grants;
    CREATE TRIGGER protect_inventory_shop_city_grant BEFORE UPDATE ON ac_inventory_shop_city_grants FOR EACH ROW EXECUTE FUNCTION ac_protect_inventory_shop_city_grant();`)
  const terms={chainId:1301,city:TEST_CITY_GRANT_TOKEN,recipient:TEST_CITY_GRANT_RECIPIENT,source,amountBaseUnits:String(TEST_CITY_GRANT_AMOUNT),nativeAmountWei:'0',maximumGrants:1}
  const view=row=>({operationId:row.operation_id,termsDigest:row.terms_digest,status:row.state,terms,disclosure,
    transactionHash:row.transaction_hash,receipt:row.receipt,
    message:row.state==='complete'?'Your one-time 100 test CITY grant is confirmed. Return to the same material purchase.'
      :row.state==='reverted'?'The original onboarding grant reverted. Operator review is required; no replacement transfer was created.'
      :'One-time 100 test CITY grant pending. Reconcile this original grant; no replacement transfer is created.'})
  async function owner(principalId){
    if(!UUID.test(principalId||''))fail('INVENTORY_SHOP_FUNDING_OWNER_REQUIRED')
    const value=await resolveIdentity({principalId})
    if(value?.principalId!==principalId||typeof value.privySubject!=='string'||value.nativeApproved!==true||value.walletSignatureVerified!==true||lower(value.walletAddress)!==TEST_CITY_GRANT_RECIPIENT)fail('INVENTORY_SHOP_FUNDING_VERIFIED_WALLET_REQUIRED')
    return{principalId,subjectHash:digest(value.privySubject)}
  }
  async function preview({principalId}){
    const identity=await owner(principalId),termsDigest=digest({principalId,subjectHash:identity.subjectHash,operationId,...terms})
    await pool.query(`INSERT INTO ac_inventory_shop_city_grants(grant_id,operation_id,principal_id,subject_hash,recipient,source,city,terms_digest)
      VALUES(1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[operationId,principalId,identity.subjectHash,terms.recipient,source,terms.city,termsDigest])
    const row=(await pool.query('SELECT * FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0]
    if(row.principal_id!==principalId||row.subject_hash!==identity.subjectHash||row.recipient!==terms.recipient||row.source!==source||row.city!==terms.city||row.operation_id!==operationId||row.terms_digest!==termsDigest)fail('INVENTORY_SHOP_FUNDING_QUOTA_OR_BINDING_CONFLICT')
    return view(row)
  }
  async function confirm({principalId,termsDigest,confirmationId}){
    const current=await preview({principalId})
    if(current.termsDigest!==termsDigest||!UUID.test(confirmationId||''))fail('INVENTORY_SHOP_FUNDING_EXPLICIT_CONFIRMATION_REQUIRED')
    let row=(await pool.query('SELECT * FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0]
    if(['complete','reverted'].includes(row.state))return view(row)
    if(!row.consent){
      const accepted=await authorize({principalId,operationId,termsDigest,confirmationId,...terms})
      if(accepted?.authorized!==true||['principalId','operationId','termsDigest','confirmationId'].some(key=>accepted[key]!==({principalId,operationId,termsDigest,confirmationId})[key]))fail('INVENTORY_SHOP_FUNDING_EXPLICIT_CONFIRMATION_REQUIRED')
      await signer.preflight()
      await pool.query("UPDATE ac_inventory_shop_city_grants SET consent=$1,state='funding' WHERE grant_id=1 AND consent IS NULL",[json(accepted)])
      row=(await pool.query('SELECT * FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0]
    }
    const data=encodeFunctionData({abi,functionName:'transfer',args:[terms.recipient,TEST_CITY_GRANT_AMOUNT]})
    const prepared=await signer.prepare({operationId,to:terms.city,data,value:0n,
      limits:{maxGas:100000,maxNativeCostWei:manifest.maxNativeCostWei}})
    const hash=prepared.transactionHash||prepared.hash
    if(HASH.test(hash||'')){
      await pool.query('UPDATE ac_inventory_shop_city_grants SET transaction_hash=$1 WHERE grant_id=1 AND transaction_hash IS NULL',[hash.toLowerCase()])
      const saved=(await pool.query('SELECT transaction_hash FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0]
      if(saved.transaction_hash!==hash.toLowerCase())fail('INVENTORY_SHOP_FUNDING_ORIGINAL_TRANSACTION_REQUIRED')
    }
    await signer.broadcast({operationId})
    const result=await signer.reconcile({operationId})
    if(result.status==='reverted'||result.receipt?.status==='reverted')return view((await pool.query("UPDATE ac_inventory_shop_city_grants SET state='reverted' WHERE grant_id=1 RETURNING *")).rows[0])
    if(result.status!=='confirmed')return view((await pool.query('SELECT * FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0])
    const transactionHash=result.transactionHash||result.hash,receipt=result.receipt
    if(!HASH.test(transactionHash||'')||!receipt||receipt.status!=='success')fail('INVENTORY_SHOP_FUNDING_CANONICAL_RECEIPT_REQUIRED')
    const pinned=(await pool.query('SELECT transaction_hash FROM ac_inventory_shop_city_grants WHERE grant_id=1')).rows[0]
    if(pinned.transaction_hash!==transactionHash.toLowerCase())fail('INVENTORY_SHOP_FUNDING_ORIGINAL_TRANSACTION_REQUIRED')
    const [transaction,head,block]=await Promise.all([client.getTransaction({hash:transactionHash}),client.getBlockNumber({cacheTime:0}),client.getBlock({blockNumber:receipt.blockNumber})])
    if(lower(transaction.from)!==source||lower(transaction.to)!==terms.city||transaction.input.toLowerCase()!==data.toLowerCase()||BigInt(transaction.value)!==0n||
      head<BigInt(receipt.blockNumber)+1n||block.hash.toLowerCase()!==receipt.blockHash.toLowerCase())fail('INVENTORY_SHOP_FUNDING_CANONICAL_RECEIPT_REQUIRED')
    const transfers=parseEventLogs({abi,eventName:'Transfer',logs:receipt.logs,strict:true}).filter(log=>lower(log.address)===terms.city&&lower(log.args.from)===source&&lower(log.args.to)===terms.recipient&&log.args.value===TEST_CITY_GRANT_AMOUNT)
    if(transfers.length!==1)fail('INVENTORY_SHOP_FUNDING_EXACT_TRANSFER_REQUIRED')
    const proof={transactionHash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,confirmations:2,source,recipient:terms.recipient,city:terms.city,amountBaseUnits:terms.amountBaseUnits}
    row=(await pool.query("UPDATE ac_inventory_shop_city_grants SET state='complete',receipt=$1 WHERE grant_id=1 RETURNING *",[proof])).rows[0]
    return view(row)
  }
  return{preview,confirm}
}
