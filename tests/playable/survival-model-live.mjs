// Actual paid provider requests under the existing finite ledgers. Fixture
// observations only; no Minecraft actions or financial transactions are sent.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadAgentModelProvider, requestAnthropicPlan } from '../../backend/src/inference/anthropic.mjs'
import { loadZeroGProvider, requestZeroGPlan } from '../../backend/src/inference/zero-g.mjs'
import { survivalDecisionSchema, survivalSystem, requestSurvivalDecision } from '../../backend/src/playable/survival-objectives.mjs'
import { survivalSkills, validateSurvivalTool } from '../../backend/src/playable/survival-tools.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url)),settings=JSON.parse(await readFile(root+'/.local/comparison/providers.json','utf8'))
const directory=root+'/evidence/runs/survival-model/'+randomUUID();await mkdir(directory,{recursive:true})
const report={schema:'agentcity.survival-provider-probe.v1',scope:'Real provider inference on disclosed fixture observations; no actual world effects',checks:[],minecraftActions:0,financialTransactions:0}
const complex=process.argv.includes('--complex')
for(const [name,load,configuration,request]of[['0g',loadZeroGProvider,settings.CityAgent2,requestZeroGPlan],['claude',loadAgentModelProvider,settings.CityAgent3,requestAnthropicPlan]]){
  if(process.argv.includes('--0g-only')&&name!=='0g'||process.argv.includes('--claude-only')&&name!=='claude')continue
  const start=Date.now();let proposedDecision
  try{
    const provider=await load(root,configuration)
    const objective=complex?'A checked build plan needs 32 oak planks; you carry two. Source chest was just observed empty and gathering is blocked in the loaded area. Buy only the missing planks from the supplied shop, then wait for actual delivery before building.':'Craft four sticks from the two carried oak planks. Do not gather or build.'
    const result=await requestSurvivalDecision((messages,schema)=>request(provider,messages,schema,{maxTokens:complex?provider.maxTokens:Math.min(provider.maxTokens||4096,800)}),[{role:'system',content:survivalSystem},{role:'user',content:JSON.stringify({objective,skills:survivalSkills,observation:{fixture:true,position:[1748,69,2812],health:20,hunger:20,inventory:{oak_planks:2},crafting:['stick'],nearby:[],...(complex?{sourceChest:{observedEmpty:true},shop:{item:'oak_planks',available:64,unitPriceCity:'0.01',existingWalletCityBalance:'1',testnet:true}}:{})},recentResults:complex?[{step:{tool:'gather',item:'oak_log',count:8},error:'RESOURCE_NOT_OBSERVED'}]:[]})}],provider.kind)
    proposedDecision=result
    if(result.status!=='act')throw Error('EXPECTED_OBSERVED_CRAFT_ACTION')
    const step=validateSurvivalTool(result.step)
    if(step.tool!==(complex?'purchase':'craft')||step.item!==(complex?'oak_planks':'stick')||step.count!==(complex?30:4))throw Error('MODEL_CHANGED_EXACT_OBJECTIVE')
    report.checks.push({provider:name,model:provider.model,status:'pass',elapsedMs:Date.now()-start,validatedStep:step,maxTokens:provider.maxTokens,thinkingMode:provider.thinkingMode,effort:provider.effort})
    console.log('PASS '+name+' returned the exact valid '+(complex?'30-plank shortfall purchase proposal':'Survival craft tool')+' under its existing budget')
  }catch(error){const code=/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'PROVIDER_PROBE_FAILED';report.checks.push({provider:name,status:'fail',code,elapsedMs:Date.now()-start,proposedDecision});console.error(name+': '+code);process.exitCode=1}
}
report.status=report.checks.every(c=>c.status==='pass')?'pass':'fail';await writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:directory}))
