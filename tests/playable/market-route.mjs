import assert from 'node:assert/strict'
import {createPlayableMarketRuntime} from '../../backend/src/playable/market-runtime.mjs'
let effects=0
const refuse=()=>{effects++;throw Error('Provider, wallet, database or inventory must not be reached')}
const runtime=createPlayableMarketRuntime({rootDirectory:'/unavailable-fixture-root',pool:{query:refuse,connect:refuse},pluginApi:refuse})
for(const args of [['oak_planks','2'],['retry','11111111-1111-1111-1111-111111111111']])assert.match(await runtime.handle({action:'crypto_sell',args}),/Use \/assets/)
const result=await runtime.agentStep({inventoryPlayerId:'fixture-actor'},{action:'market',item:'oak_planks',count:2})
assert.equal(result.complete,false);assert.match(result.message,/verified custody and explicit owner confirmations/);assert.equal(effects,0)
console.log('PASS legacy direct inventory-payout commands stop before effects and direct users to exact-asset custody and explicit on-chain owner confirmation')
