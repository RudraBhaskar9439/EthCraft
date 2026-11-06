const byId=id=>document.getElementById(id)
const tasks=byId('tasks'),network=byId('network'),refresh=byId('refresh'),older=byId('older'),provider=byId('provider')
let offset=0,nextOffset=null
const text=(tag,value,className)=>{const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e}
const link=(label,path)=>{const e=text('a',label);e.href='https://rabdi.explorer.arkiv.network'+path;e.target='_blank';e.rel='noopener noreferrer';return e}
function card(record){
  const e=document.createElement('article')
  const top=text('div','', 'cardtop');top.append(text('span',record.provider==='claude'?'Agent · Claude-capable':'0G worker','worker'),text('span',record.status.replaceAll('_',' '),'status'));e.append(top)
  if(record.facts.fixture)e.append(text('p','CONTROLLED DATA FIXTURE · No game actions','fixture'))
  e.append(text('h2',record.facts.completedSteps+' observed '+(record.facts.completedSteps===1?'step':'steps')),text('p',record.facts.receipts+' local effect receipts · Job '+record.job,'job'))
  const list=document.createElement('ul')
  for(const fact of record.facts.actions){const parts=[fact.tool.replaceAll('_',' '),fact.item?.replace('minecraft:','').replaceAll('_',' ')];for(const k of ['produced','collected','moved','verifiedBlocks'])if(fact[k]!==undefined)parts.push(k+': '+fact[k]);if(fact.position)parts.push('at '+fact.position.join(', '));list.append(text('li',parts.filter(Boolean).join(' · ')))}
  if(!list.children.length)list.append(text('li','No completed action facts yet.'))
  e.append(list)
  if(record.facts.pendingEffect)e.append(text('p','Effect uncertain. Handoff is blocked until reconciliation.','warning'))
  const details=text('div','', 'details');details.append(link('Read entity ↗','/entity/'+record.entityKey),text('p','Publisher '+record.owner),text('p','Expires at block '+record.expiresAtBlock+' · Revision '+record.revision))
  if(record.facts.predecessor)details.append(link('Previous worker’s progress ↗','/entity/'+record.facts.predecessor))
  e.append(details);return e
}
async function load(next=false){
  refresh.disabled=true;older.disabled=true;network.textContent='Reading Arkiv…'
  try{
    const query=new URLSearchParams({offset:String(next?nextOffset:0)});if(provider.value)query.set('provider',provider.value)
    const response=await fetch('/api/arkiv/tasks?'+query,{cache:'no-store'}),result=await response.json()
    if(!response.ok)throw Error(result.error||'ARKIV_UNAVAILABLE')
    offset=Number(query.get('offset'));nextOffset=result.nextOffset;tasks.replaceChildren(...result.records.map(card))
    if(!result.records.length)tasks.append(text('p','No shared tasks in this result page. Publish an agent task in Minecraft to add one.','empty'))
    network.textContent='Live Rabdi · block '+result.blockNumber+(result.rejected?' · '+result.rejected+' invalid records excluded':'')+(offset?' · older history':'')
    older.hidden=nextOffset===null
  }catch(error){tasks.replaceChildren(text('p','Arkiv is unavailable. Local tasks and materials are preserved. Retry the read when the network is ready.','empty'));network.textContent=error.message;older.hidden=true}
  finally{refresh.disabled=false;older.disabled=false}
}
refresh.addEventListener('click',()=>load());provider.addEventListener('change',()=>load());older.addEventListener('click',()=>load(true));void load()
