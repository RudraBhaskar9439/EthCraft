import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const json=async file=>JSON.parse(await readFile(file,'utf8'))
const id=value=>{const h=createHash('sha256').update(value).digest('hex');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-')}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(read,accept){for(let attempt=0;attempt<150;attempt++){const value=await read();if(accept(value))return value;await pause(200)}throw Error('MUMBAI_MERCHANT_NATIVE_TIMEOUT')}

/** Explicit controlled fixture only; no models, transactions or other actors. */
export async function connectMumbaiMerchant({rootDirectory=root,bootstrap=false}={}){
  const active=await json(join(rootDirectory,'.local/playable-world/active.json'))
  assert.equal(active.owner,'agentcity-playable-pilot');assert.match(active.container,/^agentcity-playable-[a-f0-9]{8}$/)
  assert.equal(resolve(active.runtime),join(resolve(rootDirectory),'.local/playable-world',active.container))
  const roster=await json(join(rootDirectory,'.local/playable-world/bank-actors.json'))
  const settings=await json(join(rootDirectory,'.local/bank/operator-settings.json'))
  const actor=roster.actors?.seller,operator=settings.actors?.seller
  assert.equal(roster.schema,'agentcity.laptop-bank-actors.v1');assert.equal(roster.fixture,true);assert.equal(roster.serverId,active.serverId)
  assert.equal(settings.schema,'agentcity.bank-operator.v1');assert.equal(settings.chainId,1301);assert.equal(settings.operatorControlled,true)
  assert.equal(actor?.name,'BankSeller');assert.equal(operator?.minecraftUsername,actor.name);assert.equal(operator.operatorControlled,true)
  assert.equal(operator.principalId,actor.principalId);assert.equal(operator.minecraftPlayerId,actor.minecraftPlayerId)
  const token=(await readFile(join(active.runtime,'api-token'),'utf8')).trim()
  const native=async(path,body)=>{
    const response=await fetch('http://127.0.0.1:25597/playable/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(15000)})
    const value=await response.json();if(!response.ok)throw Error('MUMBAI_MERCHANT_NATIVE_REFUSED');return value
  }
  const release=await checkpoints.acquireLocalLease('agentcity-mumbai-merchant:'+active.serverId)
  let bot
  try{
    const previous=await native('session?playerId='+actor.minecraftPlayerId)
    if(previous.online)throw Error('MUMBAI_MERCHANT_ALREADY_CONNECTED')
    // Extend the original fixture registration only; never replace its principal.
    let expiresAtMs=Date.now()+86400000
    try{
      const saved=await json(join(active.runtime,'plugins/AgentCity/discord-game-access.json'))
      assert.equal(saved.schema,'agentcity.discord-game-access.v1')
      const prior=saved.reservations?.[actor.name.toLowerCase()]
      if(prior){
        assert.equal(prior.playerName,actor.name);assert.equal(prior.principalId,actor.principalId)
        assert.equal(prior.discordId,actor.discordId);assert.equal(prior.accountKind,'local')
        assert(Number.isSafeInteger(prior.expiresAtMs));expiresAtMs=Math.max(expiresAtMs,prior.expiresAtMs)
      }
    }catch(error){if(error.code!=='ENOENT')throw error}
    await native('discord/reserve',{playerName:actor.name,principalId:actor.principalId,discordId:actor.discordId,
      accountKind:'local',expiresAtMs})
    const mineflayer=createRequire(new URL('../tests/compatibility/package.json',import.meta.url))('mineflayer')
    bot=mineflayer.createBot({host:'127.0.0.1',port:25596,username:actor.name,auth:'offline',version:'1.21.11',hideErrors:true,checkTimeoutInterval:120000})
    bot.on('error',()=>{})
    bot.on('physicsTick',()=>{if(bot._client.state==='play')bot._client.write('tick_end',{})})
    let timeout
    try{await Promise.race([once(bot,'spawn'),once(bot,'kicked').then(()=>{throw Error('MUMBAI_MERCHANT_JOIN_REFUSED')}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('MUMBAI_MERCHANT_JOIN_TIMEOUT')),45000)})])}finally{clearTimeout(timeout)}
    assert.equal(bot._client.uuid,actor.minecraftPlayerId)
    const current=await wait(()=>native('session?playerId='+actor.minecraftPlayerId),session=>session.online&&session.connectionId)
    await native('discord/approve',{playerId:actor.minecraftPlayerId,connectionId:current.connectionId,principalId:actor.principalId})
    const approved=await wait(()=>native('session?playerId='+actor.minecraftPlayerId),session=>session.pendingAuthentication===false&&session.principalId===actor.principalId)
    const request={sellerId:actor.principalId,sellerAccountId:actor.minecraftPlayerId,ownerPlayerId:actor.minecraftPlayerId,
      sourceId:actor.minecraftPlayerId,connectionId:approved.connectionId,...bootstrap?{bootstrap:true,operationId:id(active.serverId+':unirock-merchant-bootstrap:v1')}:{}}
    const stock=await native('escrow/shop-stock',request)
    if(stock.sourceId!==actor.minecraftPlayerId||stock.provenance!=='operator_supplied_demo')throw Error('MUMBAI_MERCHANT_STOCK_BINDING_REQUIRED')
    return{bot,stock,async close(){bot.quit();await pause(300);await release();}}
  }catch(error){bot?.quit();await release();throw error}
}

async function main(){
  if(!process.argv.slice(2).includes('--run')||process.argv.slice(2).some(arg=>!['--run','--bootstrap'].includes(arg))){console.log('Usage: node scripts/mumbai_merchant.mjs --run [--bootstrap]');return}
  const context=await connectMumbaiMerchant({bootstrap:process.argv.includes('--bootstrap')})
  console.log('UniRock controlled merchant connected. Actual finite demo stock observed; no models or chain transactions started.')
  await Promise.race([new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve)}),once(context.bot,'end')])
  await context.close()
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))main().catch(error=>{console.error(/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'MUMBAI_MERCHANT_STARTUP_FAILED');process.exitCode=1})
