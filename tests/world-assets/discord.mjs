// Coordinator transport fixtures only: no Privy, chain, native world or funds.
import assert from 'node:assert/strict'
import {createWorldAssetDiscordRuntime} from '../../backend/src/discord/world-assets-runtime.mjs'
import {worldAssetReply,discordCommands} from '../../backend/src/discord/bot.mjs'
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',calls=[]
const row={operationId:'discord:123456789000000001',previewId:'33333333-3333-4333-8333-333333333333',action:'mint',status:'preview',termsDigest:'a'.repeat(64),terms:{kind:'item',nativePreview:{descriptor:{material:'minecraft:diamond_sword',name:'My sword',durability:70,enchantments:{sharpness:3}},fingerprint:'b'.repeat(64)}},proofs:[]}
let previews=0,confirms=0,syncs=0
const service={
 async previewMint(request){previews++;calls.push(request);return row},
 async previewList(request){calls.push(request);return{...row,action:'list',terms:{price:request.priceBaseUnits}}},
 async status(request){if(request.principalId!==owner)throw Error('WORLD_ASSET_IMMUTABLE_REQUEST_OWNER_REQUIRED');return row},
 async confirm(request){assert.equal(request.principalId,owner);assert.equal(request.termsDigest,row.termsDigest);confirms++;return{...row,status:'complete',message:'Confirmed fixture operation'}},
 async sync(){syncs++;return{status:'active'}},
 async browse(){return{assets:[]}},async ownedAssets(){return{assets:[]}}
}
const identity={async getOwner(userId){return{ownerId:userId==='600000000000000001'?owner:other,discordUserId:userId}}}
const swapCalls = []
let swapConfirmations = 0
const swapQuote = {previewId:row.previewId,status:'preview',kind:'exact_output',amountIn:'2.01',quotedOut:'3',maxAmountIn:'2.1',minimumOut:'3',tokenIn:'GEM',tokenOut:'CITY',deadline:2000000000,consented:false}
const payments = {
 async preview(request){swapCalls.push(request);return request.amountIn === undefined ? swapQuote
  : {...swapQuote,kind:'exact_input',amountIn:request.amountIn,minimumOut:'2.9'}},
 async confirm(request){swapCalls.push(request);swapConfirmations++;return {...swapQuote,status:'confirmed',consented:true,proof:{swap:{amountInBaseUnits:'2050000000000000000'}}}}
}
const runtime=await createWorldAssetDiscordRuntime({manifest:{},service,wallets:{},registrar:{},payments,pool:{},identity,agents:{status:()=>[{name:'CityAgent2',ownerId:owner,connected:true,mode:'wait',tasks:[],workflow:{status:'complete'}}]},native:async()=>({catalog:[]})})
const result=await runtime.handleDiscord({userId:'600000000000000001',operationId:row.operationId,action:'register_item',args:{source:'agent'}})
assert.equal(previews,1);assert.equal(confirms,0);assert.equal(calls[0].principalId,owner);assert.equal(calls[0].sourceKind,'agent_inventory');assert.equal(calls[0].agentId,'CityAgent2')
const payload=worldAssetReply(result),json=JSON.stringify(payload)
assert(json.includes('diamond_sword'));assert(json.includes('sharpness'));assert(json.includes('ac:asset-confirm:discord%3A123456789000000001'));assert.deepEqual(payload.allowedMentions,{parse:[]})
console.log('PASS exact equipment descriptor and fingerprint preview uses bound own-agent source and offers explicit testnet confirmation without invoking execution')
await assert.rejects(runtime.handleDiscord({userId:'600000000000000002',operationId:'foreign-confirm',action:'confirm',args:{operationId:row.previewId}}),/OWNER_REQUIRED/)
await runtime.handleDiscord({userId:'600000000000000001',operationId:'explicit-owner-click',action:'confirm',args:{operationId:row.previewId}})
assert.equal(confirms,1);assert.equal(syncs,1)
await runtime.handleDiscord({userId:'600000000000000001',operationId:'listing-preview',action:'list',args:{tokenId:'1',price:'12.5'}})
assert.equal(calls.at(-1).priceBaseUnits,'12500000000000000000')
await runtime.handleDiscord({userId:'600000000000000001',operationId:'plain-lot-preview',action:'register_item',args:{source:'player',count:3}})
assert.equal(calls.at(-1).count,3)
const command=discordCommands().find(command=>command.name==='assets');assert(command);assert(command.options[0].choices.some(value=>value.value==='claim_land'));assert(command.options[0].choices.some(value=>value.value==='swap'))
assert(command.options.some(option=>option.name==='count'))
const browse=worldAssetReply({assets:[{tokenId:'1',kind:'parcel',parcelId:'estate-0-0',listing:{active:true,priceBaseUnits:'1000000000000000000'}}]})
assert(JSON.stringify(browse).includes('ac:asset-buy:1'));assert(JSON.stringify(browse).includes('1 CITY'))
await runtime.handleDiscord({userId:'600000000000000001',operationId:'exact-input-preview',action:'swap',args:{amount:'3',tokenIn:'GEM',tokenOut:'CITY'}})
assert.equal(swapCalls.at(-1).amountIn,'3');assert.equal(swapCalls.at(-1).amountOut,undefined)
const beforeInvalidMode=swapCalls.length
await assert.rejects(runtime.handleDiscord({userId:'600000000000000001',operationId:'invalid-mode',action:'swap',args:{kind:'other',amount:'3'}}),/SWAP_MODE_REQUIRED/)
await assert.rejects(runtime.handleDiscord({userId:'600000000000000001',operationId:'invalid-input-cap',action:'swap',args:{amount:'3',maxAmountIn:'4'}}),/SWAP_MODE_REQUIRED/)
assert.equal(swapCalls.length,beforeInvalidMode)
const swap = await runtime.handleDiscord({userId:'600000000000000001',operationId:'exact-output-preview',action:'swap',args:{kind:'exact_output',amount:'3',maxAmountIn:'2.1',tokenIn:'GEM',tokenOut:'CITY'}})
assert.equal(swapCalls.at(-1).amountOut,'3');assert.equal(swapCalls.at(-1).maxAmountIn,'2.1');assert.equal(swapCalls.at(-1).amountIn,undefined)
assert.equal(swapConfirmations,0);assert.match(swap.message,/receive exactly 3 CITY/);assert.match(swap.message,/maximum 2.1 GEM/)
assert.equal(swap.confirmation.operationId,row.previewId)
const swapped = await runtime.handleDiscord({userId:'600000000000000001',operationId:'exact-output-confirm',action:'confirm_swap',args:{operationId:row.previewId}})
assert.equal(swapConfirmations,1);assert.match(swapped.message,/spent 2.05 GEM/)
assert(command.options.some(option=>option.name==='mode'&&option.choices.some(choice=>choice.value==='exact_output')))
assert(command.options.some(option=>option.name==='maximum'))
swapQuote.status='expired'
const expiredSwap=await runtime.handleDiscord({userId:'600000000000000001',operationId:'expired-swap',action:'swap',args:{kind:'exact_output',amount:'3',tokenIn:'GEM',tokenOut:'CITY'}})
assert.match(expiredSwap.message,/expired/);assert.equal(expiredSwap.confirmation,null);assert.equal(swapConfirmations,1)
console.log('PASS exact-output commands retain the owner spend cap, require explicit confirmation and display actual receipt spending')
await runtime.close()
console.log('PASS foreign ownership refuses; explicit confirmation retains original immutable preview; CITY decimals stay exact and blockchain asset/land/swap commands render')
