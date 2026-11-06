// Authorized paid transport probes on disclosed fixture data. No Minecraft actions or CITY transactions.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {loadZeroGProvider} from '../../backend/src/inference/zero-g.mjs'
import {loadAgentModelProvider} from '../../backend/src/inference/anthropic.mjs'
import {createAdaptivePlanner,create0GReviewer} from '../../backend/src/playable/adaptive-planner.mjs'
import {survivalSkills,validateSurvivalTool} from '../../backend/src/playable/survival-tools.mjs'
import {survivalSystem} from '../../backend/src/playable/survival-objectives.mjs'

if(process.argv.length!==3||process.argv[2]!=='--run'){console.log('Usage: node tests/playable/adaptive-model-live.mjs --run');process.exit(0)}
const root=new URL('../../',import.meta.url),settings=JSON.parse(await readFile(new URL('.local/comparison/providers.json',root),'utf8'))
const directory=new URL('evidence/runs/adaptive-model/'+randomUUID()+'/',root);await mkdir(directory,{recursive:true})
const report={schema:'agentcity.adaptive-compute-probe.v1',scope:'Real API generation on disclosed fixture observations only',minecraftActions:0,cityTransactions:0,checks:[]}
try{
  const base=root.pathname
  const economy=await loadZeroGProvider(base,{...settings.CityAgent2,model:'qwen3.5-35b-a3b',maxTokens:1536})
  const advanced=await loadAgentModelProvider(base,settings.CityAgent3),judge=await loadZeroGProvider(base,{...settings.CityAgent2,maxTokens:3072})
  const planner=createAdaptivePlanner({economy,advanced})
  for(const [goal,expected,tier]of [['Craft four sticks from the two carried oak planks. Do not gather.','craft','economy'],['Create a working redstone calculator. First read the pinned blueprint; do not invent circuitry or supplies.','blueprint','advanced']]){
    const observation={fixture:true,health:20,hunger:20,inventory:{oak_planks:2},nearby:[],crafting:['stick'],position:[1748,69,2812]}
    const job={goal,history:[],effects:[],decisions:1}
    const result=await planner({job,observation,messages:[{role:'system',content:survivalSystem},{role:'user',content:JSON.stringify({objective:goal,observation,skills:survivalSkills,recentResults:[]})}]})
    const step=validateSurvivalTool(result.decision.step);assert.equal(step.tool,expected);assert.equal(result.route.tier,tier)
    report.checks.push({status:'pass',kind:'planning',route:result.route,step});console.log('PASS '+tier+' model returned the exact requested fixture tool')
  }
  const job={goal:'Craft four sticks and deposit all four into the destination chest.',history:[],effects:[
    {fixture:true,action:'craft',item:'stick',result:{produced:4},inventoryAfter:{stick:4}},
    {fixture:true,action:'deposit',item:'stick',count:4,result:{moved:4,destination:[1746,69,2812]},inventoryAfter:{}}]}
  const review=await create0GReviewer({provider:judge})({job,observation:{fixture:true,health:20,hunger:20,inventory:{},destinationChest:{stick:4}}})
  assert.equal(review.advisory,true);assert.equal(review.reviewer,'0G')
  report.checks.push({status:'pass',kind:'review',review});console.log('PASS 0G returned a bounded advisory assessment on the fixture receipts')
  report.status='pass'
}catch(error){report.status='fail';report.error=/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'ADAPTIVE_PROBE_FAILED';process.exitCode=1}
report.finishedAt=new Date().toISOString();await writeFile(new URL('report.json',directory),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:directory.pathname}))
