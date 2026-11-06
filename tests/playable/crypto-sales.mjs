import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { createCryptoItemSales } from '../../backend/src/playable/crypto-sales.mjs'

const settings=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='crypto_sales_fixture_'+randomUUID().replaceAll('-','')
const admin=new pg.Pool({connectionString:settings.databaseUrl,max:1})
const pool=new pg.Pool({connectionString:settings.databaseUrl,options:'-c search_path='+schema,max:4})
const unit=10n**18n, playerId=randomUUID(), otherId=randomUUID()
const token='0x'+'11'.repeat(20),treasury='0x'+'22'.repeat(20),recipient='0x'+'33'.repeat(20)
let balance=1000n*unit,gasReady=true,inventory=20,removals=0,transfers=0,loseReply=false,pausePayout=false
const inventoryReceipts=new Map(),chainReceipts=new Map(),checks=[]
const report={status:'fail',scope:'Real isolated PostgreSQL, explicit inventory and chain fixtures. No actual Minecraft or public-chain payment proof.',checks}
const check=name=>{checks.push({name,status:'pass'});console.log('PASS '+name)}
const event=(id=playerId)=>({playerId:id,operationId:randomUUID(),createdAtMs:Date.now()})
const subject=count=>({item:'cobblestone',count})
try {
  await admin.query('CREATE SCHEMA '+schema)
  const service=await createCryptoItemSales({pool,
    treasuryStatus:async()=>({chainId:31337,decimals:18,token,address:treasury,manifestId:'explicit-local-fixture',balance:balance.toString(),gasReady}),
    recipient:async()=>recipient,
    removeInventory:async request=>{
      if(inventoryReceipts.has(request.operationId))return inventoryReceipts.get(request.operationId)
      const removed=inventory>=request.count
      if(removed){inventory-=request.count;removals++}
      const receipt={...request,removed};inventoryReceipts.set(request.operationId,receipt);return receipt
    },
    payout:async request=>{
      if(chainReceipts.has(request.operationId))return chainReceipts.get(request.operationId)
      if(pausePayout)return{status:'pending'}
      assert.ok(balance>=BigInt(request.amount));balance-=BigInt(request.amount);transfers++
      const receipt={status:'confirmed',chainId:31337,token,from:treasury,to:recipient,amount:request.amount,transactionHash:'0x'+transfers.toString(16).padStart(64,'0')}
      chainReceipts.set(request.operationId,receipt)
      if(loseReply){loseReply=false;throw Error('fixture_lost_chain_reply_after_transfer')}
      return receipt
    }})
  const first=event(),before=balance
  assert.match(await service.sell(first,subject(2)),/Sold 2 cobblestone for 2 test CITY/)
  assert.equal(balance,before-2n*unit);assert.equal(inventory,18)
  assert.match(await service.sell(first,subject(2)),/already paid/)
  assert.equal(removals,1);assert.equal(transfers,1)
  await assert.rejects(service.sell(first,subject(3)),/sale_terms_changed/)
  check('exact inventory and finite token debit; original operation replay has zero extra effects')
  const paid=(await pool.query("SELECT sale_id FROM ac_crypto_item_sales WHERE state='paid'")).rows[0].sale_id
  await assert.rejects(service.retry({saleId:paid,playerId:otherId}),/does not belong/)
  await assert.rejects(service.sell({...first,playerId:otherId},subject(2)),/sale_terms_changed/)
  assert.equal(transfers,1)
  check('owner and immutable item/count bindings reject a different player or changed sale')
  const stockBefore=inventory,chainBefore=balance,transfersBefore=transfers
  assert.match(await service.sell(event(),subject(stockBefore+1)),/cancelled/)
  assert.equal(inventory,stockBefore);assert.equal(balance,chainBefore);assert.equal(transfers,transfersBefore)
  assert.equal((await pool.query("SELECT count(*)::int n FROM ac_crypto_item_sales WHERE state IN ('reserved','removed')")).rows[0].n,0)
  gasReady=false;await assert.rejects(service.sell(event(),subject(1)),/not ready/);gasReady=true
  balance=0n;await assert.rejects(service.sell(event(),subject(1)),/insufficient/);balance=chainBefore
  assert.equal(inventory,stockBefore)
  check('insufficient items cancel and release holds; missing gas/funds fail before item removal')
  loseReply=true;const lost=event(),oldInventory=inventory,oldTransfers=transfers,oldRemovals=removals
  const pending=await service.sell(lost,subject(3));assert.match(pending,/needs reconciliation/)
  const id=pending.match(/Sale ([a-f0-9-]{36})/)[1]
  assert.equal(inventory,oldInventory-3);assert.equal(transfers,oldTransfers+1)
  assert.match(await service.retry({saleId:id,playerId}),/Sold 3/)
  assert.equal(transfers,oldTransfers+1);assert.equal(removals,oldRemovals+1)
  check('lost payout reply reconciles the original transfer without another removal or payment')
  pausePayout=true;balance=2n*unit
  assert.match(await service.sell(event(),subject(1)),/pending/)
  const inventoryAfterReservation=inventory
  await assert.rejects(service.sell(event(otherId),subject(2)),/insufficient/)
  assert.equal(inventory,inventoryAfterReservation)
  assert.equal((await pool.query("SELECT SUM(reward)::text amount FROM ac_crypto_item_sales WHERE state IN ('reserved','removed')")).rows[0].amount,unit.toString())
  check('unconfirmed payouts retain finite treasury reservations and prevent oversubscribed item removal')
  report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{
  await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end()
  const target=new URL('../../evidence/runs/playable-crypto-sales/'+randomUUID()+'/report.json',import.meta.url)
  await mkdir(new URL('./',target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({status:report.status,checks:checks.length,report:target.pathname,error:report.error}))
}
