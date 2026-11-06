// Privy SDK-shaped fixture only. No live API calls, wallets, signatures or account changes.
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID} from 'node:crypto'
import {createPrivyManagedProvider,privyPolicyFingerprint} from '../../backend/src/playable/testnet-wallets.mjs'
import {buildInvestmentPolicy} from '../../backend/src/investments/policy.mjs'
const pair=()=>{const p=generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{type:'pkcs8',format:'der'},publicKeyEncoding:{type:'spki',format:'der'}});return{privateKey:p.privateKey.toString('base64'),publicKey:p.publicKey.toString('base64')}}
const owner=pair(),shop=pair(),invest=pair(),address=n=>'0x'+n.repeat(40)
const manifest={chainId:1301,mode:'marketplace',city:address('1'),usdc:address('2'),positionManager:address('3'),permit2:address('4'),router:address('5')}
const policy={...buildInvestmentPolicy(manifest,2000000000),id:'investment-policy',owner_id:'owner'}
const basic={...policy,id:'shop-policy'}
const binding={policyId:'shop-policy',additionalSigners:[{signer_id:'shop',override_policy_ids:['shop-policy']},{signer_id:'invest',override_policy_ids:['investment-policy']}]}
let created=0,signed=[]
const fixtureWallet={id:'wallet',address:address('7'),external_id:'chosen',chain_type:'ethereum',owner_id:'owner',policy_ids:['shop-policy'],additional_signers:structuredClone(binding.additionalSigners),exported_at:null}
const keys={owner,shop,invest}
const sdk={keyQuorums:()=>({get:async id=>({id,authorization_threshold:1,authorization_keys:[{public_key:keys[id].publicKey}],user_ids:[],key_quorum_ids:[]})}),
  policies:()=>({get:async id=>id===policy.id?policy:basic}),wallets:()=>({get:async id=>{if(id==='ext_wal_absent')throw{status:404};return fixtureWallet},create:async()=>{created++;throw Error('creation forbidden')},ethereum:()=>({signTransaction:async(id,request)=>{signed.push(request);return{encoding:'rlp',signed_transaction:'0x01'}}})})}
const base={appId:'fixture',appSecret:'fixture',ownerPublicKey:owner.publicKey,ownerQuorumId:'owner',delegateAuthorizationPrivateKey:shop.privateKey,delegatePublicKey:shop.publicKey,delegateQuorumId:'shop',policyId:'shop-policy',policySha256:privyPolicyFingerprint(basic),allowedTargets:Object.values(manifest).filter(v=>typeof v==='string'&&v.startsWith('0x')),client:sdk}
await assert.rejects(createPrivyManagedProvider(base).ensureWallet({externalId:'chosen'}),/WALLET_BINDING_CHANGED/)
const buyer=createPrivyManagedProvider({...base,walletBindings:{chosen:binding}})
assert.equal((await buyer.ensureWallet({externalId:'chosen'})).address,address('7'))
const investor=createPrivyManagedProvider({...base,delegateAuthorizationPrivateKey:invest.privateKey,delegatePublicKey:invest.publicKey,delegateQuorumId:'invest',policyId:policy.id,policySha256:privyPolicyFingerprint(policy),walletBinding:binding})
await investor.validateConfiguration();assert.equal((await investor.ensureWallet({externalId:'chosen'})).address,address('7'))
await assert.rejects(investor.ensureWallet({externalId:'absent'}),/EXISTING_INVESTMENT_WALLET_REQUIRED/);assert.equal(created,0)
await investor.signTransaction({accountId:'wallet',externalId:'chosen',operationId:randomUUID(),transaction:{chainId:1301,from:address('7'),to:manifest.positionManager,nonce:1,gas:'100000',maxFeePerGas:'1000',maxPriorityFeePerGas:'100',value:'0',data:'0x'}})
assert.deepEqual(signed[0].authorization_context.authorization_private_keys,[invest.privateKey]);assert.equal(signed[0].params.transaction.chain_id,'0x515')
fixtureWallet.additional_signers[1].override_policy_ids=['shop-policy'];await assert.rejects(investor.ensureWallet({externalId:'chosen'}),/WALLET_BINDING_CHANGED/)
console.log('PASS exact opt-in dual delegation preserves original wallet/shop scope, rejects changed signers and cannot provision another wallet (fixtures only)')
