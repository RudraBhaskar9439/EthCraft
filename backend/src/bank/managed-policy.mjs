import { getAddress } from 'viem'
import { validateBankManifest } from './canonical.mjs'
import { loadBankAbis } from './abis.mjs'

/** Policy template only. Applying a new version requires reconciled old intents. */
export async function buildPrivyBankPolicies(input, { walletAddress, loanIds = [], workIds = [], workers = [], abis: suppliedAbis } = {}) {
  const manifest = validateBankManifest(input), owner = getAddress(walletAddress).toLowerCase()
  if ([...loanIds, ...workIds].some(value => !/^0x[a-f0-9]{64}$/i.test(value))) throw Error('BANK_POLICY_BOUND_IDENTIFIERS_REQUIRED')
  const abis = suppliedAbis || await loadBankAbis()
  const transaction = (field, value) => ({ field_source: 'ethereum_transaction', field, operator: 'eq', value })
  const parameter = (target, method, field, operator, value) => ({ field_source: 'ethereum_calldata',
    abi: abis[target].filter(item => item.type === 'function' && item.name === method), field: method + '.' + field, operator, value })
  const rule = (name, target, conditions) => ({ name, method: 'eth_signTransaction', action: 'ALLOW', conditions: [
    transaction('chain_id', '1301'), transaction('to', manifest[target]), transaction('value', '0'), ...conditions
  ] })
  const amountCap = name => name === 'usdc' ? String(BigInt(manifest.maxUsdcAmountBaseUnits) * 101n / 100n) : manifest.maxCityAmountBaseUnits
  const rules = []
  for (const [name, spenders] of [['usdc', ['bank', 'router']], ['city', ['router', 'market', 'workEscrow']], ['gem', ['router']]]) {
    rules.push(rule('Bounded ' + name + ' approval', name, [parameter(name, 'approve', 'spender', 'in', spenders.map(key => manifest[key])), parameter(name, 'approve', 'amount', 'lte', amountCap(name))]))
  }
  rules.push(rule('One owned collateral approval', 'registry', [parameter('registry', 'approve', 'to', 'eq', manifest.bank), parameter('registry', 'approve', 'tokenId', 'gte', '1')]))
  for (const inputToken of ['city', 'usdc', 'gem']) for (const outputToken of ['city', 'usdc', 'gem'].filter(value => value !== inputToken)) {
    rules.push(rule('Bounded ' + inputToken + ' to ' + outputToken + ' exact output', 'router', [
      parameter('router', 'swapExactOutput', 'tokenIn', 'eq', manifest[inputToken]), parameter('router', 'swapExactOutput', 'tokenOut', 'eq', manifest[outputToken]),
      parameter('router', 'swapExactOutput', 'amountOut', 'gte', '1'), parameter('router', 'swapExactOutput', 'amountOut', 'lte', outputToken === 'usdc' ? manifest.maxUsdcAmountBaseUnits : manifest.maxCityAmountBaseUnits),
      parameter('router', 'swapExactOutput', 'maxAmountIn', 'lte', inputToken === 'usdc' ? manifest.maxUsdcAmountBaseUnits : manifest.maxCityAmountBaseUnits)
    ]))
  }
  for (const inputToken of ['city', 'usdc', 'gem']) rules.push(rule('Bounded item checkout using ' + inputToken, 'router', [
    parameter('router', 'buyWithSwap', 'tokenIn', 'eq', manifest[inputToken]), parameter('router', 'buyWithSwap', 'maxAmountIn', 'lte', inputToken === 'usdc' ? manifest.maxUsdcAmountBaseUnits : manifest.maxCityAmountBaseUnits),
    parameter('router', 'buyWithSwap', 'terms.price', 'gte', '1'), parameter('router', 'buyWithSwap', 'terms.price', 'lte', manifest.maxCityAmountBaseUnits)
  ]))
  if (loanIds.length) {
    for (const method of ['takeLoan', 'cancelOffer', 'repay', 'startAuction', 'settleAuction']) rules.push(rule('Scoped ' + method, 'bank', [parameter('bank', method, 'loanId', 'in', loanIds)]))
    rules.push(rule('Scoped funded auction bid', 'bank', [parameter('bank', 'bid', 'loanId', 'in', loanIds), parameter('bank', 'bid', 'amount', 'lte', manifest.maxUsdcAmountBaseUnits)]))
    rules.push(rule('Return collateral to its signer', 'bank', [parameter('bank', 'claimCollateral', 'loanId', 'in', loanIds), parameter('bank', 'claimCollateral', 'recipient', 'eq', owner)]))
  }
  rules.push(rule('Withdraw own bank credit to signer', 'bank', [parameter('bank', 'withdraw', 'recipient', 'eq', owner)]))
  if (workIds.length) {
    for (const method of ['acceptWork', 'refundWork']) rules.push(rule('Scoped ' + method, 'workEscrow', [parameter('workEscrow', method, 'workId', 'in', workIds)]))
    if (workers.length) rules.push(rule('Bounded funded work', 'workEscrow', [parameter('workEscrow', 'fundWork', 'workId', 'in', workIds),
      parameter('workEscrow', 'fundWork', 'worker', 'in', workers.map(value => getAddress(value).toLowerCase())), parameter('workEscrow', 'fundWork', 'amount', 'lte', manifest.maxCityAmountBaseUnits)]))
  }
  return { player: { version: '1.0', chain_type: 'ethereum', rules }, allowedTargets: [...new Set(rules.map(value => value.conditions.find(condition => condition.field === 'to').value))],
    disclosure: 'Unapplied policy template. Loan and work identifiers must be explicitly enrolled; lender and inspector authority is separate.' }
}
