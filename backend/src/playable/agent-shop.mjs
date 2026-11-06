import {readFile,writeFile,rename} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {digest} from '../world-assets/canonical.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const slots={claude:'CityAgent5','0g':'CityAgent4'}
const fail=code=>{throw Object.assign(Error(code),{code})}
const json=async file=>JSON.parse(await readFile(file,'utf8'))

// Standing consent is local operator policy, never a model output or a native Pay event.
export async function createAgentShop({root,active,pool,identity,native,game,shop,getOperatorRuntime}){
  const policyFile=join(root,'.local/mumbai/agent-purchase-policy.json')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_agent_shop_intents(
    purchase_id uuid PRIMARY KEY,terms jsonb NOT NULL,quote_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION protect_agent_shop_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id OR NEW.terms IS DISTINCT FROM OLD.terms
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (OLD.quote_id IS NOT NULL AND NEW.quote_id IS DISTINCT FROM OLD.quote_id)
      THEN RAISE EXCEPTION 'AGENT_SHOP_IMMUTABLE_INTENT'; END IF; RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS protect_agent_shop_intent ON ac_agent_shop_intents;
    CREATE TRIGGER protect_agent_shop_intent BEFORE UPDATE ON ac_agent_shop_intents FOR EACH ROW EXECUTE FUNCTION protect_agent_shop_intent();`)
  async function context(input){
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['purchaseId','goalId','provider','playerId','connectionId','recipientId','item','count'].includes(k))||
      ['purchaseId','goalId','playerId','connectionId','recipientId'].some(k=>!UUID.test(input[k]||''))||!Object.hasOwn(slots,input.provider)||
      typeof input.item!=='string'||!Number.isSafeInteger(input.count)||input.count<1||input.count>32)fail('AGENT_SHOP_REQUEST_REQUIRED')
    const owner=await identity.getMinecraftOwner(active.serverId,input.playerId)
    const directory=join(active.runtime,'mumbai-'+input.provider),saved=await json(join(directory,'personal-agents.json'))
    const slot=saved.agents?.find(s=>s.name===slots[input.provider]&&s.ownerId===owner?.ownerId&&s.minecraftPlayerId===input.playerId)
    const job=(await json(join(directory,'survival-objectives.json'))).jobs?.find(j=>j.id===input.goalId)
    if(!slot||!job||job.ownerId!==owner.ownerId||job.playerId!==input.playerId||!['running','paused'].includes(job.status)||
      job.pendingEffect?.action!=='purchase'||job.pendingEffect.purchaseId!==input.purchaseId||job.pendingEffect.item!==input.item||job.pendingEffect.count!==input.count)fail('AGENT_SHOP_SAVED_OBJECTIVE_REQUIRED')
    const live=await native('session?playerId='+input.playerId),recipient=await native('session?playerId='+input.recipientId)
    if(live.online!==true||live.pendingAuthentication!==false||live.principalId!==owner.ownerId||live.connectionId!==input.connectionId||
      live.serverPosition?.world!=='agentcity_mumbai'||recipient.online!==true||recipient.playerName!==slot.name||recipient.serverPosition?.world!=='agentcity_mumbai')fail('AGENT_SHOP_APPROVED_OWNER_AND_AGENT_REQUIRED')
    return{owner,slot,job,recipient:{slotName:slot.name,playerId:input.recipientId,purchaseId:input.purchaseId,goalId:input.goalId}}
  }
  async function policy(owner,recipient){
    let value
    try{value=await json(policyFile)}catch(error){if(error.code==='ENOENT')fail('AGENT_SHOP_NOT_AUTHORIZED');throw error}
    const runtime=await getOperatorRuntime()
    if(value.schema!=='agentcity.agent-purchase-policy.v1'||!UUID.test(value.id||'')||value.enabled!==true||value.chainId!==1301||
      runtime.manifest.chainId!==1301||runtime.manifest.worldAssets?.chainId!==1301||value.serverId!==active.serverId||
      value.manifestDigest!==digest(runtime.manifest.worldAssets)||value.ownerId!==owner.ownerId||value.playerId!==owner.minecraftPlayerId||
      !value.slots?.includes(recipient.slotName)||value.cityLimit!==null||value.maxOrderCityBaseUnits!=='1000000000000000000'||value.maxOrderGasWei!=='90000000000000')fail('AGENT_SHOP_NOT_AUTHORIZED')
    return value
  }
  async function authorize({phase,input,row,owner}){
    const purchaseId=phase==='prepare'?input.purchaseId:row?.terms.agentRecipient?.purchaseId
    const intent=(await pool.query('SELECT * FROM ac_agent_shop_intents WHERE purchase_id=$1',[purchaseId])).rows[0]
    if(!intent||intent.quote_id!==(phase==='prepare'?input.quoteId:row.quote_id))fail('AGENT_SHOP_ORIGINAL_QUOTE_REQUIRED')
    const terms=intent.terms,{owner:actual,recipient}=await context({...terms.request,connectionId:input.connectionId||terms.request.connectionId})
    const current=await policy(actual,recipient)
    if(digest(current)!==digest(terms.policy)||owner&&owner.ownerId!==actual.ownerId)fail('AGENT_SHOP_POLICY_CHANGED')
    if(row&&(digest(row.terms.agentRecipient)!==digest(recipient)||row.wallet?.walletId!==current.wallet.walletId||
      row.wallet?.address?.toLowerCase()!==current.wallet.address.toLowerCase()||row.wallet?.providerAccountId!==current.wallet.providerAccountId||
      row.terms.manifestDigest!==current.manifestDigest||BigInt(row.terms.totalBaseUnits)>BigInt(current.maxOrderCityBaseUnits)||
      BigInt(row.terms.maxNativeFeeWei)>BigInt(current.maxOrderGasWei)))fail('AGENT_SHOP_WALLET_OR_LIMIT_CHANGED')
    return{recipient,policyId:current.id,policyDigest:digest(current),receiptId:purchaseId}
  }
  async function purchase(input){
    const {owner,recipient}=await context(input)
    const lock=await pool.connect()
    try{
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['agent-shop:'+owner.ownerId])
      let intent=(await pool.query('SELECT * FROM ac_agent_shop_intents WHERE purchase_id=$1',[input.purchaseId])).rows[0]
      if(intent){
        const a={...intent.terms.request},b={...input};delete a.connectionId;delete b.connectionId
        if(digest(a)!==digest(b))fail('AGENT_SHOP_IMMUTABLE_REQUEST')
      }else{
        const allowed=await policy(owner,recipient)
        // An unfinished paid order must be reconciled before this wallet starts another agent purchase.
        if((await pool.query(`SELECT 1 FROM ac_inventory_shop_game_orders WHERE principal_id=$1 AND terms ? 'agentRecipient'
          AND consent IS NOT NULL AND state->>'delivered' IS DISTINCT FROM 'true' LIMIT 1`,[owner.ownerId])).rows.length)fail('AGENT_SHOP_PREVIOUS_ORDER_PENDING')
        await pool.query('INSERT INTO ac_agent_shop_intents(purchase_id,terms) VALUES($1,$2)',[input.purchaseId,{request:input,policy:allowed}])
        intent=(await pool.query('SELECT * FROM ac_agent_shop_intents WHERE purchase_id=$1',[input.purchaseId])).rows[0]
      }
      if(!intent.quote_id){
        await policy(owner,recipient)
        const quote=await shop.quote({playerId:input.playerId,connectionId:input.connectionId,item:input.item,count:input.count})
        await pool.query('UPDATE ac_agent_shop_intents SET quote_id=$2 WHERE purchase_id=$1 AND quote_id IS NULL',[input.purchaseId,quote.quoteId]);intent.quote_id=quote.quoteId
      }
      let row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE quote_id=$1',[intent.quote_id])).rows[0]
      if(!row){
        const quote=(await pool.query('SELECT * FROM ac_inventory_shop_quotes WHERE quote_id=$1',[intent.quote_id])).rows[0]
        await game.openDelegated({purchaseId:input.purchaseId,quoteId:quote.quote_id,principalId:owner.ownerId,playerId:input.playerId,
          connectionId:input.connectionId,item:quote.item,count:quote.count,totalBaseUnits:quote.total_price,stock:quote.stock,expiresAtMs:+new Date(quote.expires_at)})
        row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE quote_id=$1',[intent.quote_id])).rows[0]
      }
      const request={playerId:input.playerId,connectionId:input.connectionId,orderId:row.order_id}
      // Revocation stops new consent, while an already funded claim remains recoverable.
      const result=await (row.consent?game.status(request):game.confirmDelegated(request))
      return{purchaseId:input.purchaseId,orderId:row.order_id,status:result.status,paid:result.paid,delivered:result.deliveryConfirmed===true,
        item:result.item,count:result.count,totalCity:result.totalCity,message:result.message}
    }catch(error){
      if(/NOT_AUTHORIZED|POLICY_CHANGED|INSUFFICIENT_FUNDS|INSUFFICIENT_STOCK|ITEM_QUANTITY_REQUIRED|FRESH_QUOTE_REQUIRED|WALLET_OR_LIMIT_CHANGED|PREVIOUS_ORDER_PENDING/.test(error.code||error.message||'')){
        const row=(await pool.query(`SELECT o.consent FROM ac_agent_shop_intents i JOIN ac_inventory_shop_game_orders o USING(quote_id) WHERE i.purchase_id=$1`,[input.purchaseId])).rows[0]
        if(!row?.consent)return{purchaseId:input.purchaseId,item:input.item,count:input.count,status:'blocked',paid:false,delivered:false,message:error.code||error.message}
      }
      throw error
    }finally{try{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['agent-shop:'+owner.ownerId])}finally{lock.release()}}
  }
  async function revoke(input){
    if(!input||Object.keys(input).some(k=>!['playerId','connectionId'].includes(k))||!UUID.test(input.playerId||'')||!UUID.test(input.connectionId||''))fail('AGENT_SHOP_REQUEST_REQUIRED')
    const owner=await identity.getMinecraftOwner(active.serverId,input.playerId),live=await native('session?playerId='+input.playerId)
    if(live.online!==true||live.pendingAuthentication!==false||live.principalId!==owner?.ownerId||live.connectionId!==input.connectionId)fail('AGENT_SHOP_APPROVED_OWNER_AND_AGENT_REQUIRED')
    const lock=await pool.connect()
    try{
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['agent-shop:'+owner.ownerId])
      const current=await json(policyFile)
      if(current.ownerId!==owner.ownerId||current.playerId!==input.playerId)fail('AGENT_SHOP_NOT_AUTHORIZED')
      current.enabled=false;current.revokedAt=new Date().toISOString()
      const temporary=policyFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(current,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,policyFile)
      return{enabled:false,message:'Automatic purchases disabled for both agents. Existing paid orders remain recoverable.'}
    }finally{try{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['agent-shop:'+owner.ownerId])}finally{lock.release()}}
  }
  return{authorize,purchase,revoke}
}
