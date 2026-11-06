const $ = value => document.querySelector(value)
const capability = $('meta[name="agentcity-capability"]').content
let state, pending, busy = false
const titles = { register_item:'Deposit your equipment', list_item:'List equipment', cancel_listing:'Cancel your listing',
  redeem_item:'Redeem your equipment', checkout:'Buy the exact listed item', swap:'Exchange USDC and CITY',
  fund_work:'Fund the agreed task', run_work:'Run the funded task', accept_work:'Accept the verified work', refund_work:'Refund eligible task funds' }

function notice(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error) }
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node }
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET',
    headers: { 'x-agentcity-bank': capability, ...(body ? { 'Content-Type':'application/json' } : {}) },
    ...(body ? { body:JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw Error(value.message || value.error || 'The operation could not complete. Check its retained status before retrying.')
  return value
}
function options(select, items) {
  const selected = select.value
  select.replaceChildren(...items.map(item => { const option = element('option', item.label); option.value = item.value; return option }))
  if (items.some(item => item.value === selected)) select.value = selected
}
function button(text, action, args) { const node = element('button', text, 'secondary'); node.type = 'button'; node.addEventListener('click', () => review(action, args)); return node }
function record(title, description, status, actions = []) {
  const node = element('article', undefined, 'record')
  node.append(element('span', status || '', 'status'), element('h3', title), element('p', description))
  if (actions.length) { const row = element('div', undefined, 'actions'); row.append(...actions); node.append(row) }
  return node
}
function render() {
  options($('#actor'), state.actors.map(value => ({value:value.principalId,label:value.label})))
  for (const [name, value] of Object.entries(state.balances || {})) { const node = $('#balance-' + name); if (node) node.textContent = value }
  $('#market-health').textContent = state.marketHealth?.message || 'Market health has not been verified.'
  $('#price-protection').textContent = state.priceProtection?.message || 'The on-chain price guard must be verified before exchanging tokens.'
  const owned = (state.assets || []).filter(value => value.owned)
  const lists = {
    'owned-items':owned.map(value => ({value:value.tokenId,label:value.label})),
    listings:(state.assets || []).filter(value => value.listing?.active && !value.owned).map(value => ({value:value.tokenId,label:value.label + ' — ' + value.price + ' CITY'})),
    workers:state.actors.filter(value => value.role === 'worker').map(value => ({value:value.principalId,label:value.label}))
  }
  for (const node of document.querySelectorAll('[data-source]')) options(node, lists[node.dataset.source] || [])
  $('#asset-list').replaceChildren(...owned.map(value => record(value.label, value.description, value.locked ? 'Locked' : 'Owned',
    value.locked ? [] : value.listing?.active
      ? [button('Review listing cancellation','cancel_listing',{tokenId:value.tokenId})]
      : [button('Review redemption','redeem_item',{tokenId:value.tokenId})])))
  $('#work-list').replaceChildren(...(state.work || []).map(value => record(value.label, value.description, value.state,
    (value.actions || []).map(action => button(action.label, action.action, {workId:value.workId})))))
  $('#operation-list').replaceChildren(...(state.operations || []).map(value => {
    const node = record(value.label, value.message, value.status)
    const row = element('div',undefined,'actions')
    if (!['complete','confirmed','cancelled','expired','reverted'].includes(value.status)) row.append(button('Review retained operation','retained',{operationId:value.operationId}))
    for (const receipt of value.receipts || []) { const a = element('a','View transaction'); a.href=receipt.url; a.target='_blank'; a.rel='noopener noreferrer'; row.append(a) }
    node.append(row); return node
  }))
  $('#deployment').textContent = JSON.stringify(state.deployment, null, 2)
}
async function refresh() {
  try { state = await api('state' + ($('#actor').value ? '?principalId=' + encodeURIComponent($('#actor').value) : '')); render(); notice('Connected to the laptop marketplace. Review each action before confirming.') }
  catch (error) { notice(error.message, true) }
}
async function review(action, args = {}) {
  if (busy) return
  busy = true; notice('Preparing the exact terms. No player transaction is authorized yet.')
  try {
    pending = await api(action === 'retained' ? 'operation' : 'preview', { principalId:state.principalId, action, ...args })
    $('#review-title').textContent = titles[pending.action] || 'Review retained operation'
    $('#review-message').textContent = pending.message || 'Check these terms before authorizing the selected operator test wallet.'
    $('#review-terms').replaceChildren(...(pending.review || []).flatMap(([name,value]) => [element('dt',name), element('dd',String(value))]))
    $('#review-details').textContent = JSON.stringify(pending.exact, null, 2)
    $('#confirm').textContent = pending.consented ? 'Reconcile original operation' : 'Confirm these terms'
    $('#confirm').disabled = !pending.canConfirm
    $('#review').showModal()
    notice('Review prepared. No additional action occurs until confirmation.')
  } catch (error) { notice(error.message,true) } finally { busy=false }
}
for (const form of document.querySelectorAll('form[data-action]')) form.addEventListener('submit', event => {
  event.preventDefault(); review(form.dataset.action, Object.fromEntries(new FormData(form)))
})
for (const node of document.querySelectorAll('button[data-action]')) node.addEventListener('click', () => review(node.dataset.action))
$('#refresh').addEventListener('click', refresh)
$('#actor').addEventListener('change', refresh)
$('#cancel').addEventListener('click', () => $('#review').close())
$('#publish-health').addEventListener('click', async () => {
  if (busy) return; busy=true; notice('Checking the actual world before publishing its availability…')
  try { await api('health',{}); await refresh() } catch(error) { notice(error.message,true) } finally { busy=false }
})
$('#record-observation').addEventListener('click', async () => {
  if (busy) return
  busy = true
  notice('Recording actual pool state. This uses the publisher’s bounded test-ETH budget.')
  try { const result = await api('observation', {}); await refresh(); notice(result.message) }
  catch (error) { notice(error.message, true) }
  finally { busy = false }
})
$('#confirm').addEventListener('click', async () => {
  if (busy || !pending) return
  busy=true; $('#confirm').disabled=true; notice('Reconciling the original operation. Keep this page open.')
  try {
    const result=await api('confirm',{principalId:pending.principalId,operationId:pending.operationId,termsDigest:pending.termsDigest})
    $('#review').close(); await refresh(); notice(result.message || 'Operation recorded. Check its activity and transaction receipt.')
  } catch(error) { notice(error.message,true); $('#review').close(); await refresh(); notice(error.message,true) }
  finally { busy=false }
})
await refresh()
