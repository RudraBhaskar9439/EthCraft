// Explicit identity, native-session and chain-service transport fixtures only.
import assert from 'node:assert/strict'
import {createOnchainGameRuntime,createOnchainAgentMarketRuntime} from '../../backend/src/discord/onchain-game.mjs'
const player='11111111-1111-4111-8111-111111111111',principal='22222222-2222-4222-8222-222222222222',connection='33333333-3333-4333-8333-333333333333',calls=[],recoveries=[]
let approved=true
const owner={ownerId:principal,minecraftPlayerId:player,discordUserId:'600000000000000001'}
const identity={getMinecraftOwner:async(serverId,id)=>{assert.equal(serverId,'fixture');assert.equal(id,player);return owner},getOwner:async id=>{assert.equal(id,owner.discordUserId);return owner}}
const runtime=createOnchainGameRuntime({identity,serverId:'fixture',native:async()=>({online:true,pendingAuthentication:!approved,connectionId:connection,principalId:principal,authenticationKind:'discord_approved_local_profile'}),worldAssets:{handleDiscord:async input=>{calls.push(input);return{message:'CITY fixture response',assets:[{tokenId:'9',kind:'item',item:'minecraft:stick',count:1}],...(input.action==='swap'?{confirmation:{operationId:'original-swap-preview'}}:{})}}},recovery:{handleGame:async event=>{recoveries.push(event);return{message:'Original stock recovered'}}}})
const event=(action,args=[])=>({operationId:'fixture-operation',playerId:player,connectionId:connection,action,args})
for(const action of ['player_join','pay','sell','crypto_sell'])assert.match(await runtime.handle(event(action)),/CITY/)
assert.equal(calls.length,0);assert.equal(recoveries.length,0)
console.log('PASS legacy grant/pay/sell events never create a coin account, trade or payment')
assert.match(await runtime.handle(event('balance')),/CITY/);assert.equal(calls.at(-1).action,'wallet');assert.equal(calls.at(-1).userId,owner.discordUserId)
await runtime.handle(event('crypto_swap',['0.01','GEM','CITY']));assert.equal(calls.at(-1).action,'swap');assert.deepEqual(calls.at(-1).args,{amount:'0.01',tokenIn:'GEM',tokenOut:'CITY'})
await runtime.handle(event('crypto_swap',['receive','10','GEM','CITY','12']))
assert.deepEqual(calls.at(-1).args,{kind:'exact_output',amount:'10',tokenIn:'GEM',tokenOut:'CITY',maxAmountIn:'12'})
await assert.rejects(runtime.handle(event('crypto_swap',['receive','10','GEM'])),/swap receive/)
await runtime.handle(event('crypto_swap',['confirm','original-swap-preview']));assert.equal(calls.at(-1).action,'confirm_swap');assert.equal(calls.at(-1).args.operationId,'original-swap-preview')
console.log('PASS approved game identity maps to the same on-chain wallet and exact preview; only explicit confirm commands dispatch confirmation')
await runtime.handle(event('bazaar',['browse']));assert.equal(calls.at(-1).action,'browse')
await runtime.handle(event('bazaar',['list','stick','1','4']));assert.equal(recoveries.length,0)
await runtime.handle(event('bazaar',['claim','original-mailbox']));assert.equal(recoveries.length,1);assert.equal(recoveries[0].args[1],'original-mailbox')
approved=false;const before=calls.length;await assert.rejects(runtime.handle(event('crypto_swap',['confirm','original-swap-preview'])),/APPROVED_GAME_SESSION_REQUIRED/);assert.equal(calls.length,before)
await assert.rejects(runtime.handle(event('crypto_swap',['receive','10','GEM','CITY','12'])),/APPROVED_GAME_SESSION_REQUIRED/)
assert.equal(calls.length,before)
console.log('PASS old listing commands cannot create coin trades; claims retain original mailbox identity and unapproved connections cannot sign')
const proposals=[],agentMarket=createOnchainAgentMarketRuntime({worldAssets:{handleDiscord:async input=>{proposals.push(input);return{message:'Preview',operation:{operationId:'original-resource-preview'}}}},agents:{status:()=>[{name:'CityAgent2',ownerId:principal,connected:true}],getBot:()=>({username:'CityAgent2',inventory:{items:()=>[{name:'stick',count:3,slot:36}]}})},resolveDiscordUser:async id=>{assert.equal(id,principal);return owner.discordUserId}})
const proposal=await agentMarket.handle({playerId:principal,operationId:'original-step'},{action:'market',item:'stick',count:1})
assert.equal(proposal.complete,false);assert.equal(proposals[0].action,'register_item');assert.deepEqual(proposals[0].args,{source:'agent',slot:0,count:1});assert.match(proposal.message,/explicitly confirm/)
await assert.rejects(agentMarket.handle({playerId:principal},{action:'confirm'}),/PREVIEW_ONLY/);assert.equal(proposals.length,1)
console.log('PASS agent sale proposals select exact owned native inventory slots and resource quantities; models cannot dispatch a confirmation or payment')
