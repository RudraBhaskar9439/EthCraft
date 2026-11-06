import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseAbi } from '../../backend/node_modules/viem/_esm/index.js'
import { createBankHealthPublisher } from '../../backend/src/bank/health-publisher.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID()
const directory = join(root, 'evidence/runs/bank-health', runId)
await mkdir(directory, { recursive: true })
const abi = parseAbi(['function publish(uint64,bool,uint64)', 'function sequence() view returns(uint64)',
  'function available() view returns(bool)', 'function validUntil() view returns(uint64)',
  'event StatePublished(bytes32 indexed marketId,uint64 sequence,bool healthy,uint64 validUntil)'])
const manifest = { deploymentId: 'health-test', stateRegistry: '0x0000000000000000000000000000000000000001',
  roles: { publisher: '0x0000000000000000000000000000000000000002' }, maxGas: 100000, maxNativeCostWei: '100000' }
const rows = new Map(), store = { async get(d,k) { return rows.get(d+':'+k) || null }, async put(d,k,v) { rows.set(d+':'+k,structuredClone(v)) }, async lock(d,k,work) { return work() } }
let clock = 1000, sequence = 0n, expiry = 0, loss = true, reverted = false, prepares = [], signs = 0
const intents = new Map()
const client = { async getBlock() { return { timestamp: BigInt(clock) } },
  async readContract({ functionName }) { return functionName === 'sequence' ? sequence : functionName === 'validUntil' ? BigInt(expiry) : expiry > clock } }
const publisher = {
  async prepare(input) { const old=intents.get(input.operationId);if(old)assert.equal(old.data,input.data);else{intents.set(input.operationId,input);signs++}prepares.push(input) },
  async broadcast() { if(loss){loss=false;throw Error('lost submitted reply')} },
  async reconcile({operationId}) { if(reverted)return {status:'reverted',hash:'0x'+'a'.repeat(64)};return {status:'confirmed',hash:'0x'+'b'.repeat(64)} }
}
const reader = { async transaction({ match }) { sequence=BigInt(match.sequence);expiry=match.validUntil;return {confirmed:true,blockNumber:'4',blockHash:'0x'+'c'.repeat(64)} } }
const open = () => createBankHealthPublisher({ store, manifest, client, abi, publisher, reader, native:async()=>({available:true}), now:()=>clock*1000 })
const checks=[]
try {
  await assert.rejects(open().publish(), /lost submitted reply/)
  const first=prepares[0];clock+=25
  await open().publish()
  assert.equal(prepares[1].data,first.data);assert.equal(prepares[1].operationId,first.operationId);assert.equal(signs,1)
  checks.push('Lost submitted reply and recreation reuse the original signed report and expiry.')
  await open().publish();assert.equal(signs,1)
  checks.push('A sufficiently fresh report does not sign another publication.')
  clock=expiry;assert.equal((await open().status()).available,false)
  checks.push('A report at exact expiry is displayed unavailable.')
  reverted=true
  await assert.rejects(open().publish(), /BANK_HEALTH_REVERT_RECORDED_REFRESH_TO_RETRY/)
  const failed=prepares.at(-1);assert.equal(rows.get('health-test:bank:health-publication').status,'reverted')
  reverted=false;clock+=1;await open().publish()
  assert.notEqual(prepares.at(-1).operationId,failed.operationId)
  assert.equal(rows.get('health-test:bank:health-publication:'+failed.operationId).status,'reverted')
  checks.push('A canonical revert is retained and a later explicit retry has a distinct operation identity.')
  const source='backend/src/bank/health-publisher.mjs'
  const report={status:'pass',runId,scope:'In-memory publisher fault fixtures; no chain transactions, browser access or keys.',checks,
    sourceHashes:{[source]:createHash('sha256').update(await readFile(join(root,source))).digest('hex')}}
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({status:'pass',checks:checks.length,evidence:directory}))
}catch(error){await writeFile(join(directory,'report.json'),JSON.stringify({status:'fail',checks,error:error.message},null,2));throw error}
