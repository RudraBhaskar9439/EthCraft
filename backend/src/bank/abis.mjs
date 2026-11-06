import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const artifacts = {
  bank: 'AgentCityBank', router: 'BankPaymentRouter', workEscrow: 'AgentCityWorkEscrow',
  hook: 'AgentCityReputationHook', registry: 'WorldAssetRegistry', market: 'WorldAssetMarket',
  city: 'PlayableMarketToken', gem: 'PlayableMarketToken', usdc: 'BankTestUSDC',
  stateRegistry: 'StateRegistry', quoter: 'V4Quoter'
}

export async function loadBankAbis(rootDirectory = root) {
  return Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([name, artifact]) => {
    const value = JSON.parse(await readFile(resolve(rootDirectory, 'contracts/out', artifact + '.sol', artifact + '.json'), 'utf8'))
    if (!Array.isArray(value.abi)) throw Error('BANK_COMPILED_ABI_REQUIRED')
    return [name, value.abi]
  })))
}
