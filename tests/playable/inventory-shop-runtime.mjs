import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {inventoryShopEvent,inventoryShopPrices} from '../../backend/src/playable/inventory-shop-runtime.mjs'

const event={operationId:randomUUID(),playerId:randomUUID(),connectionId:randomUUID(),playerName:'Micro',action:'inventory_shop',args:['quote',JSON.stringify({item:'oak_planks',count:8})]}
assert.deepEqual(inventoryShopEvent(event),{action:'quote',input:{item:'oak_planks',count:8,playerId:event.playerId,connectionId:event.connectionId}})
assert.equal(inventoryShopEvent({...event,action:'agent_task'}),null)
assert.equal(inventoryShopEvent({...event,action:'crypto_wallet'}),null)
assert.throws(()=>inventoryShopEvent({...event,args:['quote',JSON.stringify({item:'oak_planks',count:8,playerId:randomUUID()})]}),/EVENT_FIELDS_REQUIRED/)
assert.throws(()=>inventoryShopEvent({...event,args:['checkout','{"quoteId":"x","price":"0"}']}),/EVENT_FIELDS_REQUIRED/)
assert.throws(()=>inventoryShopEvent({...event,args:['pay','{}']}),/EVENT_REQUIRED/)
const confirm={...event,args:['confirm',JSON.stringify({orderId:randomUUID(),consentNonce:'n'.repeat(43)})]}
assert.equal(inventoryShopEvent(confirm).input.confirmationId,event.operationId)
assert.throws(()=>inventoryShopEvent({...confirm,args:['confirm',JSON.stringify({orderId:randomUUID(),consentNonce:'n'.repeat(43),confirmationId:randomUUID()})]}),/EVENT_FIELDS_REQUIRED/)
assert.deepEqual(inventoryShopEvent({...event,args:['status',JSON.stringify({orderId:'original-order'})]}).input,{orderId:'original-order',playerId:event.playerId,connectionId:event.connectionId})
assert.equal(Object.keys(inventoryShopPrices).length,8)
assert(Object.values(inventoryShopPrices).every(value=>value==='0.01'))
console.log('PASS dedicated shop events preserve native actor binding, ignore agent and legacy financial queues, reject injected authority/price, and expose eight bounded prices')
