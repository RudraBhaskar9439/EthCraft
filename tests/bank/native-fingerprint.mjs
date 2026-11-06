import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createLaptopNativeActors } from './native-laptop.mjs'

const root=resolve(new URL('../..',import.meta.url).pathname)
const directory=join(root,'evidence/runs/native-fingerprint',randomUUID())
await mkdir(directory,{recursive:true})
const report={status:'fail',recordedAt:new Date().toISOString(),scope:'Actual owned laptop Paper item canonical fingerprint, mutation refusal and player save/reload. Controlled fixture identities; no chain transaction or human qualification.',checks:[],publicTransactions:0,paidModelCalls:0}
let context
async function preview(actor){return context.native('escrow/preview',{operationId:randomUUID(),sellerId:actor.principalId,sellerAccountId:actor.minecraftPlayerId,ownerPlayerId:actor.minecraftPlayerId,sourceId:actor.minecraftPlayerId,sourceKind:'player_inventory',connectionId:actor.connectionId,selection:'main_hand',count:1})}
async function poll(read,accept,label){const end=Date.now()+10000;do{const value=await read();if(accept(value))return value;await delay(150)}while(Date.now()<end);throw Error('NATIVE_FINGERPRINT_TIMEOUT_'+label)}
try{
 context=await createLaptopNativeActors()
 const actor=context.actors.find(value=>value.name==='BankBorrower')
 const initial=await preview(actor)
 assert.equal(initial.fingerprintAlgorithm,'canonical_nbt_v1')
 for(const operation of ['damage','enchant','pdc']){
  const original=await preview(actor),stock={operationId:randomUUID(),listingId:randomUUID(),sellerId:actor.principalId,sellerAccountId:actor.minecraftPlayerId,sourceId:actor.minecraftPlayerId,sourceKind:'player_inventory',item:original.item,count:1,termsDigest:createHash('sha256').update(JSON.stringify(original)).digest('hex'),authorityId:randomUUID(),custodyMode:'world_asset',previewId:original.previewId,expectedFingerprint:original.fingerprint}
  await context.native('escrow/authorize',{...stock,ownerPlayerId:actor.minecraftPlayerId,connectionId:actor.connectionId,consentId:randomUUID(),confirmed:true,expiresAtMs:Date.now()+120000})
  actor.bot.chat('/bankfixture '+operation)
  const changed=await poll(()=>preview(actor),value=>value.fingerprint!==original.fingerprint,operation)
  if(operation==='damage')assert.equal(changed.descriptor.damage,8)
  if(operation==='enchant')assert.equal(changed.descriptor.enchantments['minecraft:sharpness'],3)
  if(operation==='pdc')assert.deepEqual(changed.descriptor,original.descriptor)
  await assert.rejects(context.native('escrow/reserve',stock),/escrow_selected_item_changed/)
  assert.equal((await context.native('escrow/status',{})).custodyCount,0)
  actor.bot.chat('/bankfixture reset')
  await poll(()=>preview(actor),value=>value.fingerprint===original.fingerprint,'RESET_'+operation)
  report.checks.push(operation+' change refused before custody effect; exact metadata restored')
 }
 const before=await preview(actor),beforeActors=context.actors.map(({bot,...value})=>value)
 await context.close();context=null
 await delay(500)
 context=await createLaptopNativeActors()
 const restored=context.actors.find(value=>value.name==='BankBorrower'),after=await preview(restored)
 assert.equal(after.fingerprint,before.fingerprint)
 assert.deepEqual(after.descriptor,before.descriptor)
 for(const old of beforeActors){const current=context.actors.find(value=>value.name===old.name);assert.equal(current.minecraftPlayerId,old.minecraftPlayerId);assert.notEqual(current.connectionId,old.connectionId)}
 assert.equal(restored.bot.inventory.items().filter(value=>value.name==='diamond_sword').reduce((n,value)=>n+value.count,0),1)
 report.checks.push('canonical fingerprint and full descriptor stable across actual player save/reload; no extra item grant')
 report.before={fingerprint:before.fingerprint,fingerprintAlgorithm:before.fingerprintAlgorithm,descriptor:before.descriptor}
 report.after={fingerprint:after.fingerprint,fingerprintAlgorithm:after.fingerprintAlgorithm,descriptor:after.descriptor}
 report.serverId=context.active.serverId;report.container=context.active.container
 report.sources=Object.fromEntries(await Promise.all(['plugin/src/main/java/org/agentcity/paper/CanonicalItemFingerprint.java','plugin/src/main/java/org/agentcity/paper/InventoryEscrow.java','tests/bank/native-fingerprint.mjs','tests/bank/LaptopBankStock.java'].map(async file=>[file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')])))
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await context?.close();await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
