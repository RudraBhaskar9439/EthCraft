// Actual isolated Paper/Mineflayer menus with explicit fixture replies. No Privy signatures, API requests or payments.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {inventoryShopEvent} from '../../backend/src/playable/inventory-shop-runtime.mjs'
const require=createRequire(new URL('../compatibility/package.json',import.meta.url)),mineflayer=require('mineflayer')
const meta=JSON.parse(await readFile(new URL('../../.local/investments/native.json',import.meta.url),'utf8'))
assert.equal(meta.owner,'ethcraft-investment-native-fixture');assert.equal(meta.gamePort,25986);assert.equal(meta.controlPort,25987)
const token=(await readFile(meta.runtime+'/api-token','utf8')).trim()
const report={status:'fail',scope:'Actual isolated native GUI with synthetic backend replies. No live wallet/payment, independent user or chain lifecycle qualification.',checks:[],publicTransactions:0,walletSignatures:0}
const check=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
async function native(path,body){const r=await fetch('http://127.0.0.1:25987/playable/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json()}
async function poll(read,accept,label){const until=Date.now()+30000;while(Date.now()<until){const result=await read();if(accept(result))return result;await delay(200)}throw Error('GUI_TIMEOUT_'+label)}
let bot
async function window(title,action){const event=once(bot,'windowOpen');await action();let timer;const [w]=await Promise.race([event,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('GUI_WINDOW_'+title)),15000)})]).finally(()=>clearTimeout(timer));assert(JSON.stringify(w.title).includes(title),JSON.stringify(w.title));await delay(300);return w}
async function wire(action){const event=await poll(async()=>(await native('events')).events.find(e=>e.playerId===bot._client.uuid&&e.action==='inventory_shop'&&e.args[0]===action),Boolean,action);const parsed=inventoryShopEvent(event);assert.equal(parsed.action,action);return{event,parsed}}
async function reply(event,value,title){return window(title,()=>native('inventory-shop/reply',{operationId:event.operationId,result:value}))}
try{
  await poll(()=>native('status').catch(()=>({})),s=>s.available&&s.mumbai?.ready,'SERVER')
  const name='Invest'+randomUUID().slice(0,7),principalId=randomUUID()
  bot=mineflayer.createBot({host:'127.0.0.1',port:25986,username:name,auth:'offline',version:'1.21.11',hideErrors:true,checkTimeoutInterval:90000})
  bot.on('error',()=>{});bot.on('physicsTick',()=>{if(bot._client.state==='play')bot._client.write('tick_end',{})})
  await once(bot,'spawn')
  const session=()=>native('session?playerId='+bot._client.uuid)
  await poll(session,s=>s.online&&s.pendingAuthentication,'SESSION')
  bot.chat('/invest');await delay(800)
  assert.equal((await native('events')).events.filter(e=>e.playerId===bot._client.uuid&&e.action==='inventory_shop').length,0)
  await native('discord/reserve',{playerName:name,principalId,discordId:'790000000000000001',accountKind:'local',expiresAtMs:Date.now()+3600000})
  const pending=await session();await native('discord/approve',{playerId:bot._client.uuid,connectionId:pending.connectionId,principalId})
  await poll(session,s=>s.pendingAuthentication===false,'APPROVED')
  check('investment actions are unavailable before native Discord approval')
  await window('Checking Investment',()=>bot.chat('/invest'))
  let {event}=await wire('invest_portfolio')
  await delay(31000)
  await reply(event,{mode:'investment',chainId:1301,walletAddress:'0x'+'7'.repeat(40),positions:[],operations:[]},'Optional Investments')
  check('a real GUI reply after thirty seconds is still delivered to its original request')
  await window('Choose LP Deposit',()=>bot.clickWindow(12,0,0))
  await window('Checking Investment',()=>bot.clickWindow(20,0,0))
  let {event:preview,parsed}=await wire('invest_preview')
  assert.equal(parsed.input.action,'deposit');assert.equal(parsed.input.city,'0.01');assert.equal(parsed.input.usdc,'0.01')
  assert.equal((await native('events')).events.filter(e=>e.playerId===bot._client.uuid&&e.args[0]==='invest_confirm').length,0)
  const id=randomUUID(),value={mode:'investment',chainId:1301,operationId:id,action:'deposit',status:'preview',walletAddress:'0x'+'7'.repeat(40),consentNonce:'a'.repeat(43),lines:Array.from({length:17},(_,i)=>'Fixture detail '+i),confirmed:false,realTransaction:false}
  await reply(preview,value,'Investment Review')
  assert(!JSON.stringify(bot.currentWindow.slots[49]).includes('Confirm This Investment'))
  await window('Investment Review',()=>bot.clickWindow(43,0,0));await window('Investment Review',()=>bot.clickWindow(43,0,0))
  assert(JSON.stringify(bot.currentWindow.slots[49]).includes('Confirm This Investment'))
  check('deposit stays optional; all review pages precede the separate confirmation button')
  await window('Checking Investment',()=>bot.clickWindow(49,0,0))
  let confirmed=await wire('invest_confirm')
  assert.equal(confirmed.parsed.input.operationId,id);assert.equal(confirmed.parsed.input.consentNonce,value.consentNonce);assert.equal(confirmed.parsed.input.confirmationId,confirmed.event.operationId)
  await reply(confirmed.event,{...value,status:'pending',confirmed:true},'Investment Review')
  let status=await wire('invest_status');assert.equal(status.parsed.input.operationId,id)
  const refreshed={...value,operationId:randomUUID(),consentNonce:'b'.repeat(43),lines:['Quote refreshed; review and confirm again',...value.lines]}
  await reply(status.event,refreshed,'Investment Review')
  assert(!JSON.stringify(bot.currentWindow.slots[49]).includes('Confirm This Investment'))
  await window('Investment Review',()=>bot.clickWindow(43,0,0));await window('Investment Review',()=>bot.clickWindow(43,0,0))
  await window('Checking Investment',()=>bot.clickWindow(49,0,0))
  const renewed=await wire('invest_confirm')
  assert.equal(renewed.parsed.input.operationId,refreshed.operationId);assert.equal(renewed.parsed.input.consentNonce,refreshed.consentNonce)
  await reply(renewed.event,{...refreshed,status:'pending',confirmed:true},'Investment Review')
  status=await wire('invest_status');assert.equal(status.parsed.input.operationId,refreshed.operationId)
  await reply(status.event,{...refreshed,status:'complete',confirmed:true},'Investment Review')
  assert(JSON.stringify(bot.currentWindow.slots[49]).includes('Transaction Confirmed'))
  await delay(2500)
  assert.equal((await native('events')).events.filter(e=>e.playerId===bot._client.uuid&&e.args[0]==='invest_status').length,0)
  check('pending transactions check automatically; refreshed terms require a new review and nonce; completion stops polling')
  bot.closeWindow(bot.currentWindow);await delay(300)
  await window('Checking Investment',()=>bot.chat('/invest'))
  const blocked=await wire('invest_portfolio')
  await reply(blocked.event,{error:'INVEST_INSUFFICIENT_TEST_TOKENS'},'Investment Unavailable')
  assert(JSON.stringify(bot.currentWindow.slots[22]).includes('INVEST_INSUFFICIENT_TEST_TOKENS'))
  check('native consent binds the exact operation; recovery uses status and shows specific blockers')
  bot.closeWindow(bot.currentWindow);await delay(300)
  await window('Checking Investment',()=>bot.chat('/invest deposit 0.01 0.01'))
  const unfunded=await wire('invest_preview')
  await reply(unfunded.event,{...value,operationId:randomUUID(),canConfirm:false,blocker:'Needs test tUSDC and gas reserve'},'Investment Review')
  assert(JSON.stringify(bot.currentWindow.slots[49]).includes('Test Funds Needed'))
  check('an unfunded review remains readable and has no confirmation button')
  bot.closeWindow(bot.currentWindow);await delay(300)
  await window('Loading Materials',()=>bot.chat('/market'))
  let shop=await wire('catalog');await reply(shop.event,{entries:[{item:'oak_planks',available:10,unitPriceCity:'0.01'}]},'Choose Item')
  check('existing marketplace menu remains available alongside investments')
  report.status='pass'
}finally{
  bot?.quit();await delay(400)
  const directory=new URL('../../evidence/runs/investments/'+randomUUID()+'/',import.meta.url);await mkdir(directory,{recursive:true});await writeFile(new URL('native.json',directory),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:directory.pathname}))
}
