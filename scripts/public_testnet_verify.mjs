import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, keccak256 } = require('viem')
const { unichainSepolia } = require('viem/chains')
const root = new URL('../', import.meta.url)
const deploymentBytes = await readFile(new URL('.local/public-testnet/deployment.json', root))
const deployment = JSON.parse(deploymentBytes)
assert.equal(deployment.environment, 'PUBLIC_TESTNET_SYNTHETIC_ONLY')
assert.equal(deployment.chainId, 1301)
assert.equal(deployment.rpcUrl, 'https://sepolia.unichain.org')
const client = createPublicClient({ chain: unichainSepolia, transport: http(deployment.rpcUrl, { retryCount: 0, fetchOptions: { headers: { 'User-Agent': 'AgentCity/0.1' } } }) })
assert.equal(await client.getChainId(), 1301)
assert.equal((await client.getBlock({ blockNumber: 0n })).hash, deployment.genesisHash)
const blockNumber = await client.getBlockNumber()
const abi = async name => JSON.parse(await readFile(new URL(`contracts/out/${name}.sol/${name}.json`, root), 'utf8')).abi
const read = async (address, contract, name, args = []) => client.readContract({ address, abi: await abi(contract), functionName: name, args, blockNumber })
const sameAddress = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase())
sameAddress(await read(deployment.creditToken, 'CreditToken', 'owner'), deployment.admin)
sameAddress(await read(deployment.creditToken, 'CreditToken', 'issuer'), deployment.issuer)
sameAddress(await read(deployment.kitCustody, 'KitCustody', 'issuer'), deployment.issuer)
sameAddress(await read(deployment.kitCustody, 'KitCustody', 'warehouse'), deployment.warehouse)
sameAddress(await read(deployment.stateRegistry, 'StateRegistry', 'publisher'), deployment.publisher)
sameAddress(await read(deployment.hook, 'AgentCityHook', 'registry'), deployment.stateRegistry)
sameAddress(await read(deployment.hook, 'AgentCityHook', 'poolManager'), deployment.poolManager)
sameAddress(await read(deployment.jobEscrow, 'JobEscrow', 'attestor'), deployment.attestor)
assert.equal(await read(deployment.kitCustody, 'KitCustody', 'bundleHash'), deployment.bundleHash)
assert.equal(await read(deployment.kitCustody, 'KitCustody', 'serverId'), deployment.serverId)
assert.equal(await read(deployment.kitCustody, 'KitCustody', 'backed'), true)
const supply = await read(deployment.kitCustody, 'KitCustody', 'totalSupply')
const pending = await read(deployment.kitCustody, 'KitCustody', 'pendingKits')
const quantities = []
for (let item = 0; item < 6; item++) {
  const bill = await read(deployment.kitCustody, 'KitCustody', 'bill', [BigInt(item)])
  const controlled = await read(deployment.kitCustody, 'KitCustody', 'controlledStock', [BigInt(item)])
  assert.ok(controlled * 10n ** 18n >= bill * (supply + pending * 10n ** 18n))
  quantities.push({ item, bill: bill.toString(), controlled: controlled.toString() })
}
const codeHashes = {}
for (const name of ['creditToken', 'kitCustody', 'stateRegistry', 'hook', 'procurement', 'jobEscrow']) {
  const code = await client.getCode({ address: deployment[name], blockNumber })
  assert.ok(code && code !== '0x')
  codeHashes[name] = keccak256(code)
}
for (const value of Object.values(deployment.official)) assert.equal(keccak256(await client.getCode({ address: value.address, blockNumber })), value.codeHash)
const directory = new URL(`evidence/runs/public-testnet-verification/${randomUUID()}/`, root)
await mkdir(directory, { recursive: true })
await writeFile(new URL('report.json', directory), JSON.stringify({ status: 'pass', chainId: 1301, observedBlock: blockNumber.toString(), scope: deployment.scope, deploymentFileSha256: createHash('sha256').update(deploymentBytes).digest('hex'),
  codeHashes, quantities, supply: supply.toString(), pending: pending.toString(), checks: ['chain/genesis identity', 'separate immutable roles and contract bindings', 'six-item circulating plus pending backing', 'official v4 deployment code hashes'], realMoneySpentUsd: 0 }, null, 2) + '\n')
console.log('PASS public deployment role, code and backing verification: ' + directory.pathname + 'report.json')
