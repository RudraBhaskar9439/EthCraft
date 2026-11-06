const text=(tag,value,className)=>{const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e}
export function workOrderCard(record){
 const spec=record.data.spec,card=document.createElement('article'),top=text('div','','cardtop'),expired=Date.now()>record.deadline
 top.append(text('span','STRUCTURED WORK ORDER','worker'),text('span',record.status.replaceAll('_',' '),'status'));card.append(top)
 if(record.data.fixture)card.append(text('p','CONTROLLED TEST · See record and evidence for test scope','fixture'))
 card.append(text('h2',spec.count+' '+spec.item.replaceAll('_',' ')),text('p','Order '+record.order,'job'))
 card.append(text('p',record.stage+'/2 stages checked by the Minecraft server. '+(record.status==='completed'?'Awaiting owner review.':expired?'Execution deadline has expired.':'Next worker: '+(spec.stages[record.stage]?.worker==='claude'?'Agent':spec.stages[record.stage]?.worker||'none'))))
 const list=document.createElement('ol')
 for(const [i,stage]of spec.stages.entries()){
  const proof=record.data.verifications[i],li=text('li',(stage.worker==='claude'?'Agent':'0G')+' · '+stage.action.replaceAll('_',' ')+' · '+stage.count+' '+stage.item.replaceAll('_',' '))
  li.append(text('p','From '+stage.source.position.join(', ')+' to '+stage.destination.position.join(', '),'small'))
  if(proof)li.append(text('p','SERVER CHECK PASSED · Source '+proof.sourceBefore+' → '+proof.sourceAfter+' '+spec.input.item+'; destination '+proof.destinationBefore+' → '+proof.destinationAfter+' '+proof.item,'worker'))
  else li.append(text('p',i===record.stage?'Remaining stage · no server proof yet':'Not started','small'))
  list.append(li)
 }
 card.append(list,text('p','Input: '+spec.input.count+' '+spec.input.item.replaceAll('_',' ')+'. No payment or purchase permission.','small'))
 if(expired&&record.status!=='completed')card.append(text('p','Expired orders cannot start or resume. Records remain readable until entity expiry.','warning'))
 const details=text('div','','details'),link=text('a','Open Arkiv entity ↗');link.href='https://rabdi.explorer.arkiv.network/entity/'+record.entityKey;link.target='_blank';link.rel='noopener noreferrer'
 details.append(link,text('p','Deadline '+new Date(record.deadline).toLocaleString()),text('p','Revision '+record.revision+' · Entity expiry block '+record.expiresAtBlock),text('p','Publisher '+record.owner))
 const raw=document.createElement('details');raw.append(text('summary','View specification and server proofs'),text('pre',JSON.stringify(record,null,2)));details.append(raw)
 card.append(details);return card
}
export async function loadWorkOrders(endpoint,includeFixtures=false){
 const container=document.getElementById('orders'),status=document.getElementById('orderNetwork')
 status.textContent='Reading structured orders from Arkiv…'
 try{
  const response=await fetch(endpoint,{cache:'no-store'}),page=await response.json();if(!response.ok)throw Error('ARKIV_UNAVAILABLE')
  const records=page.records.filter(r=>includeFixtures||!r.data.fixture)
  container.replaceChildren(...records.map(workOrderCard))
  if(!records.length)container.append(text('p','No public work orders yet. An approved player can publish one with /agent agent order create craft_delivery stick 4.','empty'))
  status.textContent='Live Rabdi · block '+page.blockNumber+' · '+records.length+' latest orders'
 }catch{container.replaceChildren(text('p','Arkiv work orders are unavailable. Retry the live read.','empty'));status.textContent='Live work-order read unavailable'}
}
