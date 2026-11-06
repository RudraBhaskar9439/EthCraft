import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, defineSchema, str, u64, bytes, ExpirationTime, ENTITY_EVENTS_ABI } from '@arkiv-network/sdk-rabdi'
import { rabdi } from '@arkiv-network/sdk-rabdi/chains'
import { and, eq, desc } from '@arkiv-network/sdk-rabdi/query'
import { http, custom, stringToHex, hexToString, parseTransaction, recoverTransactionAddress, keccak256, decodeEventLog } from 'viem'
import checkpoints from '../bot/checkpoint-store.cjs'

export const chainId = 7794095
export const publisherAddress = '0x5a262B9621eD0F00Fe776bb85084E9561cF18608'
export const engineAddress = '0x4400000000000000000000000000000000000044'
export const TaskProgress = defineSchema('ethcraft.task-progress.v1', {
  server: str().indexed(), task: str().indexed(), job: str().indexed(), provider: str().indexed(),
  status: str().indexed(), revision: u64().indexed(), facts: bytes()
})
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const hexKey = /^0x[0-9a-f]{64}$/i
const item = /^(?:minecraft:)?[a-z][a-z0-9_]{0,63}$/
const tools = new Set(['move','gather','craft','build','place','activate','equip','eat','smelt','hunt','deposit','withdraw','purchase','blueprint','observe'])
const statuses = new Set(['running','paused','blocked','ready_for_review','handed_off'])
export const serverNamespace = server => createHash('sha256').update(server).digest('hex')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const position = p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 30000000)

// Publish only typed action facts. Prompts, model messages, identities and raw receipts never leave the host.
export function projectProgress(job, provider, server) {
  if (!uuid.test(job.id) || !uuid.test(job.rootTask || job.id) || !['claude','0g'].includes(provider) || !statuses.has(job.status)) throw Error('ARKIV_PROGRESS_BINDING_REQUIRED')
  const completed = job.history.filter(h => h.step && h.result && tools.has(h.step.tool))
  const facts = completed.slice(-12).map(h => {
    const fact = { tool: h.step.tool }
    if (item.test(h.step.item || '')) fact.item = h.step.item
    if (position(h.step.position)) fact.position = h.step.position
    for (const key of ['count','produced','collected','moved','verifiedBlocks','consumed']) {
      const n = key === 'count' ? h.step.count : h.result[key]
      if (Number.isSafeInteger(n) && n >= 0 && n <= 100000) fact[key] = n
    }
    if (h.step.tool === 'purchase') fact.delivered = h.result.delivered === true
    return fact
  })
  return {
    server, task: job.rootTask || job.id, job: job.id, provider, status: job.status,
    facts: { version: 1, fixture: job.qualificationFixture === true, completedSteps: completed.length, failedSteps: job.history.filter(h => h.error).length,
      receipts: (job.effects || []).length, receiptDigest: digest(job.effects || []),
      pendingEffect: !!job.pendingEffect, actions: facts, predecessor: job.sharedProgress?.entityKey || null }
  }
}

export function validateProgress(record, server) {
  const f = record?.facts
  if (!record || Object.keys(record).some(k => !['server','task','job','provider','status','facts'].includes(k)) || record.server !== server || !uuid.test(record.task) || !uuid.test(record.job) || !['claude','0g'].includes(record.provider) || !statuses.has(record.status) ||
      !f || f.version !== 1 || typeof f.fixture !== 'boolean' || Object.keys(f).some(k => !['version','fixture','completedSteps','failedSteps','receipts','receiptDigest','pendingEffect','actions','predecessor'].includes(k)) ||
      !Number.isSafeInteger(f.receipts) || f.receipts < 0 || !/^[0-9a-f]{64}$/.test(f.receiptDigest || '') ||
      !Number.isSafeInteger(f.completedSteps) || f.completedSteps < 0 || !Number.isSafeInteger(f.failedSteps) || f.failedSteps < 0 || typeof f.pendingEffect !== 'boolean' || !Array.isArray(f.actions) || f.actions.length > 12 ||
      !(f.predecessor === null || hexKey.test(f.predecessor))) throw Error('ARKIV_PROGRESS_INVALID')
  for (const a of f.actions) {
    if (!a || !tools.has(a.tool) || Object.keys(a).some(k => !['tool','item','position','count','produced','collected','moved','verifiedBlocks','consumed','delivered'].includes(k)) ||
        a.item !== undefined && !item.test(a.item) || a.position !== undefined && !position(a.position) || a.delivered !== undefined && typeof a.delivered !== 'boolean') throw Error('ARKIV_PROGRESS_INVALID')
    for (const k of ['count','produced','collected','moved','verifiedBlocks','consumed']) if (a[k] !== undefined && (!Number.isSafeInteger(a[k]) || a[k] < 0 || a[k] > 100000)) throw Error('ARKIV_PROGRESS_INVALID')
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 12000) throw Error('ARKIV_PROGRESS_TOO_LARGE')
  return record
}

export function createTaskReader({ server, publisher = publisherAddress, accessKey = '', client } = {}) {
  client ||= createPublicClient({ chain: rabdi({ accessKey }), transport: http(undefined, { retryCount: 0, timeout: 15000 }) })
  const decode = row => {
    if (row.$owner?.toLowerCase() !== publisher.toLowerCase()) throw Error('ARKIV_PUBLISHER_MISMATCH')
    const record = validateProgress({
      ...Object.fromEntries(['server','task','job','provider','status'].map(k => [k,row[k].value])), facts: JSON.parse(hexToString(row.facts.value))
    }, server)
    if (!hexKey.test(row.$key) || row.revision.value < 1n || row.revision.value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('ARKIV_ENTITY_INVALID')
    return { ...record, entityKey: row.$key, revision: Number(row.revision.value), expiresAtBlock: String(row.$expiresAt),
      owner: row.$owner, attestation: 'Host-observed progress; not independent inspection or payment authority.' }
  }
  return {
    client, server, publisher,
    async get(key) {
      if (!hexKey.test(key)) throw Error('ARKIV_ENTITY_KEY_REQUIRED')
      return decode(await client.getEntity(key, TaskProgress))
    },
    async list({ provider, status, offset = 0 } = {}) {
      if (provider !== undefined && !['claude','0g'].includes(provider) || status !== undefined && !statuses.has(status) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw Error('ARKIV_QUERY_INVALID')
      const filters = [eq('server',server)]
      if (provider) filters.push(eq('provider',provider))
      // Filter lifecycle state after choosing the latest revision, so old paused snapshots cannot look current.
      const page = await client.select('*').from(TaskProgress).ownedBy(publisher).where(and(...filters)).orderBy(desc('revision')).limit(100).offset(offset).fetch()
      const latest = new Map()
      let rejected = 0
      for (const row of page.entities) {
        try { const r = decode(row); if (!latest.has(r.job)) latest.set(r.job,r) } catch { rejected++ }
      }
      return { chainId, server, publisher, blockNumber: String(page.blockNumber), records: [...latest.values()].filter(r => !status || r.status === status), rejected,
        nextOffset: page.entities.length + page.skipped === 100 ? offset + 100 : null, source: 'live-arkiv', scope: 'Latest revision per job within this result page; older pages contain history.' }
    }
  }
}

const maxCost = 1000000000000000000n, maxTransactionCost = 100000000000000000n
export class TaskPublisher {
  constructor({ reader, account, file, state, transport }) {
    Object.assign(this,{ reader, account, file, state, transport })
    this.tail = Promise.resolve()
  }
  async save() { await checkpoints.writeCheckpoint(this.file,this.state) }
  publish(record) {
    validateProgress(record,this.reader.server)
    const work = this.tail.then(() => this.perform(record))
    this.tail = work.catch(() => {})
    return work
  }
  async perform(record) {
    const fingerprint = digest(record)
    let entry = this.state.entries.find(e => e.fingerprint === fingerprint)
    const earlier = this.state.entries.find(e => e.rawTransaction && !['confirmed','reverted'].includes(e.status))
    if (earlier && earlier !== entry) await this.reconcile(earlier)
    if (!entry) {
      if (this.state.entries.length >= 200) throw Error('ARKIV_PUBLICATION_LIMIT_REACHED')
      entry = { fingerprint, record, revision: this.state.entries.length + 1, status: 'prepared', createdAt: new Date().toISOString() }
      this.state.entries.push(entry); await this.save()
    }
    if (entry.status === 'reverted') throw Error('ARKIV_PUBLICATION_REVERTED')
    if (entry.entityKey) {
      try { return { ...await this.reader.get(entry.entityKey), transactionHash: entry.transactionHash } }
      catch (error) { if (error.name === 'NoEntityFoundError') throw Error('ARKIV_SHARED_RECORD_EXPIRED'); throw error }
    }
    if (entry.rawTransaction) return this.reconcile(entry)
    if (await this.reader.client.getChainId() !== chainId) throw Error('ARKIV_RABDI_REQUIRED')
    if (await this.reader.client.getBalance({ address: this.account.address }) === 0n) throw Error('ARKIV_TEST_GAS_REQUIRED')
    const ordinary = this.transport({ chain: this.reader.client.chain, retryCount: 0 })
    const transport = custom({ request: async request => {
      if (request.method !== 'eth_sendRawTransaction') return ordinary.request(request)
      const raw = request.params[0], tx = parseTransaction(raw)
      const signer = await recoverTransactionAddress({ serializedTransaction: raw })
      if (tx.chainId !== chainId || tx.to?.toLowerCase() !== engineAddress.toLowerCase() || (tx.value || 0n) !== 0n || signer.toLowerCase() !== this.account.address.toLowerCase() || entry.rawTransaction && entry.rawTransaction !== raw) throw Error('ARKIV_SIGNING_SCOPE_CHANGED')
      const reserved = tx.gas * (tx.maxFeePerGas ?? tx.gasPrice)
      const previous = this.state.entries.filter(e => e !== entry).reduce((sum,e) => sum + BigInt(e.reservedCost || 0),0n)
      if (reserved > maxTransactionCost || previous + reserved > maxCost) throw Error('ARKIV_TEST_GAS_CAP_REACHED')
      entry.rawTransaction = raw; entry.transactionHash = keccak256(raw); entry.reservedCost = String(reserved); entry.status = 'submitted'
      await this.save()
      return ordinary.request(request)
    } },{ retryCount: 0 })
    const wallet = createWalletClient({ account: this.account, chain: this.reader.client.chain, transport })
    const result = await wallet.createEntity(TaskProgress,{
      server: record.server, task: record.task, job: record.job, provider: record.provider, status: record.status,
      revision: u64(BigInt(entry.revision)), facts: bytes(stringToHex(JSON.stringify(record.facts)))
    },{ expiration: ExpirationTime.fromDays(7), flags: { readonly: true } })
    if (result.txHash !== entry.transactionHash) throw Error('ARKIV_RECEIPT_MISMATCH')
    return this.reconcile(entry)
  }
  async reconcile(entry) {
    let receipt
    try { receipt = await this.reader.client.getTransactionReceipt({ hash: entry.transactionHash }) }
    catch (error) {
      if (!['TransactionReceiptNotFoundError','TransactionNotFoundError'].includes(error.name)) throw error
      try { await this.reader.client.request({ method: 'eth_sendRawTransaction', params: [entry.rawTransaction] }) }
      catch (sendError) { if (!/already known|known transaction|nonce too low/i.test(sendError.shortMessage || sendError.message)) throw Error('ARKIV_PUBLICATION_PENDING') }
      try { receipt = await this.reader.client.waitForTransactionReceipt({ hash: entry.transactionHash, timeout: 20000 }) }
      catch { throw Error('ARKIV_PUBLICATION_PENDING') }
    }
    if (receipt.status !== 'success') { entry.status = 'reverted'; await this.save(); throw Error('ARKIV_PUBLICATION_REVERTED') }
    const keys = []
    for (const log of receipt.logs) if (log.address.toLowerCase() === engineAddress.toLowerCase()) {
      try { const event = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics }); if (event.eventName === 'EntityCreated') keys.push(event.args.entityKey) } catch {}
    }
    if (keys.length !== 1) throw Error('ARKIV_RECEIPT_ENTITY_REQUIRED')
    const found = await this.reader.get(keys[0])
    const {server,task,job,provider,status,facts} = found
    if (digest({server,task,job,provider,status,facts}) !== entry.fingerprint || found.revision !== entry.revision) throw Error('ARKIV_RECEIPT_CONTENT_MISMATCH')
    entry.entityKey = keys[0]; entry.status = 'confirmed'; entry.confirmedAt = new Date().toISOString(); await this.save()
    return { ...found, transactionHash: entry.transactionHash }
  }
}

export async function loadPublisherState(file, server, publisher) {
  let state
  try { state = JSON.parse(await readFile(file,'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  state ||= { version: 1, server, publisher, entries: [] }
  if (state.version !== 1 || state.server !== server || state.publisher.toLowerCase() !== publisher.toLowerCase() || !Array.isArray(state.entries)) throw Error('ARKIV_PUBLISHER_STATE_BINDING_CHANGED')
  return state
}
