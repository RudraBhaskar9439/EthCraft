const token = document.querySelector('meta[name="agentcity-local-token"]').content
const buttons = [...document.querySelectorAll('button[data-action]')]
const labels = { P3: 'Local AI decision and controlled simulated construction', P4: 'Signed agreement and live discovery', P5: 'Backed test vouchers', P6: 'Trade within the approved limit', P7: 'Simulated materials delivered once', P8: 'Requester acceptance and one fixed payment' }
const text = (id, value) => { document.getElementById(id).textContent = value }
function list(id, entries) {
  document.getElementById(id).replaceChildren(...entries.map(value => {
    const item = document.createElement('li'); item.textContent = value; return item
  }))
}
async function refresh() {
  try {
    const response = await fetch('/api/status')
    if (!response.ok) throw new Error('status_unavailable')
    const data = await response.json()
    buttons.forEach(button => { button.disabled = data.running })
    text('status', data.running ? 'A demonstration is running. Confirmations may take a few minutes.' : data.lastRunError || 'Ready. Review the last verified results below.')
    const checks = data.minecraft?.checks
    text('minecraft-status', data.minecraft?.status === 'pass' ? `${checks.fresh_native_placements} actual placements · ${checks.actual_inspection_correct}/${checks.actual_inspection_total} lamp checks · interrupted work resumed without duplicate placement.` : 'Minecraft verification is pending.')
    text('runtime-status', data.maintainedMinecraft?.status === 'pass' ? 'Verified on Paper 26.3 using the Minecraft 1.21.11 bot protocol. Private demo server: 127.0.0.1:25596.' : 'Maintained runtime verification is pending.')
    const result = data.publicResult
    text('public-status', result?.status === 'pass' ? 'Passed on Unichain Sepolia and Arkiv.' : result ? 'The last testnet attempt stopped; its completed steps are retained.' : 'Public-testnet verification is pending.')
    list('steps', (result?.phases || []).map(step => labels[step.phase]))
    const payment = document.getElementById('payment-link')
    const hash = result?.settlement?.claimTransactionHash
    payment.hidden = !(result?.status === 'pass' && /^0x[0-9a-f]{64}$/i.test(hash || ''))
    if (!payment.hidden) payment.href = 'https://sepolia.uniscan.xyz/tx/' + hash
    text('verified-at', result?.finishedAt ? 'Last verified: ' + new Date(result.finishedAt).toLocaleString() : '')
    list('recovery', data.recovery?.status === 'pass' ? data.recovery.summary : ['Recovery verification is pending.'])
    text('local-status', data.result?.status === 'pass' ? 'The last offline contract flow passed.' : 'No completed offline result yet.')
  } catch { text('status', 'The laptop service is unavailable. Reconnect after it restarts.') }
}
for (const button of buttons) button.addEventListener('click', async () => {
  buttons.forEach(button => { button.disabled = true })
  try {
    const response = await fetch(button.dataset.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentCity-Local': token }, body: '{}' })
    if (!response.ok) throw new Error('run_rejected')
    await refresh()
  } catch { text('status', 'The demonstration could not start. Check the laptop service and retry.'); buttons.forEach(button => { button.disabled = false }) }
})
await refresh()
setInterval(refresh, 2000)
