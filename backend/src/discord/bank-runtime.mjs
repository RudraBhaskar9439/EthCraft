import { AsyncLocalStorage } from 'node:async_hooks'
import { createBankService } from '../bank/service.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail = code => { throw Error(code) }

/** Optional Discord adapter. No credentials or live Discord client are created. */
export async function createBankDiscordRuntime({ identity, service: injectedService, ...options } = {}) {
  if (typeof identity?.getOwner !== 'function') fail('BANK_DISCORD_IDENTITY_REQUIRED')
  const consent = new AsyncLocalStorage()
  const authorize = request => {
    const accepted = consent.getStore()
    return Boolean(accepted && ['principalId', 'operationId', 'termsDigest', 'confirmationId'].every(key => accepted[key] === request[key]))
  }
  const service = injectedService || await createBankService({ ...options, authorize })
  const present = value => ({ message: value.message || 'Review the exact bank terms. Testnet gas is additional.', operation: value,
    confirmation: value.status === 'preview' && !value.consented ? { kind: 'bank', operationId: value.operationId, termsDigest: value.termsDigest } : null })
  async function handleDiscord({ userId, operationId, action, args = {} }) {
    const owner = await identity.getOwner(userId)
    if (owner?.discordUserId !== userId || !UUID.test(owner.ownerId || '')) fail('BANK_DISCORD_OWNER_REQUIRED')
    const principalId = owner.ownerId
    if (['loans', 'history', 'credits', 'works'].includes(action)) return service[action]({ principalId })
    if (action === 'status') return present(await service.status({ principalId, operationId: args.operationId }))
    if (action === 'confirm' || action === 'retry') {
      const saved = await service.status({ principalId, operationId: args.operationId })
      if (action === 'retry' && !saved.consented) fail('BANK_CONFIRM_BEFORE_RETRY')
      const accepted = { principalId, operationId: saved.operationId, termsDigest: saved.termsDigest, confirmationId: operationId }
      return present(await consent.run(accepted, () => service.confirm(accepted)))
    }
    return present(await service.preview({ ...args, principalId, operationId, action }))
  }
  return { handleDiscord, service, authorize }
}
