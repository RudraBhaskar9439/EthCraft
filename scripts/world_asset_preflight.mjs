import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createPublicClient,http,keccak256} from '../backend/node_modules/viem/_esm/index.js'
const root=fileURLToPath(new URL('../',import.meta.url))
const base=JSON.parse(await readFile(join(root,'.local/playable-testnet/market.json'),'utf8'))
const account=JSON.parse(await readFile(join(root,'.local/playable-testnet/account-settings.json'),'utf8'))
if(base.chainId!==1301||account.chainId!==1301||base.rpcUrl!=='https://sepolia.unichain.org'||account.rpcUrl!==base.rpcUrl)throw Error('PUBLIC_TESTNET_CONTEXT_REQUIRED')
const client=createPublicClient({transport:http(base.rpcUrl,{timeout:15000,retryCount:0})})
if(await client.getChainId()!==1301||(await client.getBlock({blockNumber:0n})).hash.toLowerCase()!==base.genesisHash.toLowerCase())throw Error('CHAIN_INSTANCE_CHANGED')
const balance=await client.getBalance({address:account.address})
for(const name of ['poolManager','quoter','CITY','GEM']){
 const code=await client.getCode({address:base.tokens[name]?.address||base[name]})
 if(!code||code==='0x'||keccak256(code).toLowerCase()!==base.codeHashes[name].toLowerCase())throw Error('BASE_DEPLOYMENT_CODE_CHANGED:'+name)
}
console.log(JSON.stringify({status:balance===0n?'faucet_funding_required':'developer_faucet_balance_available',chainId:1301,developer:account.address,balanceWei:balance.toString(),maximumNativeBudgetWei:'8000000000000000',basePoolHook:base.poolKey.hooks,newHookedPoolRequired:true,verifiedExistingTokenAndManagerCode:true,publicTransactions:0,realMoneySpentUsd:0}))
