// Bounded real testnet warm-up using the existing publisher, immutable intents and shared gas budget.
import {fileURLToPath} from 'node:url'
import {createBankLaptopRuntime} from '../backend/src/bank/laptop-runtime.mjs'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'
if(process.argv.length!==3||process.argv[2]!=='--warm')throw Error('Use --warm for twelve real on-chain observations over 5.5 minutes; this uses existing capped publisher test gas')
const release=await checkpoints.acquireLocalLease('ethcraft-investment-observations')
const runtime=await createBankLaptopRuntime({rootDirectory:fileURLToPath(new URL('../',import.meta.url)),manifestFile:'.local/marketplace/public-deployment.json'})
try{
  for(let i=0;i<12;i++){
    const observation=await runtime.publishReference()
    console.log(JSON.stringify({observation:i+1,pending:observation.pending,transactionHash:observation.proof?.transactionHash||observation.proof?.hash||null}))
    if(i<11)await new Promise(resolve=>setTimeout(resolve,30000))
  }
}catch(error){console.error(JSON.stringify({status:'blocked',code:/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'INVEST_OBSERVATION_FAILED',budgetReset:false}));process.exitCode=1}
finally{await runtime.close();await release()}
