import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createDiscordIdentity } from './identity.mjs'
import { createGameWalletView } from './game-wallet-view.mjs'
import { readDiscordConfiguration } from './settings.mjs'
import { loadPrivySettings, createTestnetWallets } from '../playable/testnet-wallets.mjs'
import { createPrivyTokenVerifier } from '../playable/wallet-auth.mjs'
import { PERSONAL_AGENT_NAMES } from '../playable/agents.mjs'

const rootDefault = fileURLToPath(new URL('../../../', import.meta.url))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
export async function discordPublicConfig(root = rootDefault) {
  const settings = await readDiscordConfiguration(root, { credentials: false })
  if (!settings) return { configured: false, walletSetupAvailable: false }
  const wallet = await json(join(root, '.local/playable-testnet/wallet-settings.json'))
  return { configured: Boolean(wallet.appId), appId: wallet.appId, applicationId: settings.applicationId, origin: settings.origin,
    walletSetupAvailable: settings.identityOnly !== true }
}

export async function openDiscordIdentityRuntime({ rootDirectory = rootDefault, pool: suppliedPool, pluginApi, agentsProvider } = {}) {
  const root = rootDirectory, settings = await readDiscordConfiguration(root, { credentials: false, required: true })
  const environment = suppliedPool ? null : await json(join(root, '.local/backend/environment.json'))
  const pool = suppliedPool || new pg.Pool({ connectionString: environment.databaseUrl, max: 4 })
  try {
    const { settings: walletSettings, credentials } = await loadPrivySettings(root, { requireProvider: false })
    const { PrivyClient } = await import('@privy-io/node')
    const privy = new PrivyClient({ appId: walletSettings.appId, appSecret: credentials.appSecret })
    const verifyPrivyToken = await createPrivyTokenVerifier({ appId: walletSettings.appId, appSecret: credentials.appSecret })
    const api = pluginApi || (async (path, body) => {
      const active = await json(join(root, '.local/playable-world/active.json'))
      if (active.owner !== 'agentcity-playable-pilot' || !/^agentcity-playable-[a-f0-9]{8}$/.test(active.container)) throw Error('OWNED_PLAYABLE_WORLD_REQUIRED')
      const token = (await readFile(join(root, '.local/playable-world', active.container, 'api-token'), 'utf8')).trim()
      const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw Error('DISCORD_GAME_SERVICE_UNAVAILABLE')
      return response.json()
    })
    const slots = async () => {
      if (agentsProvider?.()) return agentsProvider().status()
      const active = await json(join(root, '.local/playable-world/active.json'))
      return (await json(join(root, '.local/playable-world', active.container, 'personal-agents.json'))).agents
    }
    // In SDK0.37, get({id_token}) verifies an identity token; _get(DID) is the REST user lookup.
    const service = await createDiscordIdentity({ pool, appId: walletSettings.appId, origin: settings.origin, serverId: settings.serverId,
      verifyPrivyToken, loadPrivyUser: subject => privy.users()._get(subject),
      gameSession: ({ playerId }) => api('session?playerId=' + encodeURIComponent(playerId)),
      reserveJoin: value => api('discord/reserve', { ...value, discordId: value.discordUserId }),
      approveJoin: value => api('discord/approve', value),
      resolveScope: async ({ ownerId, agentId, plotId }) => {
        if (agentId !== plotId || !PERSONAL_AGENT_NAMES.includes(agentId)) return false
        const existing = (await slots()).find(slot => slot.name === agentId)
        return !existing || existing.ownerId === ownerId
      } })
    const gameWalletView=createGameWalletView({pool,identity:service,serverId:settings.serverId,gameSession:({playerId})=>api('session?playerId='+encodeURIComponent(playerId))})
    let wallets
    async function browserOwner(accessToken) {
      const claims = await verifyPrivyToken(accessToken)
      const user = await privy.users()._get(claims.subject)
      const discord = user.linked_accounts?.find(account => account.type === 'discord_oauth')
      if (!discord?.subject) throw Error('VERIFIED_DISCORD_ACCOUNT_REQUIRED')
      const owner = await service.getOwner(discord.subject)
      if (owner.privySubject !== claims.subject) throw Error('DISCORD_PRIVY_OWNER_CONFLICT')
      return owner
    }
    return { settings, service, pool, api, gameWalletView,
      async walletForAccessToken(accessToken) {
        if (settings.identityOnly === true) throw Error('DISCORD_WALLET_DISABLED_IN_IDENTITY_ONLY_MODE')
        const owner = await browserOwner(accessToken)
        if (!wallets) {
          const loaded = await loadPrivySettings(root)
          const manifest = await json(join(root, '.local/playable-testnet/market.json'))
          if (manifest.chainId !== 1301 || manifest.environment !== 'UNICHAIN_SEPOLIA_PLAYABLE') throw Error('DISCORD_TESTNET_WALLET_CONFIGURATION_REQUIRED')
          wallets = await createTestnetWallets({ pool, rootDirectory: root, provider: loaded.provider, environment: manifest.environment, chainId: manifest.chainId,
            rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, allowedTargets: loaded.settings.allowedTargets, allowBroadcast: false,
            maxNativeBudgetWei: loaded.settings.maxNativeBudgetWei || '8000000000000000' })
        }
        const wallet = await wallets.getOrCreate(owner.ownerId, { subject: owner.privySubject })
        const stored = (await pool.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1', [wallet.walletId])).rows[0]
        if (!stored?.provider_account_id) throw Error('MANAGED_WALLET_PROVIDER_RECEIPT_REQUIRED')
        await pool.query('INSERT INTO ac_discord_wallet_aliases(wallet_id,principal_id,address,provider_account_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [wallet.walletId, owner.ownerId, wallet.address, stored.provider_account_id])
        const alias = (await pool.query('SELECT * FROM ac_discord_wallet_aliases WHERE wallet_id=$1', [wallet.walletId])).rows[0]
        if (!alias || alias.principal_id !== owner.ownerId || alias.address.toLowerCase() !== wallet.address.toLowerCase() || alias.provider_account_id !== stored.provider_account_id) throw Error('DISCORD_WALLET_ALIAS_OWNER_CONFLICT')
        return { wallet, spendingAuthorized: false, message: 'Your managed testnet wallet is ready. This setup does not fund it or authorize transactions.' }
      },
      async pendingForOwner(owner) { return (await api('discord/pending')).pending.find(value => value.principalId === owner.ownerId && value.playerName?.toLowerCase() === owner.ownerName?.toLowerCase()) || null },
      async authorizeRemote(request) {
        if (settings.identityOnly === true) throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED')
        const discordUserId = request.session?.discordUserId
        if (request.session?.guildId !== settings.guildId) throw Error('DISCORD_GUILD_SESSION_REQUIRED')
        const owner = await service.getOwner(discordUserId)
        if (owner.ownerId !== request.ownerId || owner.ownerName !== request.ownerName) throw Error('DISCORD_REMOTE_OWNER_REQUIRED')
        const grant = await service.authorizeGrant({ discordUserId, grantId: request.grant?.grantId || request.grant?.id, ownerId: owner.ownerId,
          slotName: request.agentId, action: request.tool || request.action })
        await api('remote-grant', { ...grant, leaseExpiresAtMs: Math.min(grant.expiresAtMs, Date.now() + 5000) })
        return { ...grant, ...owner, ownerPlayerId: owner.minecraftPlayerId, offlineTasks: true }
      },
      async close() { if (!suppliedPool) await pool.end() }
    }
  } catch (error) { if (!suppliedPool) await pool.end(); throw error }
}
