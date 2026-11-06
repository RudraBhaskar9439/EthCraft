const agreementFields = 'jobId:bytes32 serverId:bytes32 version:uint256 requester:address builder:address cred:address kit:address bundleHash:bytes32 blueprintHash:bytes32 testsHash:bytes32 accessHash:bytes32 scopeHash:bytes32 materialCap:uint256 allocationsHash:bytes32 workDeadline:uint64 reviewDeadline:uint64 passDeadline:uint64 absoluteExpiry:uint64'
const identityFields = 'serverId:string playerUuid:string sessionId:string wallet:address origin:string nonce:bytes32 issuedAtMs:uint64 expiresAtMs:uint64'
function refuse(message) { throw new Error(message) }
export function approvalState(request, now = Date.now()) {
  if (request.state === 'approved') return 'approved'
  return request.state === 'pending' && Number.isSafeInteger(request.expiresAtMs) && now < request.expiresAtMs ? 'pending' : 'expired'
}
function validate(request) {
  const typed = request.typedData
  const agreement = request.kind === 'agreement'
  const primaryType = agreement ? 'Agreement' : 'WalletLink'
  const expected = (agreement ? agreementFields : identityFields).split(' ').map(field => field.split(':'))
  if (!['agreement', 'identity'].includes(request.kind) || request.chainId !== 1301 || typed?.domain?.chainId !== 1301 || typed.primaryType !== primaryType ||
      typed.domain.name !== (agreement ? 'AgentCityEscrow' : 'AgentCity Identity') || typed.domain.version !== '1' ||
      Object.keys(typed.types).join(',') !== primaryType || typed.types[primaryType].length !== expected.length ||
      expected.some(([name, type], index) => typed.types[primaryType][index].name !== name || typed.types[primaryType][index].type !== type) ||
      Object.keys(typed.message).sort().join(',') !== expected.map(([name]) => name).sort().join(',')) refuse('This request does not use a supported AgentCity approval.')
  const domainFields = agreement ? ['chainId', 'name', 'verifyingContract', 'version'] : ['chainId', 'name', 'salt', 'version']
  if (Object.keys(typed.domain).sort().join(',') !== domainFields.sort().join(',')) refuse('The approval domain changed.')
  if (agreement && (typed.domain.verifyingContract.toLowerCase() !== request.contracts.jobEscrow ||
      typed.message.cred.toLowerCase() !== request.contracts.creditToken || typed.message.kit.toLowerCase() !== request.contracts.kitCustody)) refuse('The contract addresses changed.')
  if (!agreement && typed.message.wallet.toLowerCase() !== request.expectedAccount) refuse('The identity wallet changed.')
}
export async function expectedWallet(provider, request) {
  validate(request)
  const accounts = await provider.request({ method: 'eth_accounts' })
  const chain = await provider.request({ method: 'eth_chainId' })
  if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== request.expectedAccount) refuse('Select the expected account in your wallet, then connect again.')
  if (BigInt(chain) !== 1301n) refuse('Select Unichain Sepolia (chain 1301) in your wallet, then connect again.')
  return accounts[0]
}
export async function signPrepared(provider, request, consent) {
  if (consent !== true || request.state !== 'pending') refuse('Review and approve a pending request first.')
  if (approvalState(request) !== 'pending') refuse('This prepared link expired. Ask for a fresh request.')
  const account = await expectedWallet(provider, request)
  const domainTypes = { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' }
  const typed = { ...request.typedData, types: { ...request.typedData.types, EIP712Domain: Object.keys(domainTypes).filter(name => name in request.typedData.domain).map(name => ({ name, type: domainTypes[name] })) } }
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] })
  await expectedWallet(provider, request)
  if (approvalState(request) !== 'pending') refuse('This prepared link expired while the wallet was open.')
  return { account: account.toLowerCase(), chainId: 1301, consent: true, signature }
}
function units(value) {
  const padded = String(value).padStart(19, '0'), fraction = padded.slice(-18).replace(/0+$/, '')
  return padded.slice(0, -18) + (fraction ? '.' + fraction : '') + ' test CRED'
}
async function mount() {
  const status = document.getElementById('status'), connect = document.getElementById('connect'), sign = document.getElementById('sign'), consent = document.getElementById('consent'), renew = document.getElementById('renew')
  const fragment = new URLSearchParams(location.hash.slice(1)), id = fragment.get('id')
  let token = fragment.get('token')
  if (id && token) { sessionStorage.setItem('agentcity-handoff-' + id, token); history.replaceState(null, '', location.pathname + '#' + new URLSearchParams({ id })) }
  token ||= id && sessionStorage.getItem('agentcity-handoff-' + id)
  if (!id || !token) refuse('Open the prepared approval link supplied by the operator.')
  const endpoint = '/api/wallet/handoffs/' + encodeURIComponent(id)
  const headers = { 'X-AgentCity-Handoff': token }
  const response = await fetch(endpoint, { headers, cache: 'no-store', redirect: 'error' })
  if (!response.ok) refuse('This prepared approval link is unavailable.')
  const request = await response.json()
  validate(request)
  if (request.origin !== location.origin) refuse('The approval was prepared for a different site.')
  document.title = 'AgentCity · Wallet ' + request.expectedAccount.slice(0, 6) + '…' + request.expectedAccount.slice(-4)
  document.getElementById('review').hidden = false
  document.getElementById('purpose').textContent = request.kind === 'agreement' ? 'Approve the displayed test agreement' : 'Link this wallet to the authenticated session'
  const summary = document.getElementById('summary')
  const row = (label, value) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; summary.append(dt, dd) }
  row('Expected wallet', request.expectedAccount); row('Network', 'Unichain Sepolia · 1301')
  row('Prepared link expires', new Date(request.expiresAtMs).toLocaleString(undefined, { timeZoneName: 'short' }))
  if (request.kind === 'agreement') {
    row('Requester', request.review.requester); row('Builder', request.review.builder)
    row('Fixed labor total', units(request.review.totalLaborBaseUnits)); row('Maximum material purchase', units(request.review.materialCapBaseUnits))
    for (const allocation of request.review.allocations) row('Fixed recipient allocation', allocation.recipient + ' · ' + units(allocation.amount))
    for (const [label, field] of [['Work deadline', 'workDeadline'], ['Review deadline', 'reviewDeadline'], ['Pass deadline', 'passDeadline'], ['Absolute expiry', 'absoluteExpiry']]) row(label, new Date(Number(request.review[field]) * 1000).toISOString())
  } else { row('Authenticated player UUID', request.review.playerUuid); row('Server', request.review.serverId) }
  document.getElementById('exact').textContent = JSON.stringify({ contracts: request.contracts, review: request.review, digest: request.digest, typedData: request.typedData }, null, 2)
  document.getElementById('meaning').textContent = request.kind === 'agreement'
    ? 'Signing records your approval of these exact test terms. The agreement signature may remain usable under its contract deadlines after this link expires. Funding, purchases, acceptance and claims are separate actions controlled by your wallet.'
    : 'Signing links this wallet to the displayed authenticated session. It does not approve an agreement, submit a transaction or change Minecraft access.'
  document.getElementById('meaning').after(status)
  let connected = false, busy = false
  const expireReview = () => {
    if (approvalState(request) !== 'expired') return false
    request.state = 'expired'; connected = false
    connect.disabled = true; consent.disabled = true; consent.checked = false; sign.disabled = true; renew.hidden = false
    status.dataset.state = 'expired'
    status.textContent = 'This request expired. Choose Prepare fresh approval pages below, then open your wallet’s new request.'
    return true
  }
  if (expireReview()) return
  if (request.state === 'approved') { status.textContent = 'This approval is already recorded.'; connect.disabled = true; return }
  const provider = window.ethereum
  if (!provider?.request) { connect.disabled = true; refuse('Open this page in Brave with your injected wallet enabled.') }
  const changed = () => { if (request.state === 'approved' || expireReview()) return; connected = false; consent.checked = false; consent.disabled = true; sign.disabled = true; status.textContent = 'Account or network changed. Connect again and review these terms.' }
  provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', changed)
  connect.onclick = async () => {
    if (expireReview()) return
    try { await provider.request({ method: 'eth_requestAccounts' }); await expectedWallet(provider, request); if (expireReview()) return; connected = true; consent.disabled = false; status.textContent = 'Expected account and network verified. Review the terms before signing.' }
    catch (error) { if (!expireReview()) { changed(); status.textContent = error.message } }
  }
  consent.onchange = () => { sign.disabled = approvalState(request) !== 'pending' || !connected || !consent.checked || busy }
  sign.onclick = async () => {
    if (busy || expireReview()) return
    busy = true; sign.disabled = true; connect.disabled = true
    try {
      const approval = await signPrepared(provider, request, connected && consent.checked)
      if (!connected || !consent.checked) refuse('Account or network changed. Review and connect again.')
      const submitted = await fetch(endpoint + '/signature', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(approval), redirect: 'error' })
      if (!submitted.ok) refuse('The server did not record this approval. Keep the request and check its status before retrying.')
      status.textContent = 'Your approval is verified and recorded. No transaction was submitted.'
      consent.disabled = true; request.state = 'approved'
    } catch (error) { if (!expireReview()) status.textContent = error.code === 4001 ? 'Wallet request declined. No approval was recorded.' : error.message }
    finally { busy = false; if (!expireReview()) { connect.disabled = request.state !== 'pending'; sign.disabled = request.state !== 'pending' || !connected || !consent.checked } }
  }
  const timer = setInterval(() => { if (request.state === 'approved' || expireReview()) clearInterval(timer) }, 1000)
  status.textContent = 'Review the request, then connect your expected wallet.'
}
if (typeof document !== 'undefined') mount().catch(error => { document.getElementById('status').textContent = error.message })
