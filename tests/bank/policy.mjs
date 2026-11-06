// Policy-template validation only; no Privy application or network calls.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildPrivyBankPolicies } from '../../backend/src/bank/managed-policy.mjs'
const manifest = JSON.parse(await readFile(new URL('../../.local/bank/public-deployment.json', import.meta.url), 'utf8'))
const owner = '0x' + '1'.repeat(40), loanId = '0x' + '2'.repeat(64), workId = '0x' + '3'.repeat(64)
const result = await buildPrivyBankPolicies(manifest, { walletAddress: owner, loanIds: [loanId], workIds: [workId], workers: ['0x' + '4'.repeat(40)] })
for (const rule of result.player.rules) {
  assert.equal(rule.method, 'eth_signTransaction')
  assert.ok(rule.conditions.some(value => value.field_source === 'ethereum_transaction' && value.field === 'chain_id' && value.value === '1301'))
  assert.ok(rule.conditions.some(value => value.field_source === 'ethereum_transaction' && value.field === 'value' && value.value === '0'))
  assert.ok(rule.conditions.some(value => value.field_source === 'ethereum_calldata' && value.abi.length === 1))
}
assert.ok(result.player.rules.filter(rule => rule.name.includes('exact output')).every(rule => rule.conditions.some(value => value.field === 'swapExactOutput.maxAmountIn' && value.operator === 'lte')))
assert.equal(result.player.rules.find(rule => rule.name === 'Return collateral to its signer').conditions.find(value => value.field === 'claimCollateral.recipient').value, owner)
const empty = await buildPrivyBankPolicies(manifest, { walletAddress: owner })
assert.equal(empty.player.rules.some(rule => rule.name === 'Scoped repay' || rule.name === 'Bounded funded work'), false)
console.log(JSON.stringify({ status: 'pass', checks: 4, rules: result.player.rules.length, scope: 'Unapplied Privy policy template; SDK provider not contacted' }))
