const labels = {
  approve_escrow: 'Approve exactly 6 test CRED for labor escrow', fund: 'Fund the agreed labor escrow',
  approve_procurement: 'Approve the 3 test CRED material cap', buy: 'Buy and redeem one simulated material bundle',
  accept: 'Accept the protected simulated inspection', claim: 'Claim the builder’s fixed test payment', refund: 'Refund an eligible unaccepted job'
}
const byId = id => document.getElementById(id)
const token = byId('start').ownerDocument.querySelector('meta[name="agentcity-local-token"]').content
let state = null, intent = null, busy = false, refreshing = false, walletAttempt = false
let walletRevision = 0
const identityLinks = new Map()
const messages = {
  AUTHENTICATED_MINECRAFT_AUTHORITY_UNAVAILABLE: 'The authenticated Minecraft server is unavailable.',
  TWO_VERIFIED_HUMAN_WALLET_LINKS_REQUIRED: 'Both people must verify their game account and wallet.',
  AUTHENTICATED_PAIRED_SESSION_REQUIRED: 'Join with Microsoft authentication and enter /walletlink with your wallet address first.',
  REQUESTER_TESTNET_GAS_REQUIRED: 'The requester needs faucet ETH on Unichain Sepolia.',
  HUMAN_SESSION_FROZEN_RECONCILIATION_REQUIRED: 'This agreement has recorded activity. Keep it and reconcile its existing approvals or transactions.',
  HUMAN_SESSION_IDENTITY_SERVER_CHANGED: 'The identity server changed. The retained agreement needs operator review.',
  CHAIN_RECONCILIATION_REQUIRED: 'A retained transaction needs reconciliation.',
  TEST_PROVISIONING_RECONCILIATION_REQUIRED: 'The original test-resource transfer needs reconciliation.',
  TEST_RESOURCE_CHECK_UNAVAILABLE: 'Test-resource balances could not be checked.',
  SYNTHETIC_HEALTH_PUBLICATION_REQUIRED: 'Refresh the separate simulated market status before preparing the purchase.',
  SYNTHETIC_HEALTH_RECONCILIATION_REQUIRED: 'The original simulated market report needs reconciliation before another publication.',
  SYNTHETIC_HEALTH_PUBLICATION_RECONCILIATION_REQUIRED: 'Check the original simulated market report before preparing a purchase.',
  FRESH_SYNTHETIC_HEALTH_REQUIRED: 'Refresh the separate simulated market status before preparing the purchase.',
  SYNTHETIC_MARKET_HEALTH_UNAVAILABLE: 'The simulated market status could not be read. Wait for the public test network before continuing.',
  LOCAL_OPERATION_RUNNING: 'Another local operation is running. Wait for it to finish.',
  HUMAN_SERVICE_UNAVAILABLE: 'The human test service is unavailable. Check the laptop service before retrying.'
}
const message = result => messages[result.error] || result.message || 'This step could not be completed. Refresh the current state before retrying.'
const text = (id, value) => { byId(id).textContent = value }
const short = wallet => wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : ''
const units = value => {
  if (value === null || value === undefined) return '—'
  const digits = String(value).padStart(19, '0'), fraction = digits.slice(-18).replace(/0+$/, '')
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '')
}
async function api(action, input = {}) {
  const response = await fetch('/api/human/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentCity-Local': token }, body: JSON.stringify(input), cache: 'no-store', redirect: 'error' })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(message(result))
  return result
}
async function wallet(expected, connect = false) {
  const provider = window.ethereum
  if (!provider?.request) throw new Error('Open this page in Brave with your wallet enabled.')
  if (connect) await provider.request({ method: 'eth_requestAccounts' })
  const accounts = await provider.request({ method: 'eth_accounts' }), chain = await provider.request({ method: 'eth_chainId' })
  if (accounts[0]?.toLowerCase() !== expected.toLowerCase()) throw new Error('Select wallet ' + short(expected) + ' in MetaMask, then try again.')
  if (BigInt(chain) !== 1301n) throw new Error('Select Unichain Sepolia (1301) in MetaMask.')
  return provider
}
function privateLink(url, label) {
  const parsed = new URL(url)
  if (parsed.origin !== location.origin || parsed.pathname !== '/wallet') throw new Error('The prepared wallet page has an unexpected address.')
  const link = document.createElement('a'); link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label
  return link
}
async function task(callback) {
  if (busy) return
  busy = true; render()
  try { await callback() }
  catch (error) { text('wallet-status', error.message) }
  finally { busy = false; await refresh() }
}
function render() {
  if (!state) return
  const next = state.nextAction || {}, session = state.session
  text('status', session?.complete ? 'The human contract demonstration is complete.' : (state.blockers || []).map(error => message({ error })).join(' ') || 'Complete the next step below. No wallet transaction is sent automatically.')
  byId('people').replaceChildren(...(state.identities?.roles || []).map(person => {
    const item = document.createElement('li')
    item.append(document.createTextNode((person.role === 'requester' ? 'Requester' : 'Builder') + ' · ' + short(person.wallet) + (person.name ? ' · ' + person.name : '') + (person.linked ? ' · wallet link recorded' : person.paired ? ' · game pairing ready' : ' · waiting for game pairing')))
    if (person.paired && !person.linked) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Prepare identity approval'; button.disabled = busy
      button.onclick = () => task(async () => {
        const result = await api('identity', { role: person.role })
        if (result.linked) { text('wallet-status', 'That wallet link is already recorded.'); return }
        identityLinks.set(person.role, result)
        text('wallet-status', 'Open the identity link and sign with your own wallet while staying connected to Minecraft.')
      })
      item.append(button)
    }
    const prepared = identityLinks.get(person.role)
    if (!person.linked && prepared?.expiresAtMs > Date.now()) item.append(privateLink(prepared.url, 'Open your identity approval in Brave'))
    return item
  }))
  text('identity-status', state.identities?.ready ? 'Both game-to-wallet identities are verified for this test.' : 'Both people must complete their own authenticated game login and wallet link before the final agreement.')
  byId('start').disabled = busy || !state.identities?.ready
  byId('start').textContent = session ? 'Open the existing agreement approvals' : 'Prepare final agreement'
  text('agreement-status', session ? 'Agreement: ' + session.agreementState + ' · ' + session.approvalCount + '/2 wallet approvals recorded.' : 'The timed agreement starts only after both identities are ready.')
  byId('register').hidden = !session || session.registered || session.approvalCount !== 2; byId('register').disabled = busy
  const actions = session?.actions || {}
  byId('transactions').replaceChildren(...Object.keys(labels).filter(action => action !== 'refund' || actions.refund).map(action => {
    const item = document.createElement('li'), result = actions[action]
    item.append(document.createTextNode(labels[action] + ' · ' + (result?.status || 'not started')))
    if (/^0x[0-9a-f]{64}$/i.test(result?.txHash || '')) {
      const link = document.createElement('a'); link.href = 'https://sepolia.uniscan.xyz/tx/' + result.txHash; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = ' · View receipt'; item.append(link)
    }
    return item
  }))
  const plan = session?.fundingPlan
  text('funding', plan && actions.fund?.status !== 'confirmed' ? 'Initial test resources: ' + units(plan.totalMaximumCred) + ' test CRED. ' + (plan.missing?.length ? 'Missing: ' + plan.missing.join(', ') + '.' : 'Required balances are available.') : '')
  for (const name of ['provision', 'publish', 'advance']) { byId(name).hidden = next.action !== name; byId(name).disabled = busy }
  byId('prepare').hidden = next.action !== 'prepare' && next.action !== 'begin'
  byId('prepare').textContent = 'Prepare: ' + (labels[next.transactionAction] || 'next transaction')
  byId('prepare').disabled = busy
  byId('recovery').hidden = next.action !== 'recover' && next.action !== 'reconcile'
  byId('recover').disabled = busy
  byId('refresh').disabled = busy
  if (intent && actions[intent.action]?.status === 'confirmed') { intent = null; byId('transaction-consent').checked = false }
  renderIntent()
}
function renderIntent() {
  byId('transaction-review').hidden = !intent
  if (!intent) return
  text('transaction-title', labels[intent.action] || 'Review the transaction')
  const summary = byId('transaction-summary'); summary.replaceChildren()
  for (const [label, value] of [['Expected wallet', intent.sender || intent.request?.from], ['Network', 'Unichain Sepolia · 1301'], ['Amount', units(intent.summary?.amount) + ' test CRED'], ['Maximum material spend', units(intent.summary?.maxCred) + ' test CRED'], ['Native gas budget', units(intent.nativeBudgetWei) + ' test ETH']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value || '—'; summary.append(dt, dd)
  }
  text('transaction-exact', JSON.stringify(intent.request || { status: intent.status, transactionHash: intent.txHash }, null, 2))
  const remaining = Math.max(0, Math.ceil((intent.deadlineMs - Date.now()) / 1000))
  text('deadline', !intent.request ? 'Original intent: ' + intent.status + '. Check confirmed progress without preparing another transaction.' : remaining ? 'Prepared request expires in ' + remaining + ' seconds. A material quote is valid for at most 60 seconds; have your wallet ready.' : 'This prepared request expired. It will not be sent. Check the original intent before requesting another attempt.')
  byId('transaction-consent').disabled = busy || !intent.request || remaining === 0
  byId('send').disabled = busy || !intent.request || remaining === 0 || !byId('transaction-consent').checked
}
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const response = await fetch('/api/human/status', { cache: 'no-store', redirect: 'error' })
    const result = await response.json()
    if (!response.ok) throw new Error(message(result))
    state = result; render()
  } catch (error) { text('status', error.message) }
  finally { refreshing = false }
}
byId('start').onclick = () => task(async () => {
  const result = await api('start')
  byId('review-links').replaceChildren(...(result.review?.links || result.links || []).map(link => {
    const item = document.createElement('li'); item.append(privateLink(link.url, (link.role === 'requester' ? 'Requester' : 'Builder') + ' · ' + short(link.wallet))); return item
  }))
  text('wallet-status', 'Each person opens their own agreement page and reviews its exact test terms.')
})
byId('register').onclick = () => task(async () => { await api('register'); text('wallet-status', 'The approved agreement is pinned. No wallet transaction was submitted.') })
for (const action of ['provision', 'publish', 'advance']) byId(action).onclick = () => task(async () => {
  await api(action); text('wallet-status', { provision: 'The bounded test-resource plan was processed. Refresh to check receipts.', publish: 'The retained simulated market report was processed. Refresh to check its canonical receipt.', advance: 'The simulated delivery, construction and protected inspection were processed.' }[action])
})
byId('prepare').onclick = () => task(async () => {
  const action = state.nextAction.transactionAction, expected = action === 'claim' ? state.participants.builder : state.participants.requester
  await wallet(expected, true)
  intent = await api('prepare', { action }); byId('transaction-consent').checked = false
  text('wallet-status', 'Review the prepared transaction, then open its confirmation in your wallet. Nothing was sent.')
})
byId('transaction-consent').onchange = renderIntent
byId('send').onclick = () => task(async () => {
  if (!intent?.request || !byId('transaction-consent').checked || Date.now() >= intent.deadlineMs) throw new Error('Prepare and review a current transaction first.')
  const revision = walletRevision
  await wallet(intent.request.from)
  const acquired = await api('begin', { operationId: intent.operationId })
  intent = acquired; walletAttempt = true
  let prompted = false
  try {
    if (!acquired.request || acquired.request.chainId !== 1301 || acquired.request.value !== '0x0') throw new Error('The server did not release a valid testnet request. Check the original intent.')
    const provider = await wallet(acquired.request.from)
    if (!byId('transaction-consent').checked || revision !== walletRevision || Date.now() >= acquired.deadlineMs) throw new Error('The account, network, consent or deadline changed. The wallet confirmation was not opened; keep this original intent for operator review.')
    prompted = true
    const txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...acquired.request, chainId: '0x515' }] })
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('The wallet returned no transaction hash. Check its activity before retrying.')
    intent = { ...acquired, request: null, txHash, status: 'submitted' }
    await api('submitted', { operationId: acquired.operationId, transactionHash: txHash })
    text('wallet-status', 'Submitted. The server is checking the exact transaction and two confirmations. Do not submit it again.')
  } catch (error) {
    if (prompted && error.code === 4001) {
      try { intent = await api('rejected', { operationId: acquired.operationId }); text('wallet-status', 'Wallet approval declined. The same unchanged intent is available for another explicit review.') }
      catch { intent.request = null; text('wallet-status', 'The wallet request was declined, but the original intent needs reconciliation before retrying.') }
    } else { intent.request = null; text('wallet-status', 'Submission outcome is uncertain. Keep this intent and recover the original transaction hash from your wallet activity. ' + error.message) }
  } finally { walletAttempt = false; byId('transaction-consent').checked = false }
})
byId('recover').onclick = () => task(async () => {
  const operationId = state.nextAction.operationId || intent?.operationId
  const transactionHash = byId('transaction-hash').value.trim()
  if (!operationId) throw new Error('No original intent is selected.')
  if (transactionHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new Error('Enter the original 0x transaction hash from your wallet.')
    await api('submitted', { operationId, transactionHash })
  }
  await api('reconcile', { operationId }); text('wallet-status', 'Checked the original transaction without sending another one.')
})
byId('refresh').onclick = refresh
window.ethereum?.on?.('accountsChanged', () => { walletRevision++; byId('transaction-consent').checked = false; if (!walletAttempt) text('wallet-status', 'Wallet account changed. Review the expected sender before the next transaction.'); renderIntent() })
window.ethereum?.on?.('chainChanged', () => { walletRevision++; byId('transaction-consent').checked = false; if (!walletAttempt) text('wallet-status', 'Wallet network changed. Select Unichain Sepolia before continuing.'); renderIntent() })
await refresh()
setInterval(() => { if (!busy) refresh() }, 10000)
setInterval(renderIntent, 1000)
