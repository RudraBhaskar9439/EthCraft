import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../../', import.meta.url), runId = randomUUID()
const source = await readFile(new URL('backend/src/web/human.mjs', root), 'utf8')
const checks = [], report = { runId, status: 'fail', checks, scope: 'Minimal DOM/VM and scripted browser-provider/HTTP fixtures; no browser extension, public RPC, wallet signing or real transaction is used.',
  publicCalls: 0, publicTransactions: 0, realMoneySpent: 0,
  sources: { 'backend/src/web/human.mjs': createHash('sha256').update(source).digest('hex') } }
const check = name => { checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
const copy = value => JSON.parse(JSON.stringify(value))
const requester = '0x1111111111111111111111111111111111111111', builder = '0x2222222222222222222222222222222222222222'
const txHash = '0x' + 'ab'.repeat(32), origin = 'http://127.0.0.1:8789'
const drain = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.textContent = ''; this.checked = false; this.disabled = false; this.hidden = false; this.value = '' }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
}
function descendants(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...element.children.flatMap(child => descendants(child, predicate))]
}

async function fixture({ identityOnly = false } = {}) {
  const elements = new Map(), trace = [], timers = [], handlers = new Map(), requests = [], apiCalls = []
  let now = Date.now(), selected = requester, chainId = '0x515', send = async () => txHash, beginGate = null
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id === 'people' ? 'ul' : 'div', document)); return elements.get(id) },
    querySelector(selector) { assert.equal(selector, 'meta[name="agentcity-local-token"]'); return { content: 'a'.repeat(64) } },
    createElement: tag => new Element(tag, document), createTextNode: text => Object.assign(new Element('#text', document), { textContent: text })
  }
  const operationId = randomUUID(), intent = { operationId, agreementHash: '0x' + 'cd'.repeat(32), action: 'approve_escrow', sender: requester, status: 'prepared',
    deadlineMs: now + 60000, nativeBudgetWei: '8000000000000000',
    request: { chainId: 1301, from: requester, to: '0x3333333333333333333333333333333333333333', data: '0x1234', value: '0x0', nonce: '0x1', gas: '0x186a0', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1' },
    summary: { amount: '6000000000000000000', maxCred: '0' } }
  const status = { participants: { requester, builder }, blockers: [], identities: { ready: !identityOnly, roles: [
    { role: 'requester', wallet: requester, paired: true, linked: !identityOnly }, { role: 'builder', wallet: builder, paired: !identityOnly, linked: !identityOnly }] },
    session: identityOnly ? null : { complete: false, registered: true, approvalCount: 2, agreementState: 'approved', actions: {} },
    nextAction: { action: 'prepare', transactionAction: 'approve_escrow' } }
  const provider = {
    on(name, callback) { handlers.set(name, [...handlers.get(name) || [], callback]) },
    async request(input) {
      trace.push('provider:' + input.method); requests.push(copy(input))
      if (input.method === 'eth_requestAccounts' || input.method === 'eth_accounts') return [selected]
      if (input.method === 'eth_chainId') return chainId
      if (input.method === 'eth_sendTransaction') return send(input)
      throw new Error('Unexpected wallet method: ' + input.method)
    }
  }
  const response = value => ({ ok: true, json: async () => copy(value) })
  const fetch = async (url, options = {}) => {
    assert.ok(url.startsWith('/api/human/'), 'The fixture must never call any external URL')
    const action = url.slice('/api/human/'.length), input = options.body ? JSON.parse(options.body) : {}
    trace.push('api:' + action); apiCalls.push({ action, input })
    if (action === 'status') { assert.equal(options.method, undefined); return response(status) }
    assert.equal(options.method, 'POST'); assert.equal(options.headers['X-AgentCity-Local'], 'a'.repeat(64))
    if (action === 'identity') return response({ linked: false, expiresAtMs: now + 300000, url: origin + '/wallet#id=private-fixture&token=local-capability' })
    assert.ok(status.session)
    if (action === 'publish') { assert.deepEqual(input, {}); return response({ status: 'confirmed' }) }
    if (action === 'prepare') {
      assert.equal(input.action, intent.action)
      status.session.actions[intent.action] = copy(intent)
      status.nextAction = { action: 'begin', transactionAction: intent.action, operationId }
      return response(intent)
    }
    assert.equal(input.operationId, operationId)
    if (action === 'begin') {
      assert.equal(status.session.actions[intent.action].status, 'prepared', 'Only one explicit wallet attempt may acquire this request')
      if (beginGate) await beginGate
      status.session.actions[intent.action] = { ...copy(intent), status: 'unknown', request: null }
      status.nextAction = { action: 'recover', operationId }
      return response({ ...copy(intent), status: 'unknown' })
    }
    if (action === 'submitted') {
      assert.equal(input.transactionHash, txHash)
      status.session.actions[intent.action] = { ...copy(intent), request: null, txHash, status: 'submitted' }
      status.nextAction = { action: 'reconcile', operationId }
      return response(status.session.actions[intent.action])
    }
    if (action === 'rejected') {
      assert.equal(status.session.actions[intent.action].status, 'unknown')
      status.session.actions[intent.action] = copy(intent)
      status.nextAction = { action: 'begin', transactionAction: intent.action, operationId }
      return response(intent)
    }
    if (action === 'reconcile') return response(status.session.actions[intent.action])
    throw new Error('Unexpected HTTP action: ' + action)
  }
  const context = vm.createContext({ document, window: { ethereum: provider }, location: { origin }, fetch, URL, BigInt, Map,
    Date: class extends Date { static now() { return now } }, setInterval(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length } })
  await new vm.Script('(async () => {\n' + source + '\n})()', { filename: 'human.mjs' }).runInContext(context)
  const el = id => document.getElementById(id)
  return { el, status, operationId, intent, requests, apiCalls, trace,
    setSend: callback => { send = callback }, setBeginGate: value => { beginGate = value },
    async prepare() { await el('prepare').onclick(); assert.equal(el('transaction-consent').checked, false) },
    consent() { el('transaction-consent').checked = true; el('transaction-consent').onchange() },
    async poll() { for (const timer of timers.filter(entry => entry.milliseconds >= 10000)) { timer.callback(); await drain() } },
    emit(event, value) { if (event === 'accountsChanged') selected = value[0]; if (event === 'chainChanged') chainId = value; for (const callback of handlers.get(event) || []) callback(value) },
    expire() { now += 120000; for (const timer of timers.filter(entry => entry.milliseconds === 1000)) timer.callback() } }
}

try {
  {
    const app = await fixture()
    assert.equal(app.requests.length, 0)
    await app.prepare()
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 0)
    let release
    app.setSend(() => new Promise(resolve => { release = resolve }))
    app.consent()
    const first = app.el('send').onclick()
    await drain()
    assert.equal(typeof release, 'function')
    await app.el('send').onclick()
    assert.equal(app.apiCalls.filter(call => call.action === 'begin').length, 1)
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 1)
    assert.ok(app.trace.indexOf('api:begin') < app.trace.indexOf('provider:eth_sendTransaction'))
    release(txHash); await first
    const sent = app.requests.find(request => request.method === 'eth_sendTransaction').params[0]
    assert.deepEqual(sent, { ...app.intent.request, chainId: '0x515' })
    assert.equal(app.apiCalls.filter(call => call.action === 'submitted').length, 1)
    assert.equal(app.el('transaction-consent').checked, false)
    check('explicit preparation and consent precede server acquisition; double click opens one wallet request with the reviewed body')
  }
  {
    const app = await fixture(); await app.prepare(); app.consent()
    app.setSend(async () => { const error = new Error('User declined'); error.code = 4001; throw error })
    await app.el('send').onclick()
    assert.equal(app.apiCalls.filter(call => call.action === 'rejected').length, 1)
    assert.equal(app.el('transaction-consent').checked, false)
    assert.equal(app.el('send').disabled, true)
    await app.poll()
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 1)
    app.setSend(async () => txHash); app.consent(); await app.el('send').onclick()
    const sends = app.requests.filter(request => request.method === 'eth_sendTransaction')
    assert.equal(sends.length, 2); assert.deepEqual(sends[0].params, sends[1].params)
    assert.ok(app.apiCalls.filter(call => ['begin', 'rejected', 'submitted'].includes(call.action)).every(call => call.input.operationId === app.operationId))
    check('wallet rejection requires another explicit consent and acquisition of the same unchanged intent')
  }
  {
    const app = await fixture(); await app.prepare(); app.consent()
    app.setSend(async () => { throw new Error('Scripted transport loss after submission') })
    await app.el('send').onclick(); await app.poll(); await app.el('refresh').onclick()
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 1)
    assert.equal(app.apiCalls.filter(call => call.action === 'begin').length, 1)
    assert.equal(app.apiCalls.filter(call => call.action === 'rejected').length, 0)
    assert.equal(app.el('send').disabled, true)
    assert.match(app.el('wallet-status').textContent, /uncertain/)
    app.el('transaction-hash').value = txHash
    await app.el('recover').onclick()
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 1)
    assert.equal(app.apiCalls.filter(call => call.action === 'reconcile').length, 1)
    check('uncertain submission and refresh preserve recovery without another wallet send')
  }
  {
    const app = await fixture(); await app.prepare(); app.consent()
    app.emit('accountsChanged', [builder])
    assert.equal(app.el('transaction-consent').checked, false); assert.equal(app.el('send').disabled, true)
    app.consent(); await app.el('send').onclick()
    assert.equal(app.apiCalls.filter(call => call.action === 'begin').length, 0)
    app.emit('accountsChanged', [requester]); app.consent(); app.emit('chainChanged', '0x1')
    assert.equal(app.el('transaction-consent').checked, false)
    app.consent(); await app.el('send').onclick()
    assert.equal(app.apiCalls.filter(call => call.action === 'begin').length, 0)
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 0)
    check('wallet account or network changes clear consent and wrong contexts cannot acquire a transaction')
  }
  {
    const app = await fixture(); await app.prepare(); app.consent()
    let release
    app.setBeginGate(new Promise(resolve => { release = resolve }))
    const attempted = app.el('send').onclick(); await drain()
    assert.equal(app.apiCalls.filter(call => call.action === 'begin').length, 1)
    app.emit('chainChanged', '0x1'); release(); await attempted; await app.poll()
    assert.equal(app.requests.filter(request => request.method === 'eth_sendTransaction').length, 0, 'A wallet change during acquisition must stop before the provider prompt')
    assert.equal(app.status.session.actions.approve_escrow.status, 'unknown')
    check('wallet change during server acquisition retains the acquired intent without opening a stale wallet request')
  }
  {
    const app = await fixture({ identityOnly: true })
    const button = descendants(app.el('people'), element => element.tagName === 'BUTTON' && element.textContent === 'Prepare identity approval')[0]
    assert.ok(button); await button.onclick()
    const link = () => descendants(app.el('people'), element => element.tagName === 'A' && element.textContent === 'Open your identity approval in Brave')[0]
    assert.equal(link()?.href, origin + '/wallet#id=private-fixture&token=local-capability')
    await app.poll(); await app.el('refresh').onclick()
    assert.equal(link()?.href, origin + '/wallet#id=private-fixture&token=local-capability')
    assert.equal(link().target, '_blank'); assert.equal(link().rel, 'noopener noreferrer')
    assert.equal(app.requests.length, 0)
    check('private identity review link survives status polling and manual refresh without opening a wallet')
  }
  {
    const app = await fixture()
    app.status.nextAction = { action: 'publish' }
    await app.poll(); await app.el('refresh').onclick()
    assert.equal(app.el('publish').hidden, false)
    assert.equal(app.apiCalls.filter(call => call.action === 'publish').length, 0)
    await app.el('publish').onclick()
    assert.equal(app.apiCalls.filter(call => call.action === 'publish').length, 1)
    assert.equal(app.requests.length, 0)
    check('synthetic market publication requires an explicit operator click; status refresh never publishes or opens a human wallet')
  }
  report.status = 'pass'
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; console.error(error) }
finally {
  const output = new URL('evidence/runs/human-web/' + runId + '/', root)
  await mkdir(output, { recursive: true }); report.finishedAt = new Date().toISOString()
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, evidence: output.pathname + 'report.json', publicTransactions: 0 }))
}
