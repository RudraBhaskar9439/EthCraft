import { Client, GatewayIntentBits, Partials, Events, REST, Routes, PermissionsBitField, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, AttachmentBuilder, SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js'
import { createHash, randomUUID } from 'node:crypto'
import { formatUnits } from 'viem'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { createWorkOrders } from './work-orders.mjs'
import { createServerExperience } from './server-experience.mjs'
import { PERSONAL_AGENT_NAMES } from '../playable/agents.mjs'

const snowflake = /^[0-9]{5,22}$/
const compact = text => String(text || '').slice(0, 1900)
const nonce = value => BigInt('0x' + createHash('sha256').update(value).digest('hex').slice(0, 15)).toString()
const physicalTools = ['status', 'inspect', 'screenshot', 'build', 'collect', 'deliver', 'gather', 'craft', 'wait']
const bankActions = ['loans','history','credits','works','offer','borrow','cancel_offer','repay','auction','bid','settle','claim','withdraw','swap','checkout','workfund','workaccept','workrefund','status','retry']
export function discordRequestDiagnostic(error, interaction, stage, receivedAt = Date.now()) {
  const code = String(error.code || error.message || '')
  return { code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'DISCORD_REQUEST_UNAVAILABLE',
    command: /^[a-z_]{1,32}$/.test(interaction.commandName || '') ? interaction.commandName : 'control', stage,
    elapsedMs: Math.max(0, Date.now() - receivedAt),
    receivedAgeMs: Number.isFinite(interaction.createdTimestamp) ? Math.max(0, receivedAt - interaction.createdTimestamp) : null,
    httpStatus: Number.isInteger(error.status) ? error.status : null }
}
export function discordFailureMessage(error) {
  if (error.message === 'DISCORD_IDENTITY_ONLY_ACTION_DISABLED') return 'This local session supports /start, /profile, /join and read-only /agents. Agent work, wallets and financial actions are disabled.'
  const code=error.code||error.message
  if(code==='MINECRAFT_CONNECTION_BINDING_MISMATCH')return 'The game connection does not match your reserved profile or has changed. Keep Minecraft connected with your reserved name, then use /join again and approve the fresh connection.'
  if(code==='BANK_RUNTIME_SETUP_PENDING')return 'The bank is not configured for this Discord host yet. No payment or signature was requested.'
  if(['BANK_OPERATION_OWNER_REQUIRED','BANK_DISCORD_OWNER_REQUIRED'].includes(code))return 'Use the registered account that owns this bank operation. No new payment was authorized.'
  if(code==='GAME_COINS_RETIRED')return 'Payments and new sales now use CITY on Unichain Sepolia. Use /assets to register held items, list or buy them. /bazaar cancel and claim only recover stock from older listings.'
  if(code==='WORLD_ASSET_CATALOG_PARCEL_REQUIRED')return 'Choose the numeric parcel ID shown by /assets action:parcels.'
  if(code==='escrow_supported_noncontainer_equipment_required'||code==='escrow_supported_asset_item_required')return 'Hold a supported plain resource, weapon, tool or armor item, or choose its exact inventory slot. Containers and nested inventory items are excluded.'
  if(code==='escrow_selected_item_changed')return 'The selected item changed after its preview. Inspect the original operation, then prepare a fresh exact-item preview if no stock was reserved.'
  if(code==='estate_house_snapshot_changed')return 'Your house changed since its on-chain snapshot. Update its snapshot through /assets before preparing a listing.'
  if(['estate_current_owner_access_required','estate_current_owner_unlocked_parcel_required'].includes(code))return 'This estate requires current confirmed ownership and an unlocked parcel. Check /assets action:owned and the original listing status.'
  if(['WORLD_ASSET_RUNTIME_SETUP_PENDING','WORLD_ASSET_PROVIDER_POLICY_SETUP_REQUIRED'].includes(code))return 'The blockchain asset service is waiting for its verified contract, wallet-policy or game setup. Existing items and ownership are retained.'
  if(['WORLD_ASSET_EXISTING_MANAGED_WALLET_REQUIRED','WORLD_ASSET_VERIFIED_PROFILE_REQUIRED'].includes(code))return 'Finish /start wallet setup, then link and approve your Minecraft profile before registering blockchain assets.'
  if(code==='WORLD_ASSET_APPROVED_GAME_SESSION_REQUIRED')return 'Join Minecraft with your linked profile and approve the current connection with /join. Buying an already registered asset can be done while offline.'
  if(code==='WORLD_ASSET_FINISH_AGENT_TASK_FIRST')return 'Finish or safely cancel your agent’s unfinished task before registering its held item.'
  if(['WORLD_ASSET_NATIVE_FINGERPRINT_REQUIRED','WORLD_ASSET_EXACT_NATIVE_CUSTODY_REQUIRED'].includes(code))return 'The held item changed or could not be verified. Keep the original operation ID and inspect it before retrying.'
  if(code==='WORLD_ASSET_PREVIEW_EXPIRED')return 'That unsigned preview expired. Prepare a fresh preview before confirming.'
  if(['WORLD_ASSET_LIVE_EXACT_LISTING_REQUIRED','WORLD_ASSET_OWNER_OR_REVISION_CHANGED'].includes(code))return 'The asset owner or listing changed. Review its current chain state before preparing another purchase.'
  if(['WORLD_ASSET_RPC_STALE','WORLD_ASSET_CANONICAL_REORG'].includes(code))return 'Waiting for fresh canonical chain evidence. Keep your original operation; ownership and stock need reconciliation.'
  if(code==='escrow_insufficient_plain_items')return 'That inventory does not contain enough supported plain items. No listing was opened.'
  if(code==='escrow_mailbox_inventory_full')return 'Make room in your Minecraft inventory, then claim the same mailbox again. Your items remain in custody.'
  if(['ESCROW_ACTOR_RECONCILIATION_REQUIRED','ESCROW_INVENTORY_RECONCILIATION_REQUIRED','ESCROW_JOURNAL_UNAVAILABLE'].includes(code))return 'Inventory custody needs reconciliation. Keep the original listing or mailbox ID; no replacement item movement is authorized.'
  if(['MARKET_CURRENT_APPROVED_MINECRAFT_SESSION_REQUIRED','MARKET_GAME_CONNECTION_REQUIRED','MARKET_GAME_OWNER_REQUIRED'].includes(code))return 'Join Minecraft with your linked name and approve the connection with /join before using player inventory or claiming items. You can list an owned connected agent’s stock while your player is offline.'
  if(['GAME_MARKET_EXISTING_ACCOUNT_REQUIRED','MARKET_EXISTING_MINECRAFT_ACCOUNT_REQUIRED','MARKET_MINECRAFT_ALIAS_REQUIRED'].includes(code))return 'Join and approve your Minecraft profile first so the marketplace can use your existing Game Coin account.'
  if(code==='GAME_MARKET_INSUFFICIENT_GAME_COINS')return 'You do not have enough available Game Coins for this lot.'
  if(code==='GAME_MARKET_CANNOT_BUY_OWN_LISTING')return 'This is your own listing. Another player can buy it; you cannot buy it from yourself. To withdraw it, use /bazaar action:cancel with its listing ID, then /bazaar action:claim to collect the returned stock.'
  if(['GAME_MARKET_LOT_NOT_AVAILABLE','GAME_MARKET_ONLY_OPEN_LOT_CAN_CANCEL'].includes(code))return 'That lot is no longer available for this action. Open /bazaar browse for current listings.'
  if(code==='GAME_MARKET_QUOTE_EXPIRED')return 'The purchase quote expired. Preview the listing again before confirming.'
  if(code==='GAME_MARKET_RESERVED_FUNDS_RECONCILIATION_REQUIRED')return 'This purchase has reserved coins and needs reconciliation. Retry the original purchase; do not create a replacement.'
  if(code==='MARKET_FINISH_OR_RECONCILE_AGENT_TASK_FIRST')return 'Your agent still has unfinished work. Finish or safely cancel that task before listing its carried items.'
  if(code==='MARKET_CONNECTED_OWN_AGENT_REQUIRED')return 'Your own agent must be connected before its inventory can supply a listing.'
  if(code==='GAME_MARKET_BOUNDED_FULL_LOT_TERMS_REQUIRED')return 'Choose a supported item, 1–64 items, and a positive whole Game Coin price for the complete lot.'
  if(code==='DISCORD_PRIVY_LINK_REQUIRED')return 'Use /start to verify your Discord and Privy account first.'
  if(['EXISTING_MINECRAFT_OWNER_LOGIN_REQUIRED','MINECRAFT_ALIAS_OWNER_CONFLICT','MINECRAFT_NAME_ALREADY_RESERVED'].includes(code))return 'That Minecraft name belongs to an existing account. For your new account, choose a fresh name such as Ruddy2 with /profile, and use that exact name in your launcher.'
  if(code==='MINECRAFT_RESERVATION_INVALID')return 'Use /profile with a Minecraft name containing 3–16 letters, numbers or underscores, and choose the Local login route.'
  if(['MINECRAFT_RESERVATION_RELINK_REQUIRES_REVIEW','MINECRAFT_ACCOUNT_KIND_MIGRATION_REQUIRES_REVIEW'].includes(code))return 'This account already has a Minecraft profile. Ask the operator to review a profile change before reserving another name.'
  if(/^[A-Z_]+$/.test(error.message||''))return 'This request needs account setup, valid permissions or an available agent. Use /start and /agents to review your profile.'
  return compact(error.message||'The request could not complete. Your recorded task and materials were retained.')
}
const row = buttons => new ActionRowBuilder().addComponents(buttons)
const button = (id, text, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style)
const schema = `
CREATE TABLE IF NOT EXISTS ac_discord_commands (
 interaction_id text PRIMARY KEY,discord_user_id text NOT NULL,owner_id uuid,action text NOT NULL,
 request jsonb NOT NULL,response text,status text NOT NULL DEFAULT 'received',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_discord_notifications (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,message text NOT NULL,attachment_path text,metadata jsonb,
 status text NOT NULL DEFAULT 'queued',discord_message_id text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ac_discord_work_requests (
 id uuid PRIMARY KEY,interaction_id text NOT NULL UNIQUE,requester_id uuid NOT NULL,target_owner_id uuid NOT NULL,
 target_agent text,specification text NOT NULL,state text NOT NULL DEFAULT 'requested',quote jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(requester_id<>target_owner_id)
);`

export function discordCommands({ bankEnabled = false, identityOnly = false } = {}) {
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Set up your AgentCity identity and existing Privy account'),
    new SlashCommandBuilder().setName('agents').setDescription('Open the server agent directory and your agent controls'),
    new SlashCommandBuilder().setName('agent').setDescription('Talk to your personal agent').addStringOption(o => o.setName('message').setDescription('Your task, question or screenshot request').setRequired(true).setMaxLength(500)),
    new SlashCommandBuilder().setName('profile').setDescription('Choose your Minecraft name and login route').addStringOption(o => o.setName('name').setDescription('Minecraft/server username').setRequired(true).setMinLength(3).setMaxLength(16)).addStringOption(o => o.setName('login').setDescription('Your login route').setRequired(true).addChoices({ name: 'Local / TLauncher compatible', value: 'local' }, { name: 'Microsoft Minecraft account', value: 'microsoft' })),
    new SlashCommandBuilder().setName('join').setDescription('Review and approve your pending Minecraft connection'),
    new SlashCommandBuilder().setName('work').setDescription('Request work from a registered player or another player\'s agent').addStringOption(o => o.setName('request').setDescription('Describe the work').setRequired(true).setMaxLength(500)).addUserOption(o => o.setName('person').setDescription('Registered human participant')).addStringOption(o => o.setName('agent').setDescription('Agent from the directory').setAutocomplete(true)),
    new SlashCommandBuilder().setName('worklist').setDescription('Review incoming requests and quotes'),
    new SlashCommandBuilder().setName('offer').setDescription('Quote work in CITY; funding is a separate step').addStringOption(o=>o.setName('job').setDescription('Work request ID').setRequired(true)).addStringOption(o=>o.setName('price').setDescription('Exact CITY price').setRequired(true)).addStringOption(o=>o.setName('asset').setDescription('Quoted unit').setRequired(true).addChoices({name:'CITY testnet tokens',value:'CITY'})).addStringOption(o=>o.setName('scope').setDescription('Exact work and material responsibilities').setRequired(true).setMaxLength(500)),
    new SlashCommandBuilder().setName('wallet').setDescription('Open secure wallet setup; no secrets or signing keys in chat'),
    new SlashCommandBuilder().setName('assets').setDescription('Blockchain items, estate deeds and Uniswap testnet payments')
      .addStringOption(o=>o.setName('action').setDescription('Review an asset action').setRequired(true).addChoices(...[
        ['Browse assets','browse'],['My assets','owned'],['My testnet balances','wallet'],['Estate parcel catalog','parcels'],['Request one-time test funds','fund'],['Register held item','register_item'],['Claim estate land','claim_land'],['Update my house snapshot','snapshot'],['List my asset','list'],['Preview purchase','buy'],['Cancel listing','cancel'],['Redeem item to game mailbox','redeem'],['Swap testnet tokens','swap'],['Operation status','status'],['Retry original operation','retry'],['Refresh land permissions','sync']
      ].map(([name,value])=>({name,value}))))
      .addStringOption(o=>o.setName('asset').setDescription('Blockchain asset token ID').setMaxLength(78))
      .addStringOption(o=>o.setName('price').setDescription('Total listing price in CITY test tokens').setMaxLength(40))
      .addStringOption(o=>o.setName('parcel').setDescription('Estate parcel ID from the catalog').setMaxLength(64))
      .addStringOption(o=>o.setName('source').setDescription('Inventory holding the exact item').addChoices({name:'My main hand',value:'player'},{name:'My agent main hand',value:'agent'}))
      .addIntegerOption(o=>o.setName('slot').setDescription('Optional exact inventory slot: hotbar 0–8, inventory 9–35').setMinValue(0).setMaxValue(35))
      .addIntegerOption(o=>o.setName('count').setDescription('Exact resource lot quantity 1–64; equipment must be 1').setMinValue(1).setMaxValue(64))
      .addStringOption(o=>o.setName('operation').setDescription('Original operation or preview ID').setMaxLength(100))
      .addStringOption(o=>o.setName('amount').setDescription('Input amount, or output amount in receive mode').setMaxLength(40))
      .addStringOption(o=>o.setName('token').setDescription('Swap input token').addChoices({name:'GEM to CITY',value:'GEM'},{name:'CITY to GEM',value:'CITY'}))
      .addStringOption(o=>o.setName('mode').setDescription('Spend a fixed amount or receive a fixed amount').addChoices({name:'Spend exact input',value:'exact_input'},{name:'Receive exact output',value:'exact_output'}))
      .addStringOption(o=>o.setName('maximum').setDescription('Optional maximum input-token spend in receive mode').setMaxLength(40)),
    new SlashCommandBuilder().setName('bazaar').setDescription('Browse CITY assets or recover previously escrowed items')
      .addStringOption(o=>o.setName('action').setDescription('Marketplace action').setRequired(true).addChoices({name:'Browse CITY assets',value:'browse'},{name:'Withdraw an older listing',value:'cancel'},{name:'Claim purchased or returned items',value:'claim'}))
      .addStringOption(o=>o.setName('listing').setDescription('Listing ID to buy or cancel').setMaxLength(36))
      .addStringOption(o=>o.setName('mailbox').setDescription('Mailbox ID to claim').setMaxLength(36))
  ]
  if (bankEnabled) commands.push(new SlashCommandBuilder().setName('bank').setDescription('Review testnet loans, swaps and funded work; every payment needs confirmation')
    .addStringOption(o => o.setName('action').setDescription('Bank action').setRequired(true).addChoices(...bankActions.map(value => ({ name: value.replaceAll('_', ' '), value }))))
    .addUserOption(o => o.setName('borrower').setDescription('Registered Discord member receiving the loan'))
    .addUserOption(o => o.setName('worker').setDescription('Registered Discord member doing the quoted work'))
    .addStringOption(o => o.setName('loan').setDescription('Exact loan ID from /bank loans').setMaxLength(66))
    .addStringOption(o => o.setName('asset').setDescription('Collateral or purchase asset token ID').setMaxLength(78))
    .addStringOption(o => o.setName('operation').setDescription('Original operation ID for status or retry').setMaxLength(80))
    .addStringOption(o => o.setName('principal').setDescription('Loan principal in test USDC').setMaxLength(40))
    .addStringOption(o => o.setName('repayment').setDescription('Total repayment in test USDC, including interest').setMaxLength(40))
    .addStringOption(o => o.setName('valuation').setDescription('Collateral valuation in test USDC').setMaxLength(40))
    .addIntegerOption(o => o.setName('term').setDescription('Loan duration in seconds').setMinValue(60).setMaxValue(2592000))
    .addIntegerOption(o => o.setName('grace').setDescription('Repayment grace period in seconds').setMinValue(60).setMaxValue(604800))
    .addIntegerOption(o => o.setName('expiry').setDescription('Loan offer expiry: Unix timestamp in seconds').setMinValue(1))
    .addIntegerOption(o => o.setName('auction_duration').setDescription('Default auction duration in seconds').setMinValue(60).setMaxValue(604800))
    .addStringOption(o => o.setName('reserve').setDescription('Minimum auction bid in test USDC').setMaxLength(40))
    .addStringOption(o => o.setName('amount').setDescription('Swap output amount, USDC bid, or CITY work payment').setMaxLength(40))
    .addStringOption(o => o.setName('token_in').setDescription('Token to spend').addChoices(...['CITY','USDC','GEM'].map(value => ({ name: value, value }))))
    .addStringOption(o => o.setName('token_out').setDescription('Token to receive in an exact-output swap').addChoices(...['CITY','USDC','GEM'].map(value => ({ name: value, value }))))
    .addStringOption(o => o.setName('maximum').setDescription('Maximum input tokens to spend, including slippage').setMaxLength(40))
    .addStringOption(o => o.setName('work').setDescription('Accepted work request ID').setMaxLength(100))
    .addIntegerOption(o => o.setName('deadline').setDescription('Work completion deadline: Unix timestamp in seconds').setMinValue(1))
    .addIntegerOption(o => o.setName('review').setDescription('Work review period in seconds').setMinValue(60).setMaxValue(604800)))
  return commands.map(command => command.toJSON()).filter(command => !identityOnly || ['start', 'profile', 'join', 'agents'].includes(command.name))
}

export function discordInvite(settings, { organize = false } = {}) {
  const permissions = new PermissionsBitField([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ReadMessageHistory,
    ...(organize ? [PermissionsBitField.Flags.ManageChannels,PermissionsBitField.Flags.ManageRoles] : [])])
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: settings.applicationId, scope: 'bot applications.commands', permissions: permissions.bitfield.toString(), guild_id: settings.guildId, disable_guild_select: 'true' })
}

export function identityOnlyInteractionAllowed(interaction) {
  if (interaction.isChatInputCommand()) return ['start', 'profile', 'join', 'agents'].includes(interaction.commandName)
  if (interaction.isButton()) return interaction.customId?.startsWith('ac:') && ['setup', 'directory', 'join'].includes(interaction.customId.split(':')[1])
  return interaction.isStringSelectMenu() && interaction.customId === 'ac:select'
}

export function agentPanel(slot, viewerOwnerId, { identityOnly = false } = {}) {
  const ownerLabel=slot.ownerName==='CompareClaude'?'CompareAgent':slot.ownerName
  if (identityOnly) return { embeds: [new EmbedBuilder().setColor(0x497ed0).setTitle(`${slot.name}${slot.provider === '0g' ? ' · 0G' : slot.provider === 'anthropic' ? ' · Agent' : ''} · ${ownerLabel}`)
    .setDescription('Read-only saved status. Agent ownership and the existing Minecraft worker are unchanged.')
    .addFields({ name: 'Latest saved work', value: slot.workflow ? `${slot.workflow.status} · ${slot.workflow.index}/${slot.workflow.steps.length} steps` : slot.tasks?.at(-1)?.status || 'No saved task status.' })], components: [] }
  const own = slot.ownerId === viewerOwnerId, workflow = slot.workflow
  const embed = new EmbedBuilder().setColor(own ? 0x37a77a : 0x497ed0).setTitle(`${slot.name} · ${ownerLabel}`)
    .setDescription(own ? 'Your agent. Chat, check supplies, request an actual world view, or control work while Minecraft is closed.' : 'Another player’s agent. Request work and agree terms before it acts.')
    .addFields({ name: 'State', value: `${slot.connected ? 'Connected' : 'Sleeping'} · ${slot.mode || 'waiting'}` },
      { name: 'Work', value: own && workflow ? `${workflow.status} · ${workflow.index}/${workflow.steps.length} steps` : 'Open a work request for availability.' })
  const components = own ? [row([button(`ac:ask:${slot.name}`, 'Chat / give task', ButtonStyle.Primary), button(`ac:status:${slot.name}`, 'Update'), button(`ac:screenshot:${slot.name}`, 'Screenshot')]),
    row([button(`ac:inspect:${slot.name}`, 'Supplies'), button(`ac:resume:${slot.name}`, 'Resume'), button(`ac:wait:${slot.name}`, 'Pause'), button(`ac:cancel:${slot.name}`, 'Cancel task', ButtonStyle.Danger)])]
    : [row([button(`ac:work:${slot.name}`, 'Request work', ButtonStyle.Primary)])]
  return { embeds: [embed], components, allowedMentions: { parse: [] } }
}

export function marketplaceReply(result) {
  const payload={content:compact(result.message||'Minecraft marketplace · Game Coins'),allowedMentions:{parse:[]},components:[]}
  const confirmation=result.confirmation
  if(confirmation){
    if(!/^[a-f0-9-]{36}$/i.test(confirmation.id)||!['confirm_listing','confirm_buy'].includes(confirmation.action))throw Error('MARKET_CONFIRMATION_INVALID')
    payload.components.push(row([button(`ac:market-${confirmation.action==='confirm_listing'?'listing':'buy'}:${confirmation.id}`,confirmation.action==='confirm_listing'?'Confirm listing':'Confirm purchase',ButtonStyle.Success)]))
  }
  const listings=(result.listings||[]).slice(0,5)
  if(listings.length){
    payload.embeds=listings.map(listing=>new EmbedBuilder().setColor(0x37a77a).setTitle(`${listing.count} ${listing.item}`.slice(0,100))
      .setDescription(`**${listing.price} Game Coins** for the full lot\nListing: \`${listing.listingId}\`\n${listing.state||'available'}`))
    for(const listing of listings)if(payload.components.length<5&&/^[a-f0-9-]{36}$/i.test(listing.listingId))payload.components.push(row([button(`ac:market-preview:${listing.listingId}`,'Preview purchase',ButtonStyle.Primary)]))
  }
  for(const mailbox of(result.mailboxes||[]).slice(0,5))if(payload.components.length<5)payload.components.push(row([button(`ac:market-claim:${mailbox.mailboxId}`,`Claim ${mailbox.count} ${mailbox.item}`.slice(0,80),ButtonStyle.Primary)]))
  if(result.mailbox?.mailboxId&&!confirmation&&payload.components.length<5)payload.components.push(row([button(`ac:market-claim:${result.mailbox.mailboxId}`,'Claim my items',ButtonStyle.Primary)]))
  return payload
}

export function worldAssetReply(result){
  const body={content:compact(result.message||'Blockchain world assets'),allowedMentions:{parse:[]},components:[]},fields=[]
  const operation=result.operation
  if(operation){
    const terms=operation.terms||{},asset=terms.asset,price=terms.price||terms.listing?.price
    fields.push({name:'Action',value:String(operation.action),inline:true},{name:'State',value:String(operation.status),inline:true})
    if(operation.tokenId||asset?.tokenId)fields.push({name:'Asset',value:String(operation.tokenId||asset.tokenId),inline:true})
    if(price)fields.push({name:'Total price',value:formatUnits(BigInt(price),18)+' CITY',inline:true})
    if(operation.action==='faucet')fields.push({name:'One-time disposable testnet grant',value:'100 CITY + 0.0001 test ETH. Review the destination before confirming.'})
    if(operation.action==='faucet'&&terms.recipient)fields.push({name:'Destination wallet',value:String(terms.recipient)})
    if(operation.maxNativeCostWei)fields.push({name:'Maximum gas allocation per transaction',value:formatUnits(BigInt(operation.maxNativeCostWei),18)+' test ETH. Approvals and settlement are separate transactions.'})
    if(terms.parcelId||terms.backing?.parcelId)fields.push({name:'Land and house',value:String(terms.parcelId||terms.backing.parcelId),inline:true})
    const descriptor=terms.nativePreview?.descriptor||terms.backing?.descriptor
    const count=terms.nativePreview?.count??terms.backing?.count
    if(count!==undefined)fields.push({name:'Exact lot quantity',value:String(count),inline:true})
    if(descriptor){
      const durability=Number.isFinite(descriptor.damage)&&Number.isFinite(descriptor.maxDurability)?`\nDurability: ${descriptor.maxDurability-descriptor.damage}/${descriptor.maxDurability}`:''
      const enchants=descriptor.enchants||descriptor.enchantments,details=enchants?'\nEnchantments: '+JSON.stringify(enchants):''
      fields.push({name:'Exact item',value:(`${descriptor.displayName||descriptor.customName||descriptor.name||descriptor.material||'Registered item'}\n${descriptor.material||''}${durability}${details}`).slice(0,1024)})
    }
    if(terms.nativePreview?.fingerprint||terms.backing?.fingerprint)fields.push({name:'Item fingerprint',value:String(terms.nativePreview?.fingerprint||terms.backing.fingerprint)})
    fields.push({name:'Operation',value:String(operation.operationId).slice(0,200)})
    const receipts=(operation.proofs||[]).filter(proof=>/^0x[a-f0-9]{64}$/i.test(proof.transactionHash||'')).slice(-3)
    if(receipts.length)fields.push({name:'Confirmed transactions',value:receipts.map(proof=>`[View receipt](https://sepolia.uniscan.xyz/tx/${proof.transactionHash})`).join('\n')})
    body.embeds=[new EmbedBuilder().setTitle('World asset · Unichain Sepolia').setColor(0x37a77a).addFields(fields)]
  }
  if(result.assets?.length){
    body.embeds=result.assets.slice(0,5).map(asset=>new EmbedBuilder().setTitle(`Asset ${asset.tokenId} · ${asset.kind}`).setDescription(`${asset.kind==='item'?(asset.count??1)+' × ':''}${asset.parcelId||asset.descriptor?.name||asset.descriptor?.material||'Exact backed item'}\n${asset.listing?.active?formatUnits(BigInt(asset.listing.priceBaseUnits),18)+' CITY · total lot price':'Not currently listed'}`.slice(0,1000)).setColor(0x37a77a))
    for(const asset of result.assets.filter(asset=>asset.listing?.active).slice(0,5))body.components.push(row([button(`ac:asset-buy:${asset.tokenId}`,'Preview asset '+asset.tokenId,ButtonStyle.Primary)]))
  }
  if(result.catalog){const entries=result.catalog.parcels||result.catalog.catalog||[];body.content=compact(body.content+'\n'+entries.map(p=>`${p.parcelId}: ${p.world||'estates'} · ${p.state||'catalog parcel'}`).join('\n'))}
  if(result.confirmation){const c=result.confirmation;body.components.push(row([button(`ac:asset-${c.kind==='swap'?'swap':c.kind==='faucet'?'fund':'confirm'}:${encodeURIComponent(c.operationId)}`,operation?.status==='preview'||c.kind==='swap'?'Confirm on testnet':'Retry original operation',ButtonStyle.Success)]))}
  return body
}

export function bankReply(result) {
  const body = { content: compact(result.message || 'AgentCity bank · testnet assets only. Gas is additional.'), allowedMentions: { parse: [] }, components: [] }
  const money = (value, token = 'USDC') => `${formatUnits(BigInt(value), token === 'USDC' ? 6 : 18)} ${token}`
  const fields = [], add = (name, value) => fields.push({ name, value: String(value).slice(0, 1024) })
  const loanFields = loan => {
    const terms = loan.loanTerms || loan.terms
    if (!terms || ['principal','repayment','tokenId','term','grace'].some(key => terms[key] === undefined)) throw Error('BANK_EXACT_LOAN_TERMS_REQUIRED')
    add('Loan principal', money(terms.principal)); add('Total repayment', money(terms.repayment))
    add('Collateral', `Asset ${terms.tokenId}\nOwnership nonce: ${terms.ownershipNonce}\nRevision: ${terms.revision}\nSnapshot: ${terms.snapshotHash}`)
    add('Loan duration / grace', `${terms.term} seconds / ${terms.grace} seconds`)
    add('Borrower wallet', terms.borrower)
    if (terms.valuation !== undefined) add('Collateral valuation', money(terms.valuation))
    if (terms.offerExpiry !== undefined) add('Offer expiry (Unix seconds)', terms.offerExpiry)
    if (terms.auctionDuration !== undefined) add('Auction duration / reserve', `${terms.auctionDuration} seconds / ${money(terms.auctionReserve)}`)
    if (loan.dueAt && String(loan.dueAt) !== '0') add('Repayment due (Unix seconds)', loan.dueAt)
  }
  const operation = result.operation
  if (operation) {
    const terms = operation.terms || {}
    add('Action / state', `${operation.action} / ${operation.status}`)
    add('Original operation', operation.operationId)
    if (terms.loanId) add('Loan ID', terms.loanId)
    if (['offer','borrow','cancel_offer','repay','auction','bid','settle','claim'].includes(operation.action)) loanFields(terms.loanTerms ? terms : terms.loan || {})
    if (['swap','checkout'].includes(operation.action)) {
      if (['amountOut','maximum','tokenIn','tokenOut','deadline'].some(key => terms[key] === undefined)) throw Error('BANK_EXACT_SWAP_TERMS_REQUIRED')
      add('Receive exactly', money(terms.amountOut, terms.tokenOut))
      add('Maximum input spend', money(terms.maximum, terms.tokenIn))
      add('Swap deadline (Unix seconds)', terms.deadline)
    }
    if (terms.checkout) add('Exact purchase', `Asset ${terms.checkout.tokenId}\nSeller: ${terms.checkout.seller}\nPrice: ${money(terms.checkout.price, 'CITY')}\nRevision: ${terms.checkout.revision}\nListing nonce: ${terms.checkout.listingNonce}`)
    if (terms.workId) add('Work ID', terms.workId)
    const work = terms.work || (operation.action === 'workfund' ? terms : null)
    if (work) {
      add('Work payment', money(work.amount, 'CITY')); add('Worker wallet', work.worker)
      add('Work deadline / review', `${work.workDeadline ?? work.deadline} / ${work.reviewPeriod} seconds`)
      add('Accepted work terms', work.termsHash)
      if (terms.resultHash || work.resultHash) add('Inspected result', terms.resultHash || work.resultHash)
    } else if (terms.amount !== undefined) add(operation.action === 'bid' ? 'Auction bid' : 'Withdrawable credit', money(terms.amount))
    if (operation.expiresAtMs) add('Preview expires', new Date(operation.expiresAtMs).toISOString())
    if (operation.disclosure) add('Approval context', operation.disclosure)
    if (result.confirmation) {
      const id = result.confirmation.operationId, customId = `ac:bank-confirm:${encodeURIComponent(id)}`
      if (typeof id !== 'string' || !id || id !== operation.operationId || customId.length > 100 || operation.status !== 'preview' || operation.consented) throw Error('BANK_CONFIRMATION_INVALID')
      body.components.push(row([button(customId, 'Confirm exact testnet terms', ButtonStyle.Success)]))
    }
  } else if (result.loans) {
    body.content = result.loans.length ? 'Your bank loans and visible default auctions · testnet only.' : 'No visible bank loans.'
    body.embeds = result.loans.slice(-5).map(loan => {
      const terms = loan.terms
      return new EmbedBuilder().setTitle(`Loan · ${loan.status}`).setDescription(`ID: ${loan.loanId}\nCollateral: asset ${terms.tokenId}\nPrincipal: ${money(terms.principal)}\nTotal repayment: ${money(terms.repayment)}\nDuration / grace: ${terms.term} / ${terms.grace} seconds`).setColor(0x37a77a)
    })
  } else if (result.works) {
    body.content = result.works.length ? 'Your funded work · testnet only.' : 'No funded work.'
    body.embeds = result.works.slice(-5).map(work => new EmbedBuilder().setTitle(`Work · ${work.status}`).setDescription(`ID: ${work.workId}\nPayment: ${money(work.amount, 'CITY')}\nWorker: ${work.worker}\nDeadline / review: ${work.deadline} / ${work.reviewPeriod} seconds`).setColor(0x37a77a))
  } else if (result.feePips !== undefined) {
    for (const [key, label] of Object.entries({ principalBorrowed:'Principal borrowed', principalRepaid:'Principal repaid', timelyPrincipalRepaid:'Principal repaid on time', badDebt:'Bad debt', activePrincipal:'Active principal' })) if (result[key] !== undefined) add(label, money(result[key]))
    add('Timely loans / defaults', `${result.timelyLoansRepaid} / ${result.defaults}`)
    add('Current swap fee', `${Number(result.feePips) / 10000}%`)
    add('History meaning', result.disclosure || 'Observed wallet history only; not a human credit score.')
  } else if (result.amountBaseUnits !== undefined) add('Withdrawable credit', money(result.amountBaseUnits))
  if (fields.length) body.embeds = [new EmbedBuilder().setTitle('Review exact bank terms · testnet').setColor(0x37a77a).addFields(fields)]
  return body
}

// Hosts inject a credentialed bank runtime; the bridge never creates operator wallets.
export async function createDiscordBridge({ settings, pool, identity, agents, screenshotDirectory, client, onReady, gameSession, restClient, marketplace, worldAssets, bank, experienceFactory = createServerExperience, allowLegacyGameCoinsFixture = false } = {}) {
  if (!settings || !pool?.query || !identity?.getOwner || !agents?.handleRemote) throw Error('DISCORD_BRIDGE_CONFIGURATION_REQUIRED')
  if (bank && typeof bank.handleDiscord !== 'function') throw Error('BANK_DISCORD_RUNTIME_REQUIRED')
  await pool.query(schema)
  const workOrders=await createWorkOrders({pool,allowLegacyGameCoinsFixture})
  client ||= new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] })
  let flushing = false, closed = false, ready = false, startupError = null, notificationError = null, experience
  const scheduleFlush=()=>{void flush().catch(error=>{notificationError=String(error.code||error.message||'DISCORD_NOTIFICATION_UNAVAILABLE').slice(0,200)})}
  const activeReplies=new Map()
  const ownerFor = async userId => {
    if (!snowflake.test(userId || '')) throw Error('DISCORD_USER_REQUIRED')
    return identity.getOwner(userId)
  }
  const inGuild = async userId => { await client.guilds.fetch(settings.guildId).then(guild => guild.members.fetch(userId)); return true }
  const slotFor = owner => agents.status().find(slot => slot.ownerId === owner.ownerId)
  async function setup(userId, interactionId) {
    const result = await identity.beginSetup({ discordUserId: userId, interactionId })
    return { content: settings.identityOnly ? 'Mac-only local test: open this link on the hosting Mac. Sign in to your existing Privy account or link Discord, then use /profile and /join. Agent tasks and wallet setup are disabled.' : 'Set up or link your AgentCity account in the secure browser page. If you already have a wallet, sign in to that existing account first, then link Discord. Return here when finished.',
      components: [row([new ButtonBuilder().setLabel('Open secure setup').setStyle(ButtonStyle.Link).setURL(result.loginUrl)])], allowedMentions: { parse: [] } }
  }
  async function grantFor(owner, action, operationId) {
    if (!owner.ownerName) throw Error('Choose your Minecraft/server name and login route with /profile before creating an agent.')
    const current = slotFor(owner), slotName = current?.name || PERSONAL_AGENT_NAMES.find(name => !agents.status().some(slot => slot.name === name))
    if (!slotName) throw Error(`All ${PERSONAL_AGENT_NAMES.length} personal-agent slots are occupied. Existing agents can still receive work requests.`)
    const grant = await identity.issueGrant({ discordUserId: owner.discordUserId, operationId: operationId + ':grant', agentId: slotName, slotName, plotId: slotName, tools: physicalTools, ttlMs: 3600000 })
    return { grant, session: { discordUserId: owner.discordUserId, guildId: settings.guildId } }
  }
  async function execute(userId, interactionId, action, args = '') {
    if (settings.identityOnly) throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED')
    await inGuild(userId)
    const owner = await ownerFor(userId)
    const original = (await pool.query('SELECT * FROM ac_discord_commands WHERE interaction_id=$1', [interactionId])).rows[0]
    if (original && (original.discord_user_id !== userId || original.action !== action || original.request.args !== args)) throw Error('DISCORD_COMMAND_ID_CONFLICT')
    if (original?.status === 'complete') return original.response
    await pool.query('INSERT INTO ac_discord_commands(interaction_id,discord_user_id,owner_id,action,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [interactionId, userId, owner.ownerId, action, { args }])
    const remote = await grantFor(owner, action, interactionId)
    const response = await agents.handleRemote({ operationId: 'discord:' + interactionId, ownerId: owner.ownerId, ownerName: owner.ownerName,
      action, args, ...remote })
    const message = typeof response === 'string' ? response : response?.message || 'Request accepted; use Update for observed progress.'
    await pool.query("UPDATE ac_discord_commands SET status='complete',response=$2 WHERE interaction_id=$1", [interactionId, message])
    return message
  }
  async function panel(userId) {
    await inGuild(userId)
    const owner = await ownerFor(userId), slots = agents.status(), own = slotFor(owner)
    if(experience&&own){const room=await experience.panel(owner);if(room)return room}
    const result = { content: settings.identityOnly ? 'Read-only saved agent directory. Existing demo ownership is preserved; agent work and financial controls are disabled.' : own ? 'Select an agent, or use your controls below.' : 'Create your agent when a slot is free, or request work from another registered agent.', allowedMentions: { parse: [] }, components: [] }
    if (slots.length) result.components.push(row([new StringSelectMenuBuilder().setCustomId('ac:select').setPlaceholder('Choose an agent').addOptions(slots.map(slot => ({ label: `${slot.name} · ${slot.ownerName}`.slice(0, 100), value: slot.name, description: settings.identityOnly ? 'Read saved task status' : slot.ownerId === owner.ownerId ? 'Your personal agent' : 'Request work from this player’s agent' })))]))
    if (settings.identityOnly) { const owned = slots.filter(slot => slot.ownerId === owner.ownerId); if (owned.length) result.embeds = owned.flatMap(slot => agentPanel(slot, owner.ownerId, { identityOnly: true }).embeds) }
    else if (own) { const p = agentPanel(own, owner.ownerId); result.embeds = p.embeds; result.components.push(...p.components) }
    else if (!settings.identityOnly) result.components.push(row([button('ac:create:self', 'Create my agent', ButtonStyle.Primary)]))
    return result
  }
  async function createWork(userId, interactionId, target, specification) {
    if (settings.identityOnly) throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED')
    await inGuild(userId)
    if(Boolean(target.agent)===Boolean(target.person))throw Error('Choose exactly one registered person or agent for this work request.')
    const requester = await ownerFor(userId)
    let targetOwner, slot
    if (target.agent) { slot = agents.status().find(value => value.name === target.agent); if (!slot) throw Error('Choose an agent from this server’s directory.'); targetOwner = slot.ownerId }
    else if (target.person) { await inGuild(target.person); targetOwner = (await ownerFor(target.person)).ownerId }
    if (!targetOwner || targetOwner === requester.ownerId || typeof specification !== 'string' || !specification.trim() || specification.length > 500) throw Error('Choose another registered participant and describe the work.')
    const record=await workOrders.createRequest({interactionId,requesterOwnerId:requester.ownerId,targetOwnerId:targetOwner,targetAgent:slot?.name||null,request:specification,sourcedDiscordId:userId})
    const room=experience?await experience.ensureJob(record):null
    await notifyOwner(targetOwner, `New work request ${record.id} from ${requester.ownerName}: ${specification}\nUse /worklist and /offer to reply. No permission or payment was granted by this request.`)
    return `Work request ${record.id} sent.${room?` Continue in <#${room.channelId}>.`:''} The recipient must agree the scope and price before work or payment. Paid-job settlement will be enabled separately.`
  }
  async function notifyOwner(ownerId, message, attachment) {
    if (settings.identityOnly) throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED')
    const identifier = randomUUID()
    if (attachment && (!screenshotDirectory || !resolve(attachment.file).startsWith(resolve(screenshotDirectory) + sep))) throw Error('DISCORD_SCREENSHOT_PATH_REFUSED')
    await pool.query('INSERT INTO ac_discord_notifications(id,owner_id,message,attachment_path,metadata) VALUES($1,$2,$3,$4,$5)', [identifier, ownerId, compact(message), attachment?.file || null, attachment?.metadata || null])
    scheduleFlush()
    return identifier
  }
  async function flush() {
    if (settings.identityOnly) return
    if (!ready || flushing || closed) return
    flushing = true
    try {
      const pending = (await pool.query(`SELECT n.*,i.discord_user_id FROM ac_discord_notifications n JOIN ac_discord_identities i ON i.principal_id=n.owner_id WHERE n.status='queued' ORDER BY n.created_at LIMIT 10`)).rows
      for (const item of pending) {
        try {
          await inGuild(item.discord_user_id)
          const payload = { content: compact(item.message), allowedMentions: { parse: [] }, nonce: nonce(item.id), enforceNonce: true }
          if (item.attachment_path) {
            if (!resolve(item.attachment_path).startsWith(resolve(screenshotDirectory) + sep)) throw Error('DISCORD_SCREENSHOT_PATH_REFUSED')
            const buffer = await readFile(item.attachment_path)
            if (buffer.length > 8 * 1024 * 1024 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('DISCORD_CAPTURE_INVALID')
            payload.files = [new AttachmentBuilder(buffer, { name: 'agent-work.png', description: `Observed world rendering, ${item.metadata?.observedAt || item.metadata?.capturedAt || 'capture time unavailable'}` })]
          }
          const routed=experience?await experience.deliver(item.owner_id,payload):null
          const sink=activeReplies.get(item.owner_id)
          if(!routed&&sink&&sink.expiresAt>Date.now()&&!sink.available())continue
          const sent = routed||(sink&&sink.expiresAt>Date.now()?await sink.send(payload):await(await client.users.fetch(item.discord_user_id)).send(payload))
          await pool.query("UPDATE ac_discord_notifications SET status='sent',discord_message_id=$2 WHERE id=$1", [item.id, sent.id])
        } catch (error) {
          // A blocked DM must not publish private work in a public channel.
          if (error.code === 50007) await pool.query("UPDATE ac_discord_notifications SET status='dm_blocked' WHERE id=$1", [item.id])
        }
      }
    } finally { flushing = false }
  }
  const modal = (id, title, label) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(row([new TextInputBuilder().setCustomId('message').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)]))
  async function interaction(interaction) {
    if (interaction.guildId && interaction.guildId !== settings.guildId || interaction.user?.bot) return
    const userId = interaction.user?.id
    if (!snowflake.test(userId || '')) return
    const receivedAt = Date.now()
    let stage = 'acknowledgement'
    try {
      if (settings.identityOnly && !identityOnlyInteractionAllowed(interaction)) {
        if (interaction.isAutocomplete()) { await interaction.respond([]); return }
        throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED')
      }
      if (interaction.isAutocomplete()) {
        await inGuild(userId)
        const owner = await ownerFor(userId), term = interaction.options.getFocused().toLowerCase()
        await interaction.respond(agents.status().filter(slot => slot.ownerId !== owner.ownerId && `${slot.name} ${slot.ownerName}`.toLowerCase().includes(term)).slice(0,25).map(slot => ({ name: `${slot.name} · ${slot.ownerName}`, value: slot.name }))); return
      }
      if (interaction.isButton() && /^ac:(ask|work):/.test(interaction.customId)) {
        const [,action,target] = interaction.customId.split(':')
        await inGuild(userId)
        const owner=await ownerFor(userId),slot=agents.status().find(value=>value.name===target)
        if(!slot||action==='ask'&&slot.ownerId!==owner.ownerId||action==='work'&&slot.ownerId===owner.ownerId)throw Error('Use your own agent controls, or Request work for another player’s agent.')
        await interaction.showModal(modal(`ac:${action}-submit:${target}`, action === 'ask' ? 'Talk to your agent' : 'Request agent work', 'What would you like done?')); return
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      stage = 'authorization'
      await inGuild(userId)
      try{const owner=await ownerFor(userId);activeReplies.set(owner.ownerId,{expiresAt:Date.now()+14*60000,available:()=>interaction.replied,send:payload=>interaction.followUp({...payload,flags:MessageFlags.Ephemeral})})}catch{}
      let response
      stage = 'command'
      if (interaction.isChatInputCommand()) {
        const name = interaction.commandName
        if (name === 'start' || name === 'wallet') response = await setup(userId, interaction.id)
        else if (name === 'agents') response = await panel(userId)
        else if (name === 'agent') response = await execute(userId, interaction.id, 'task', interaction.options.getString('message', true))
        else if(name==='assets'){
          if(!worldAssets)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
          const action=interaction.options.getString('action',true),token=interaction.options.getString('token')||'GEM'
          const args={tokenId:interaction.options.getString('asset'),price:interaction.options.getString('price'),parcelId:interaction.options.getString('parcel'),source:interaction.options.getString('source')||'player',slot:interaction.options.getInteger('slot'),count:interaction.options.getInteger('count'),operationId:interaction.options.getString('operation'),amount:interaction.options.getString('amount'),tokenIn:token,tokenOut:token==='CITY'?'GEM':'CITY',kind:interaction.options.getString('mode')||'exact_input',maxAmountIn:interaction.options.getString('maximum')||undefined}
          response=worldAssetReply(await worldAssets.handleDiscord({userId,operationId:'discord:'+interaction.id,action,args}))
        }
        else if (name === 'bank') {
          if (!bank) throw Error('BANK_RUNTIME_SETUP_PENDING')
          const action = interaction.options.getString('action', true)
          if (!bankActions.includes(action)) throw Error('BANK_ACTION_UNSUPPORTED')
          const args = {}
          for (const [option, field] of Object.entries({ loan:'loanId', asset:'tokenId', operation:'operationId', principal:'principal', repayment:'repayment', valuation:'valuation', reserve:'auctionReserve', amount:'amount', token_in:'tokenIn', token_out:'tokenOut', maximum:'maxAmountIn', work:'workId' })) {
            const value = interaction.options.getString(option)
            if (value !== null) args[field] = value
          }
          if (action === 'swap') { args.amountOut = args.amount; delete args.amount }
          for (const [option, field] of Object.entries({ term:'term', grace:'grace', expiry:'offerExpiry', auction_duration:'auctionDuration', deadline:'workDeadline', review:'reviewPeriod' })) {
            const value = interaction.options.getInteger(option)
            if (value !== null) args[field] = value
          }
          for (const role of ['borrower', 'worker']) {
            const selected = interaction.options.getUser(role)
            if (!selected) continue
            await inGuild(selected.id)
            const owner = await ownerFor(selected.id)
            if (owner?.discordUserId !== selected.id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.ownerId || '')) throw Error('BANK_DISCORD_OWNER_REQUIRED')
            args[role + 'PrincipalId'] = owner.ownerId
          }
          response = bankReply(await bank.handleDiscord({ userId, operationId: 'discord:' + interaction.id, action, args }))
        }
        else if(name==='bazaar'){
          const action=interaction.options.getString('action',true),args={}
          if(action==='browse'){
            if(!worldAssets)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
            response=worldAssetReply(await worldAssets.handleDiscord({userId,operationId:'discord:'+interaction.id,action:'browse',args:{}}))
          }else{
          if(!allowLegacyGameCoinsFixture&&!['cancel','claim'].includes(action))throw Error('GAME_COINS_RETIRED')
          if(!marketplace)throw Error('The item recovery service is waiting for inventory verification.')
          if(action==='list')Object.assign(args,{item:interaction.options.getString('item'),count:interaction.options.getInteger('count'),price:interaction.options.getString('price'),source:interaction.options.getString('source')||'player'})
          if(['buy','cancel'].includes(action))args.listingId=interaction.options.getString('listing')
          if(action==='claim')args.mailboxId=interaction.options.getString('mailbox')
          if(action==='list'&&(!args.item||!args.count||!args.price))throw Error('Choose an item, quantity and total Game Coin price to prepare a listing.')
          if(['buy','cancel'].includes(action)&&!args.listingId)throw Error('Choose a listing ID from /bazaar browse.')
          response=marketplaceReply(await marketplace.handleDiscord({userId,operationId:'discord:'+interaction.id,action,args}))
          }
        }
        else if (name === 'profile') {
          const login=interaction.options.getString('login',true)
          if(login==='microsoft'&&settings.microsoftLoginSupported!==true)throw Error('Microsoft account verification is unavailable on this local host. Microsoft and TLauncher clients can both use the Local server profile route with Discord approval. That route establishes your local profile only.')
          const result = await identity.reserveMinecraft({ discordUserId: userId, playerName: interaction.options.getString('name', true), accountKind: login })
          response = result.message || `Profile reserved for ${result.playerName || interaction.options.getString('name')}. Connect using the server instructions, then approve that pending connection with /join. Microsoft ownership stays pending until its authentication proof succeeds.`
        }
        else if (name === 'join') {
          const owner = await ownerFor(userId)
          const pending = await gameSession?.({ owner, pending: true })
          if (!pending?.online || !pending.connectionId) throw Error('No pending connection for your reserved username. Connect to the game first, then use /join.')
          response = { content: `Approve the current connection for **${pending.playerName}**? Only approve a connection you just initiated.`, components: [row([button(`ac:join:${pending.playerId}:${pending.connectionId}`, 'Approve my connection', ButtonStyle.Success)])] }
        } else if (name === 'work') response = await createWork(userId, interaction.id, { agent: interaction.options.getString('agent'), person: interaction.options.getUser('person')?.id }, interaction.options.getString('request', true))
        else if(name==='offer'){
          const owner=await ownerFor(userId),workId=interaction.options.getString('job',true)
          const quote=await workOrders.proposeQuote({workId,actorOwnerId:owner.ownerId,price:interaction.options.getString('price',true),asset:interaction.options.getString('asset',true),materials:{},scope:interaction.options.getString('scope',true)})
          if(experience)await experience.ensureJob(await workOrders.get({workId,actorOwnerId:owner.ownerId}))
          await notifyOwner(quote.recipientOwnerId,`Quote received for ${workId}: ${quote.price} ${quote.asset}. ${quote.scope}\nReview /worklist to accept the exact terms. Funding is a separate step.`)
          response=`Quote ${quote.quoteId} submitted. It does not authorize work or move funds.`
        }else if(name==='worklist'){
          const owner=await ownerFor(userId),items=await workOrders.list({actorOwnerId:owner.ownerId,limit:10})
          response={content:items.length?items.map(item=>`${item.workId}: ${item.state}\n${item.request}${item.quote?`\nQuote: ${item.quote.price} ${item.quote.asset} — ${item.quote.scope}`:''}`).join('\n\n').slice(0,1900):'No work requests yet.',components:[],allowedMentions:{parse:[]}}
          const incomingQuotes=items.filter(item=>item.requesterOwnerId===owner.ownerId&&item.state==='quoted'&&item.quote&&(allowLegacyGameCoinsFixture||item.quote.asset==='CITY')).slice(0,4)
          for(const item of incomingQuotes)response.components.push(row([button(`ac:accept:${item.workId}:${item.quote.quoteId}`,'Accept quoted terms',ButtonStyle.Success),button(`ac:decline:${item.workId}`,'Decline')]))
        }
      } else if (interaction.isStringSelectMenu() && interaction.customId === 'ac:select') {
        const owner = await ownerFor(userId), slot = agents.status().find(value => value.name === interaction.values[0])
        if (!slot) throw Error('This agent is no longer available.')
        response = agentPanel(slot, owner.ownerId, { identityOnly: settings.identityOnly })
      } else if (interaction.isButton()) {
        const [, action, target, connectionId] = interaction.customId.split(':')
        if (action === 'bank-confirm') {
          if (!bank) throw Error('BANK_RUNTIME_SETUP_PENDING')
          if (!target || connectionId) throw Error('BANK_CONFIRMATION_INVALID')
          response = bankReply(await bank.handleDiscord({ userId, operationId: 'discord:' + interaction.id, action: 'confirm', args: { operationId: decodeURIComponent(target) } }))
        }
        else if(action.startsWith('asset-')){
          if(!worldAssets)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
          const original=decodeURIComponent(target),selected=action==='asset-browse'?['browse',{}]:action==='asset-buy'?['buy',{tokenId:original}]:action==='asset-confirm'?['confirm',{operationId:original}]:action==='asset-swap'?['confirm_swap',{operationId:original}]:action==='asset-fund'?['confirm_fund',{operationId:original}]:null
          if(!selected)throw Error('WORLD_ASSET_ACTION_UNSUPPORTED')
          response=worldAssetReply(await worldAssets.handleDiscord({userId,operationId:'discord:'+interaction.id,action:selected[0],args:selected[1]}))
        }
        else if(action.startsWith('market-')){
          if(!marketplace)throw Error('The Minecraft marketplace is waiting for its inventory service.')
          const actions={'market-browse':['browse',{}],'market-listing':['confirm_listing',{listingId:target}],'market-preview':['buy',{listingId:target}],'market-buy':['confirm_buy',{purchaseId:target}],'market-cancel':['cancel',{listingId:target}],'market-claim':['claim',{mailboxId:target}]}
          const selected=actions[action];if(!selected)throw Error('MARKET_ACTION_INVALID')
          if(!allowLegacyGameCoinsFixture&&!['market-cancel','market-claim'].includes(action))throw Error('GAME_COINS_RETIRED')
          response=marketplaceReply(await marketplace.handleDiscord({userId,operationId:'discord:'+interaction.id,action:selected[0],args:selected[1]}))
        }
        else if (action === 'directory') response = await panel(userId)
        else if (action === 'setup') response = await setup(userId, interaction.id)
        else if (action === 'create') { response = await execute(userId, interaction.id, 'create'); response = { ...await panel(userId), content: compact(response) } }
        else if (action === 'join') { await identity.approveMinecraftJoin({ discordUserId: userId, playerId: target, connectionId }); response = 'Connection approved. Enter the game; wallet and account setup stay here in Discord.' }
        else if(action==='accept'){
          const owner=await ownerFor(userId),job=await workOrders.get({workId:target,actorOwnerId:owner.ownerId})
          if(job.activeQuoteId!==connectionId||job.quote?.quoteId!==connectionId)throw Error('That quote was revised. Review the current terms with /worklist.')
          const accepted=await workOrders.acceptQuote({workId:target,actorOwnerId:owner.ownerId,quoteId:connectionId,digest:job.quote.digest})
          if(experience)await experience.ensureJob(accepted)
          response='Terms accepted. This job is awaiting funding; no work or payment has started.'
          await notifyOwner(accepted.targetOwnerId,`Terms accepted for ${target}. Awaiting a funded work authorization; no payment or execution has occurred.`)
        }else if(action==='decline'){const owner=await ownerFor(userId);const declined=await workOrders.decline({workId:target,actorOwnerId:owner.ownerId,reason:'Declined through Discord'});if(experience)await experience.ensureJob(declined);response='Work offer declined. No funds moved.'}
        else if (['status','inspect','screenshot','wait','resume','cancel'].includes(action)) {
          const owner = await ownerFor(userId), own = slotFor(owner)
          if (!own || own.name !== target) throw Error('Only the owner can control this agent. Use Request work for another player’s agent.')
          response = await execute(userId, interaction.id, action === 'resume' ? 'task' : action, action === 'resume' ? 'Resume the saved task.' : '')
          if (action === 'screenshot') response += '\nThe captured image is sent privately by the bot. Enable DMs from this server to receive it.'
        }
      } else if (interaction.isModalSubmit()) {
        const [, kind, target] = interaction.customId.split(':'), message = interaction.fields.getTextInputValue('message')
        if (kind === 'work-submit') response = await createWork(userId, interaction.id, { agent: target }, message)
        else if (kind === 'ask-submit') {
          const owner = await ownerFor(userId)
          if (slotFor(owner)?.name !== target) throw Error('Only the owner can give this agent instructions.')
          response = await execute(userId, interaction.id, 'task', message)
        }
      }
      if (!response) throw Error('This control is no longer available. Open /agents again.')
      stage = 'reply'
      await interaction.editReply(typeof response === 'string' ? { content: compact(response), allowedMentions: { parse: [] } } : response)
    } catch (error) {
      console.warn('Discord request refused:', JSON.stringify(discordRequestDiagnostic(error, interaction, stage, receivedAt)))
      const message = discordFailureMessage(error)
      const deliveryFailed = error => console.warn('Discord error reply unavailable:', JSON.stringify(discordRequestDiagnostic(error, interaction, 'error_reply', receivedAt)))
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } }).catch(deliveryFailed)
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(deliveryFailed)
    }
  }
  client.on(Events.InteractionCreate, interaction)
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot || message.guildId && message.guildId !== settings.guildId || message.guildId && !message.mentions.has(client.user)) return
    if (settings.identityOnly) return
    try {
      const text = message.content.replace(/<@!?\d+>/g, '').trim()
      if (!text || text.length > 500) return
      const otherUsers = [...message.mentions.users.values()].filter(user => user.id !== client.user.id)
      if (otherUsers.length > 1) throw Error('Select one registered participant for a work request.')
      const response = otherUsers.length ? await createWork(message.author.id, message.id, { person: otherUsers[0].id }, text) : await execute(message.author.id, message.id, 'task', text)
      // Guild replies contain no private inventory or plan details.
      if (message.guildId&&!experience) await message.reply({ content: 'Your agent request was handled privately. Open /agents for controls and enable bot DMs for progress.', allowedMentions: { parse: [] } })
      await notifyOwner((await ownerFor(message.author.id)).ownerId, response)
    } catch { await message.reply({ content: 'Open /start and /agents to finish setup or review your agent permissions.', allowedMentions: { parse: [] } }).catch(() => {}) }
  })
  async function initializeReady() {
    if (client.user.id !== settings.applicationId) throw Error('DISCORD_BOT_APPLICATION_MISMATCH')
    const rest = restClient || new REST({ version: '10' }).setToken(settings.botToken)
    await rest.put(Routes.applicationGuildCommands(settings.applicationId, settings.guildId), { body: discordCommands({ bankEnabled: Boolean(bank), identityOnly: settings.identityOnly }) })
    if(closed)throw Error('DISCORD_BRIDGE_CLOSED')
    if (settings.identityOnly) {
      ready = true; startupError = null
      onReady?.({ botUserId: client.user.id, guildId: settings.guildId })
      return
    }
    if(settings.organizedServer===true && !settings.identityOnly){
      experience=await experienceFactory({settings,pool,client,agents,identity,executeOwner:execute,createWork,agentPanel,worldAssets})
      await experience.start()
    }else{
      const guild=await client.guilds.fetch(settings.guildId)
      const botMember=guild.members.me||await guild.members.fetch(client.user.id)
      const required=[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.EmbedLinks]
      const writable=channel=>channel&&channel.guildId===settings.guildId&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)&&channel.isTextBased()&&channel.permissionsFor(botMember)?.has(required)
      let channel
      if(settings.panelChannelId){channel=await client.channels.fetch(settings.panelChannelId);if(!writable(channel))throw Error('DISCORD_PANEL_CHANNEL_MISMATCH')}
      else{
        const channels=await guild.channels.fetch()
        channel=[...channels.values()].filter(writable).sort((a,b)=>Number(b.id===guild.systemChannelId)-Number(a.id===guild.systemChannelId)||(a.rawPosition??0)-(b.rawPosition??0)||a.id.localeCompare(b.id))[0]
        if(!channel)throw Error('DISCORD_WRITABLE_EXISTING_TEXT_CHANNEL_REQUIRED')
      }
      const previous = channel.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ReadMessageHistory)
        ? (await channel.messages.fetch({ limit: 30 })).find(message => message.author.id === client.user.id && message.embeds.some(embed => embed.footer?.text === 'agentcity-directory')) : null
      const directory = { embeds: [new EmbedBuilder().setTitle('AgentCity · Agent desk').setDescription('Set up your account, open the agent directory, and control your agent while Minecraft is closed.').setFooter({ text: 'agentcity-directory' })], components: [row([button('ac:setup:self', 'Set up my account'), button('ac:directory:self', 'Open my agents', ButtonStyle.Primary)])], allowedMentions: { parse: [] } }
      if(closed)throw Error('DISCORD_BRIDGE_CLOSED')
      // The directory button is handled below through the same verified owner path.
      if (previous) await previous.edit(directory); else await channel.send(directory)
    }
    await onReady?.({ applicationId: client.user.id, guildId: settings.guildId })
    if(closed)throw Error('DISCORD_BRIDGE_CLOSED')
    ready=true;startupError=null;scheduleFlush()
  }
  client.once(Events.ClientReady,()=>{void initializeReady().catch(error=>{ready=false;startupError=String(error.code||error.message||'DISCORD_STARTUP_UNAVAILABLE').slice(0,200);client.destroy()})})
  const timer = setInterval(scheduleFlush, 3000); timer.unref()
  return { execute, panel, createWork, workOrders, notifyOwner, flush, client, interaction,
    async start() {
      if (!settings.enabled) return { enabled: false }
      await client.login(settings.botToken)
      const deadline=Date.now()+30000
      while(!ready&&!startupError&&!closed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25))
      if(!ready){closed=true;clearInterval(timer);client.destroy();throw Error(startupError||'DISCORD_STARTUP_TIMEOUT')}
      return { enabled: true }
    },
    async close() { closed = true; ready=false; clearInterval(timer); await experience?.close(); client.destroy() },
    get ready() { return ready },get startupError(){return startupError},get notificationError(){return notificationError},get serverExperience(){return experience?.status()} }
}
