import assert from 'node:assert/strict'
import {validateMarketManifest} from '../../backend/src/playable/uniswap-market.mjs'
import {buildPrivyMarketPolicies} from '../../backend/src/playable/testnet-wallets.mjs'
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash='0x'+'a'.repeat(64)
const legacy={schema:'agentcity.playable-market.v1',environment:'UNICHAIN_SEPOLIA_PLAYABLE',chainId:1301,rpcUrl:'https://sepolia.unichain.org',genesisHash:hash,
 poolManager:address(1),quoter:address(2),router:address(3),tokens:{CITY:{address:address(4),decimals:18},GEM:{address:address(5),decimals:18}},
 poolKey:{currency0:address(4),currency1:address(5),fee:3000,tickSpacing:60,hooks:address(0)},codeHashes:Object.fromEntries(['poolManager','quoter','router','CITY','GEM'].map(k=>[k,hash])),maxInputBaseUnits:'100000000000000000000',maxNativeCostWei:'2000000000000000'}
assert.equal(validateMarketManifest(legacy).poolKey.hooks,address(0))
assert.throws(()=>validateMarketManifest({...legacy,poolKey:{...legacy.poolKey,hooks:address(6)}}),/FIXED_CITY_GEM_POOL_REQUIRED/)
const hooked={...structuredClone(legacy),schema:'agentcity.playable-market.v2',hook:address(6),stateRegistry:address(7),marketId:hash}
hooked.poolKey.hooks=hooked.hook;hooked.codeHashes.hook=hash;hooked.codeHashes.stateRegistry=hash
const checked=validateMarketManifest(hooked);assert.equal(checked.poolKey.hooks,address(6));assert.equal(checked.confirmations,2)
const missing=structuredClone(hooked);delete missing.codeHashes.hook;assert.throws(()=>validateMarketManifest(missing),/HOOKED_MARKET_CODE_HASH_REQUIRED/)
assert.throws(()=>validateMarketManifest({...hooked,stateRegistry:hooked.hook}),/DISTINCT_MARKET_CONTRACTS_REQUIRED/)
assert.throws(()=>validateMarketManifest({...hooked,poolKey:{...hooked.poolKey,hooks:address(0)}}),/FIXED_CITY_GEM_POOL_REQUIRED/)
const policy=buildPrivyMarketPolicies(checked);assert(policy.allowedTargets.includes(checked.router));assert(!policy.allowedTargets.includes(checked.hook))
assert(policy.player.rules.every(rule=>rule.method==='eth_signTransaction'))
console.log('PASS old zero-hook manifests retain their binding; new hooked manifests require pinned hook/state registry identity and keep constrained zero-value signing policies')
