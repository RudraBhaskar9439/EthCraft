// Isolated PostgreSQL/filesystem fixtures. No real wallet, chain, models or Minecraft effects.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import pg from '../../backend/node_modules/pg/lib/index.js'
import {createAgentShop} from '../../backend/src/playable/agent-shop.mjs'
import {digest} from '../../backend/src/world-assets/canonical.mjs'

const environment=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const root=await mkdtemp(join(tmpdir(),'agent-shop-')),schema='test_agent_shop_'+randomUUID().replaceAll('-','')
const admin=new pg.Pool({connectionString:environment.databaseUrl,max:1}),pool=new pg.Pool({connectionString:environment.databaseUrl,max:5,options:'-c search_path='+schema})
const owner={ownerId:randomUUID(),minecraftPlayerId:randomUUID()},connectionId=randomUUID(),recipientId=randomUUID(),goalId=randomUUID(),purchaseId=randomUUID()
const active={serverId:'fixture',runtime:join(root,'runtime')},directory=join(active.runtime,'mumbai-claude'),policyFile=join(root,'.local/mumbai/agent-purchase-policy.json')
const worldAssets={chainId:1301,city:'0x'+'1'.repeat(40)},wallet={walletId:'fixture-wallet',address:'0x'+'2'.repeat(40),providerAccountId:'fixture-privy'}
let policy={schema:'agentcity.agent-purchase-policy.v1',id:randomUUID(),enabled:true,chainId:1301,serverId:active.serverId,
  manifestDigest:digest(worldAssets),ownerId:owner.ownerId,playerId:owner.minecraftPlayerId,slots:['CityAgent5'],cityLimit:null,
  maxOrderCityBaseUnits:'1000000000000000000',maxOrderGasWei:'90000000000000',wallet}
const request={purchaseId,goalId,provider:'claude',playerId:owner.minecraftPlayerId,connectionId,recipientId,item:'oak_planks',count:4}
let pending={action:'purchase',purchaseId,item:'oak_planks',count:4},online=true,quotes=0,payments=0,claims=0,ready=false,service
async function save(){
  await writeFile(policyFile,JSON.stringify(policy),{mode:0o600})
  await writeFile(join(directory,'survival-objectives.json'),JSON.stringify({jobs:[{id:goalId,ownerId:owner.ownerId,playerId:owner.minecraftPlayerId,status:'running',pendingEffect:pending}]}))
}
try{
  await admin.query('CREATE SCHEMA '+schema)
  await pool.query(`CREATE TABLE ac_inventory_shop_quotes(quote_id uuid PRIMARY KEY,item text,count integer,total_price text,stock jsonb,expires_at timestamptz);
    CREATE TABLE ac_inventory_shop_game_orders(order_id uuid PRIMARY KEY,quote_id uuid UNIQUE,principal_id uuid,terms jsonb,wallet jsonb,consent jsonb,state jsonb DEFAULT '{}');`)
  await mkdir(directory,{recursive:true});await mkdir(join(root,'.local/mumbai'),{recursive:true})
  await writeFile(join(directory,'personal-agents.json'),JSON.stringify({agents:[{name:'CityAgent5',ownerId:owner.ownerId,minecraftPlayerId:owner.minecraftPlayerId}]}));await save()
  const game={
    openDelegated:async input=>{
      const authority=await service.authorize({phase:'prepare',input})
      await pool.query(`INSERT INTO ac_inventory_shop_game_orders(order_id,quote_id,principal_id,terms,wallet) VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(),input.quoteId,owner.ownerId,{agentRecipient:authority.recipient,totalBaseUnits:'40000000000000000',maxNativeFeeWei:'90000000000000',manifestDigest:digest(worldAssets)},wallet])
    },
    confirmDelegated:async input=>{
      const row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[input.orderId])).rows[0]
      await service.authorize({phase:'authorize',input,row,owner})
      payments++;await pool.query('UPDATE ac_inventory_shop_game_orders SET consent=$2 WHERE order_id=$1',[row.order_id,{fixture:true}])
      return{item:'oak_planks',count:4,totalCity:'0.04',status:'pending',paid:true,deliveryConfirmed:false}
    },
    status:async input=>{
      const row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[input.orderId])).rows[0]
      if(ready&&!row.state.delivered){claims++;await pool.query(`UPDATE ac_inventory_shop_game_orders SET state='{"delivered":true}' WHERE order_id=$1`,[row.order_id])}
      return{item:'oak_planks',count:4,totalCity:'0.04',status:ready?'delivered':'pending',paid:true,deliveryConfirmed:ready}
    }
  }
  service=await createAgentShop({root,active,pool,identity:{getMinecraftOwner:async()=>owner},game,
    native:async path=>path.endsWith(recipientId)?{online,playerName:'CityAgent5',serverPosition:{world:'agentcity_mumbai'}}:
      {online,pendingAuthentication:false,principalId:owner.ownerId,connectionId,serverPosition:{world:'agentcity_mumbai'}},
    getOperatorRuntime:async()=>({manifest:{chainId:1301,worldAssets}}),shop:{quote:async input=>{
      quotes++;assert.equal(input.item,'oak_planks');const quoteId=randomUUID()
      await pool.query('INSERT INTO ac_inventory_shop_quotes VALUES($1,$2,$3,$4,$5,now()+interval \'10 minutes\')',[quoteId,input.item,input.count,'40000000000000000',{}]);return{quoteId}
    }}})
  await assert.rejects(service.purchase({...request,wallet:'other'}),/REQUEST_REQUIRED/)
  online=false;await assert.rejects(service.purchase(request),/APPROVED_OWNER_AND_AGENT_REQUIRED/);online=true
  pending=null;await save();await assert.rejects(service.purchase(request),/SAVED_OBJECTIVE_REQUIRED/);pending={action:'purchase',purchaseId,item:'oak_planks',count:4};await save()
  policy.chainId=1;await save();assert.equal((await service.purchase(request)).status,'blocked');assert.equal(quotes,0)
  policy.chainId=1301;policy.enabled=false;await save();assert.equal((await service.purchase(request)).status,'blocked');assert.equal(payments,0)
  policy.enabled=true;await save()
  assert.equal((await service.purchase(request)).delivered,false)
  assert.equal((await service.purchase(request)).delivered,false)
  assert.equal(quotes,1);assert.equal(payments,1);assert.equal(claims,0)
  const order=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders')).rows[0]
  const authorization={phase:'authorize',input:{...request,orderId:order.order_id},row:order,owner}
  await assert.rejects(service.authorize({...authorization,row:{...order,wallet:{...wallet,address:'0x'+'9'.repeat(40)}}}),/WALLET_OR_LIMIT_CHANGED/)
  await assert.rejects(service.authorize({...authorization,row:{...order,terms:{...order.terms,maxNativeFeeWei:'90000000000001'}}}),/WALLET_OR_LIMIT_CHANGED/)
  await assert.rejects(service.authorize({...authorization,row:{...order,terms:{...order.terms,agentRecipient:{...order.terms.agentRecipient,playerId:randomUUID()}}}}),/WALLET_OR_LIMIT_CHANGED/)
  await assert.rejects(pool.query('UPDATE ac_agent_shop_intents SET terms=$2 WHERE purchase_id=$1',[purchaseId,{}]),/IMMUTABLE_INTENT/)
  // Revocation serializes against payment and leaves the original paid order recoverable.
  await service.revoke({playerId:request.playerId,connectionId})
  assert.equal(JSON.parse(await readFile(policyFile,'utf8')).enabled,false)
  ready=true
  assert.equal((await service.purchase(request)).delivered,true);await service.purchase(request)
  assert.equal(quotes,1);assert.equal(payments,1);assert.equal(claims,1)
  console.log('PASS approved objective, owned recipient, chain/policy/wallet limits, durable immutable request, same-order retry and revoked paid-order recovery; fixture only')
}finally{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(root,{recursive:true,force:true})}
