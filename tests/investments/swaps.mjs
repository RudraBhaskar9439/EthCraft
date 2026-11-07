import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {previewGuardedSwap,swapAbi} from '../../backend/src/investments/swaps.mjs'

const require=createRequire(new URL('../../backend/package.json',import.meta.url))
const {decodeAbiParameters,parseAbiParameters,decodeFunctionData}=require('viem')
const address=n=>'0x'+n.repeat(40)
const owner=address('7')
const manifest={city:address('1'),usdc:address('2'),hook:address('3'),quoter:address('4'),router:address('5'),
  pools:{cityUsdc:{currency0:address('1'),currency1:address('2'),fee:8388608,tickSpacing:60,hooks:address('3')}}}
const snapshot={blockNumber:1n,timestamp:1794000000,pool:{sqrtPriceX96:(1n<<96n)/1000000n}}
const input={tokenIn:'tUSDC',tokenOut:'CITY',amountOut:'5000000000000000',maximumInput:'6000'}
let simulated=0
const client={
  async readContract({functionName}) {
    if(functionName==='marketReference')return [true,-276325,1794000000n,0n]
    assert.equal(functionName,'feeFor');return 3000
  },
  async simulateContract(request) {
    simulated++
    assert.equal(request.functionName,'quoteExactOutputSingle')
    assert.equal(request.account,owner)
    assert.equal(request.blockNumber,snapshot.blockNumber)
    const [params]=request.args
    assert.equal(params.zeroForOne,false)
    assert.equal(params.exactAmount,5000000000000000n)
    assert.equal(decodeAbiParameters(parseAbiParameters('address'),params.hookData)[0].toLowerCase(),owner)
    return {result:[5001n,100000n]}
  }
}
const request={manifest,client,snapshot,input,owner,operationId:'guarded-swap-test'}
const quote=await previewGuardedSwap(request)
assert.equal(quote.expectedInput,'5001')
assert.equal(quote.maximumInput,'5027')
assert.equal(quote.slippageBps,50)
assert.equal(quote.calls.length,3)
const decoded=decodeFunctionData({abi:swapAbi,data:quote.call.data})
assert.equal(decoded.functionName,'swapExactOutput')
assert.deepEqual(decoded.args.slice(1,5),[manifest.usdc,manifest.city,5000000000000000n,5027n])
await assert.rejects(previewGuardedSwap({...request,input:{...input,maximumInput:'5001'}}),{code:'INVEST_MAXIMUM_INPUT_TOO_LOW'})
const before=simulated
await assert.rejects(previewGuardedSwap({...request,client:{...client,readContract:async()=>[false,0,0n,0n]}}),{code:'INVEST_REFERENCE_NOT_READY'})
assert.equal(simulated,before)
console.log('Guarded swap quote, owner hook data, amount cap and stale reference checks passed')
