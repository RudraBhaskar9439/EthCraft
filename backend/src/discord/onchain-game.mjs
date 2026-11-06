import {parseSwapCommand} from '../playable/swap-request.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail = code => { throw Error(code) }
const directions = 'Sales and payments use CITY on Unichain Sepolia. Use /assets in Discord to register items, list or buy assets, and confirm transactions. Older escrowed stock can be withdrawn and claimed through /bazaar.'

// Human game commands use the same verified principal and managed wallet as
// Discord. Models may prepare a quote; only a real owner command confirms it.
export function createOnchainGameRuntime({ identity, serverId, native, worldAssets, recovery } = {}) {
  if (!identity?.getMinecraftOwner || !identity?.getOwner || !serverId || typeof native !== 'function' || !worldAssets?.handleDiscord) fail('ONCHAIN_GAME_CONFIGURATION_REQUIRED')
  async function boundOwner(event) {
    const playerId = event.actorPlayerId || event.playerId
    if (!UUID.test(playerId || '') || !UUID.test(event.connectionId || '')) fail('WORLD_ASSET_APPROVED_GAME_SESSION_REQUIRED')
    const mapped = await identity.getMinecraftOwner(serverId, playerId)
    const session = await native('session?playerId=' + playerId)
    if (!session.online || session.pendingAuthentication !== false || session.connectionId !== event.connectionId || session.principalId !== mapped.ownerId || !session.authenticationKind || session.authenticationKind === 'unverified_local_connection') fail('WORLD_ASSET_APPROVED_GAME_SESSION_REQUIRED')
    const owner = await identity.getOwner(mapped.discordUserId)
    if (owner.ownerId !== mapped.ownerId || owner.minecraftPlayerId?.toLowerCase() !== playerId.toLowerCase()) fail('WORLD_ASSET_PRIVY_MINECRAFT_BINDING_REQUIRED')
    return owner
  }
  async function handle(event) {
    if (['player_join', 'pay', 'sell', 'crypto_sell'].includes(event.action)) return directions
    if (event.action === 'jobs') return 'Your agent can build, gather, craft and deliver with actual materials. Use /assets in Discord for CITY item and estate sales; /work opens a separately reviewed work request.'
    const owner = await boundOwner(event), args = Array.isArray(event.args) ? event.args : []
    const invoke = (action, values = {}) => worldAssets.handleDiscord({ userId: owner.discordUserId, operationId: 'game:' + event.operationId, action, args: values })
    if (['balance', 'crypto_wallet', 'crypto_market'].includes(event.action)) return (await invoke('wallet')).message
    if (event.action === 'crypto_swap') {
      const result = ['confirm', 'retry'].includes(args[0])
        ? await invoke(args[0] === 'confirm' ? 'confirm_swap' : 'retry_swap', { operationId: args[1] })
        : await invoke('swap', parseSwapCommand(args))
      return result.message + (result.confirmation ? ` Review the quote, then /swap confirm ${result.confirmation.operationId}.` : '')
    }
    if (event.action === 'bazaar') {
      const action = args[0] || 'browse'
      if (action === 'browse') {
        const result = await invoke('browse')
        return [result.message, ...(result.assets || []).map(asset => `Asset ${asset.tokenId}: ${asset.kind === 'item' ? (asset.count ?? 1) + ' ' + (asset.item || asset.descriptor?.material || 'item') : 'estate ' + asset.parcelId}. Review /assets in Discord.`)].join(' | ')
      }
      if (['cancel', 'claim', 'retry'].includes(action)) {
        if (!recovery?.handleGame) fail('ITEM_RECOVERY_SERVICE_UNAVAILABLE')
        const result = await recovery.handleGame(event)
        return [result.message, ...(result.mailboxes || []).map(entry => `${entry.count} ${entry.item}: /bazaar claim ${entry.mailboxId}`)].join(' | ')
      }
      return directions
    }
    return directions
  }
  return { handle, boundOwner }
}

export function createOnchainAgentMarketRuntime({worldAssets,agents,resolveDiscordUser}={}) {
  if(!worldAssets?.handleDiscord||!agents?.status||!agents?.getBot||typeof resolveDiscordUser!=='function')fail('ONCHAIN_AGENT_CONFIGURATION_REQUIRED')
  return {async handle(event,step) {
    if(!['wallet','swap','market'].includes(step.action))fail('ONCHAIN_AGENT_PREVIEW_ONLY')
    const userId=await resolveDiscordUser(event.playerId)
    if(!userId)fail('WORLD_ASSET_VERIFIED_DISCORD_REQUIRED')
    let action=step.action,args={}
    if(action==='market') {
      const slot=agents.status().find(slot=>slot.ownerId===event.playerId&&slot.connected),bot=agents.getBot(event.playerId)
      if(!slot||bot?.username!==slot.name)fail('WORLD_ASSET_OWN_AGENT_REQUIRED')
      const item=bot.inventory.items().find(item=>item.name===String(step.item||'').replace(/^minecraft:/,'')&&item.count>=step.count)
      if(!item)return{complete:false,message:'The agent does not carry the requested resource lot. Gather the actual items before preparing its on-chain registration.'}
      const nativeSlot=item.slot>=36&&item.slot<=44?item.slot-36:item.slot
      if(!Number.isInteger(nativeSlot)||nativeSlot<0||nativeSlot>35)fail('WORLD_ASSET_NATIVE_SOURCE_REQUIRED')
      action='register_item';args={source:'agent',slot:nativeSlot,count:step.count}
    }else if(action==='swap')args={amount:step.amountIn,tokenIn:step.tokenIn,tokenOut:step.tokenOut}
    const result=await worldAssets.handleDiscord({userId,operationId:'agent:'+event.operationId,action,args})
    const approval=action==='register_item'?` Review /assets action:status operation:${result.operation?.operationId} in Discord and explicitly confirm. After registration, set and confirm a CITY listing price.`:result.confirmation?` Review and confirm the quote yourself with /swap confirm ${result.confirmation.operationId}.`:''
    return{complete:action==='wallet',message:result.message+approval}
  }}
}
