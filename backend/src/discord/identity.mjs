import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID, createHash } from 'node:crypto'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const snowflake = /^[0-9]{5,22}$/
const name = /^[A-Za-z0-9_]{3,16}$/
const id = /^[A-Za-z0-9_.:-]{1,128}$/
const subject = /^did:privy:[A-Za-z0-9:_-]{1,200}$/
const toolsAllowed = new Set(['inspect','status','screenshot','follow','come','wait','collect','deliver','gather','craft','build'])
const canonicalTool = value => value === 'cancel' ? 'wait' : ['build_structure','build_platform','build_shelter'].includes(value) ? 'build' : ['task','chat','create','resume','capabilities'].includes(value) ? 'status' : value
const digest = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(Error(code), { code }) }
const stableUuid = value => { const hex = digest(value).slice(0,32); return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-') }

// Only the authenticated Discord transport calls methods taking discordUserId.
// Browser callers receive only completeSetup's opaque one-use capability.
export async function createDiscordIdentity({ pool, appId, origin, serverId = 'local', verifyPrivyToken, loadPrivyUser,
  gameSession, approveJoin, reserveJoin, resolveScope, maxGrantMs = 86400000 } = {}) {
  if (!pool?.connect || !appId || typeof verifyPrivyToken !== 'function' || typeof loadPrivyUser !== 'function' || !id.test(serverId)) fail('DISCORD_IDENTITY_CONFIGURATION_REQUIRED')
  const url = new URL(origin)
  if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) fail('DISCORD_ONBOARDING_ORIGIN_REQUIRED')
  await pool.query(await readFile(new URL('schema.sql', import.meta.url),'utf8'))
  const transaction = async work => { const tx = await pool.connect(); try { await tx.query('BEGIN'); const value = await work(tx); await tx.query('COMMIT'); return value } catch(error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() } }
  const exists = async (tx, table) => Boolean((await tx.query('SELECT to_regclass($1) AS value',[table])).rows[0].value)
  const principal = async (discordUserId, tx=pool) => {
    if (!snowflake.test(discordUserId || '')) fail('VERIFIED_DISCORD_USER_REQUIRED')
    const row = (await tx.query(`SELECT p.*,i.discord_user_id FROM ac_discord_identities i JOIN ac_discord_principals p USING(principal_id) WHERE i.discord_user_id=$1 AND p.app_id=$2`,[discordUserId,appId])).rows[0]
    if (!row) fail('DISCORD_PRIVY_LINK_REQUIRED')
    return row
  }
  async function getOwner(discordUserId) {
    const row = await principal(discordUserId)
    const alias = (await pool.query('SELECT * FROM ac_discord_minecraft_aliases WHERE principal_id=$1 AND server_id=$2',[row.principal_id,serverId])).rows[0]
    const reservation = (await pool.query('SELECT * FROM ac_discord_name_reservations WHERE principal_id=$1 AND server_id=$2 AND (expires_at>now() OR approved_at IS NOT NULL)',[row.principal_id,serverId])).rows[0]
    return { ownerId:row.principal_id, principalId:row.principal_id, ownerName:alias?.player_name || reservation?.player_name || null,
      discordUserId,privySubject:row.privy_subject, ...(alias ? {minecraftPlayerId:alias.player_id,minecraftVerification:alias.verification} : {}), minecraftLinked:Boolean(alias) }
  }
  async function beginSetup({ discordUserId, interactionId }) {
    if (!snowflake.test(discordUserId || '') || !snowflake.test(interactionId || '')) fail('VERIFIED_DISCORD_INTERACTION_REQUIRED')
    const challenge = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now()+600000)
    await pool.query('INSERT INTO ac_discord_setup_challenges(challenge_hash,discord_user_id,interaction_id,expires_at) VALUES($1,$2,$3,$4)',[digest(challenge),discordUserId,interactionId,expiresAt])
    return { loginUrl:origin+'/discord/setup#challenge='+challenge, challenge,expiresAt:expiresAt.toISOString() }
  }
  async function completeSetup({ challenge,accessToken }) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge || '') || typeof accessToken !== 'string' || accessToken.length<20 || accessToken.length>16384) fail('DISCORD_SETUP_INVALID')
    let claims,user
    try { claims=await verifyPrivyToken(accessToken); if (claims?.appId !== appId || claims?.issuer !== 'privy.io' || !subject.test(claims?.subject || '') || !Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs<=Date.now()) fail('PRIVY_TOKEN_INVALID') }
    catch { fail('PRIVY_TOKEN_INVALID') }
    try { user=await loadPrivyUser(claims.subject) } catch { fail('PRIVY_USER_LOOKUP_UNAVAILABLE') }
    if (user?.id !== claims.subject || !Array.isArray(user.linked_accounts)) fail('PRIVY_USER_BINDING_INVALID')
    return transaction(async tx => {
      const challengeRow=(await tx.query('SELECT * FROM ac_discord_setup_challenges WHERE challenge_hash=$1 FOR UPDATE',[digest(challenge)])).rows[0]
      if (!challengeRow || challengeRow.consumed_at || +new Date(challengeRow.expires_at)<=Date.now()) fail('DISCORD_SETUP_EXPIRED_OR_USED')
      const linked=user.linked_accounts.filter(account=>account.type==='discord_oauth' && account.subject===challengeRow.discord_user_id && Number.isFinite(account.verified_at) && account.verified_at>0)
      if (linked.length!==1) fail('PRIVY_VERIFIED_DISCORD_ACCOUNT_MISMATCH')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['discord-id:'+challengeRow.discord_user_id])
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['discord-principal:'+appId+':'+claims.subject])
      let legacy=[]
      if (await exists(tx,'ac_wallet_identity_bindings')) legacy=(await tx.query('SELECT * FROM ac_wallet_identity_bindings WHERE app_id=$1 AND privy_subject=$2',[appId,claims.subject])).rows
      if (legacy.length>1) fail('LEGACY_OWNER_REQUIRES_REVIEW')
      let owner=(await tx.query('SELECT * FROM ac_discord_principals WHERE app_id=$1 AND privy_subject=$2',[appId,claims.subject])).rows[0]
      const principalId=owner?.principal_id || legacy[0]?.player_id || randomUUID()
      if (owner && legacy[0] && owner.principal_id!==legacy[0].player_id) fail('LEGACY_OWNER_BINDING_CONFLICT')
      if (!owner) owner=(await tx.query('INSERT INTO ac_discord_principals(principal_id,app_id,privy_subject) VALUES($1,$2,$3) RETURNING *',[principalId,appId,claims.subject])).rows[0]
      const previous=(await tx.query('SELECT * FROM ac_discord_identities WHERE discord_user_id=$1 OR principal_id=$2',[challengeRow.discord_user_id,principalId])).rows
      if (previous.some(row=>row.principal_id!==principalId || row.discord_user_id!==challengeRow.discord_user_id)) fail('DISCORD_OWNER_BINDING_CONFLICT')
      await tx.query('INSERT INTO ac_discord_identities(discord_user_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[challengeRow.discord_user_id,principalId])
      let walletPreserved=false
      if (legacy[0]) {
        const old=legacy[0]
        await tx.query(`INSERT INTO ac_discord_minecraft_aliases(server_id,player_id,principal_id,player_name,verification,evidence)
          VALUES($1,$2,$2,$3,'local_connection',$4) ON CONFLICT DO NOTHING`,[serverId,old.player_id,old.player_name,{source:'preserved_existing_privy_game_binding',microsoftVerified:false}])
        const preservedAlias=(await tx.query('SELECT * FROM ac_discord_minecraft_aliases WHERE server_id=$1 AND (player_id=$2 OR principal_id=$2)',[serverId,old.player_id])).rows
        if (preservedAlias.length!==1 || preservedAlias[0].principal_id!==principalId || preservedAlias[0].player_id!==old.player_id || preservedAlias[0].player_name!==old.player_name) fail('LEGACY_MINECRAFT_ALIAS_BINDING_CONFLICT')
        if (await exists(tx,'ac_playable_testnet_wallets')) {
          const wallet=(await tx.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1',['UNICHAIN_SEPOLIA_PLAYABLE:'+old.player_id])).rows[0]
          if (wallet) {
            if (wallet.auth_subject_hash!==digest(claims.subject)) fail('LEGACY_WALLET_OWNER_BINDING_CONFLICT')
            await tx.query('INSERT INTO ac_discord_wallet_aliases(wallet_id,principal_id,address,provider_account_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[wallet.wallet_id,principalId,wallet.address,wallet.provider_account_id])
            const preserved=(await tx.query('SELECT * FROM ac_discord_wallet_aliases WHERE wallet_id=$1',[wallet.wallet_id])).rows[0]
            if (preserved.principal_id!==principalId || preserved.address!==wallet.address || preserved.provider_account_id!==wallet.provider_account_id) fail('LEGACY_WALLET_ALIAS_BINDING_CONFLICT')
            walletPreserved=true
          }
        }
      }
      if (claims.expiresAtMs<=Date.now()) fail('PRIVY_TOKEN_EXPIRED')
      await tx.query('UPDATE ac_discord_setup_challenges SET consumed_at=now(),principal_id=$2 WHERE challenge_hash=$1',[digest(challenge),principalId])
      return { verified:true,ownerId:principalId,discordUserId:challengeRow.discord_user_id,minecraftLinked:Boolean(legacy[0]),walletPreserved }
    })
  }
  async function reserveMinecraft({discordUserId,playerName,accountKind='local'}) {
    const owner=await principal(discordUserId)
    if (!name.test(playerName || '') || !['local','microsoft'].includes(accountKind)) fail('MINECRAFT_RESERVATION_INVALID')
    const result=await transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['discord-name:'+serverId+':'+playerName.toLowerCase()])
      const known=(await tx.query('SELECT * FROM ac_discord_minecraft_aliases WHERE server_id=$1 AND (lower(player_name)=$2 OR principal_id=$3)',[serverId,playerName.toLowerCase(),owner.principal_id])).rows
      if (known.some(row=>row.principal_id!==owner.principal_id || row.player_name.toLowerCase()!==playerName.toLowerCase())) fail('MINECRAFT_ALIAS_OWNER_CONFLICT')
      const owned=(await tx.query('SELECT * FROM ac_discord_name_reservations WHERE server_id=$1 AND principal_id=$2',[serverId,owner.principal_id])).rows[0]
      if (owned && owned.normalized_name!==playerName.toLowerCase()) fail('MINECRAFT_RESERVATION_RELINK_REQUIRES_REVIEW')
      if (await exists(tx,'ac_wallet_identity_bindings')) {
        const old=(await tx.query('SELECT * FROM ac_wallet_identity_bindings WHERE lower(player_name)=$1',[playerName.toLowerCase()])).rows
        if (old.some(row=>row.privy_subject!==owner.privy_subject || row.app_id!==appId)) fail('EXISTING_MINECRAFT_OWNER_LOGIN_REQUIRED')
      }
      const existing=(await tx.query('SELECT * FROM ac_discord_name_reservations WHERE server_id=$1 AND normalized_name=$2 FOR UPDATE',[serverId,playerName.toLowerCase()])).rows[0]
      if (existing && existing.principal_id===owner.principal_id && existing.account_kind!==accountKind) fail('MINECRAFT_ACCOUNT_KIND_MIGRATION_REQUIRES_REVIEW')
      if (existing && existing.principal_id!==owner.principal_id && (+new Date(existing.expires_at)>Date.now() || existing.approved_at)) fail('MINECRAFT_NAME_ALREADY_RESERVED')
      if (existing && existing.principal_id!==owner.principal_id) await tx.query('DELETE FROM ac_discord_name_reservations WHERE reservation_id=$1 AND NOT EXISTS(SELECT 1 FROM ac_discord_join_approvals WHERE reservation_id=$1)',[existing.reservation_id])
      return (await tx.query(`INSERT INTO ac_discord_name_reservations(reservation_id,server_id,player_name,normalized_name,principal_id,account_kind,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours') ON CONFLICT(server_id,normalized_name) DO UPDATE SET expires_at=EXCLUDED.expires_at
        WHERE ac_discord_name_reservations.principal_id=EXCLUDED.principal_id RETURNING *`,[randomUUID(),serverId,playerName,playerName.toLowerCase(),owner.principal_id,accountKind])).rows[0]
    })
    if (!result) fail('MINECRAFT_RESERVATION_REQUIRES_REVIEW')
    if (reserveJoin) await reserveJoin({serverId,principalId:owner.principal_id,discordUserId,accountKind:result.account_kind,playerName:result.player_name,reservationId:result.reservation_id,expiresAt:new Date(result.expires_at).toISOString(),expiresAtMs:+new Date(result.expires_at)})
    return {reservationId:result.reservation_id,ownerId:owner.principal_id,playerName:result.player_name,accountKind:result.account_kind,verification:result.account_kind==='microsoft'?'microsoft_pending':'local_pending',expiresAt:new Date(result.expires_at).toISOString()}
  }
  async function approveMinecraftJoin({discordUserId,playerId,connectionId}) {
    const owner=await principal(discordUserId)
    if (!uuid.test(playerId || '') || !uuid.test(connectionId || '') || typeof gameSession!=='function' || typeof approveJoin!=='function') fail('ACTUAL_MINECRAFT_CONNECTION_REQUIRED')
    const reservations=(await pool.query('SELECT * FROM ac_discord_name_reservations WHERE server_id=$1 AND principal_id=$2',[serverId,owner.principal_id])).rows
    if (reservations.length!==1) fail('EXACT_MINECRAFT_RESERVATION_REQUIRED')
    const reservation=reservations[0],operationId=stableUuid('discord-join:'+reservation.reservation_id+':'+connectionId)
    let approval=(await pool.query("SELECT * FROM ac_discord_join_approvals WHERE reservation_id=$1 AND (operation_id=$2 OR status='intent') ORDER BY created_at LIMIT 1",[reservation.reservation_id,operationId])).rows[0]
    if (approval && (approval.operation_id!==operationId || approval.player_id!==playerId.toLowerCase() || approval.connection_id!==connectionId.toLowerCase())) fail('JOIN_APPROVAL_ORIGINAL_CONNECTION_REQUIRED')
    if (approval?.status==='approved') return {approved:true,ownerId:owner.principal_id,playerId:approval.player_id,connectionId:approval.connection_id}
    const actual=await gameSession({serverId,playerId:playerId.toLowerCase()})
    if (!actual?.online || actual.playerId?.toLowerCase()!==playerId.toLowerCase() || actual.connectionId?.toLowerCase()!==connectionId.toLowerCase() || actual.playerName?.toLowerCase()!==reservation.normalized_name || actual.serverId && actual.serverId!==serverId) fail('MINECRAFT_CONNECTION_BINDING_MISMATCH')
    const priorAlias=(await pool.query('SELECT * FROM ac_discord_minecraft_aliases WHERE server_id=$1 AND (player_id=$2 OR principal_id=$3)',[serverId,playerId.toLowerCase(),owner.principal_id])).rows
    if (priorAlias.some(row=>row.principal_id!==owner.principal_id || row.player_id!==playerId.toLowerCase())) fail('MINECRAFT_ALIAS_OWNER_CONFLICT')
    if (!approval && +new Date(reservation.expires_at)<=Date.now()) fail('MINECRAFT_JOIN_APPROVAL_EXPIRED_OR_USED')
    await pool.query(`INSERT INTO ac_discord_join_approvals(operation_id,reservation_id,principal_id,server_id,player_id,connection_id,player_name,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'intent') ON CONFLICT DO NOTHING`,[operationId,reservation.reservation_id,owner.principal_id,serverId,playerId.toLowerCase(),connectionId.toLowerCase(),reservation.player_name])
    approval=(await pool.query("SELECT * FROM ac_discord_join_approvals WHERE reservation_id=$1 AND (operation_id=$2 OR status='intent') ORDER BY created_at LIMIT 1",[reservation.reservation_id,operationId])).rows[0]
    if (approval.operation_id!==operationId || approval.player_id!==playerId.toLowerCase()) fail('JOIN_APPROVAL_ORIGINAL_CONNECTION_REQUIRED')
    const receipt=await approveJoin({operationId,serverId,playerId:approval.player_id,connectionId:approval.connection_id,principalId:owner.principal_id,playerName:reservation.player_name,discordUserId})
    if (!receipt?.approved || receipt.playerId?.toLowerCase()!==approval.player_id || receipt.connectionId?.toLowerCase()!==approval.connection_id || receipt.principalId!==owner.principal_id) fail('JOIN_APPROVAL_RECEIPT_MISMATCH')
    await transaction(async tx=>{
      const alias=(await tx.query('SELECT * FROM ac_discord_minecraft_aliases WHERE server_id=$1 AND (player_id=$2 OR principal_id=$3)',[serverId,approval.player_id,owner.principal_id])).rows
      if (alias.some(row=>row.principal_id!==owner.principal_id || row.player_id!==approval.player_id)) fail('MINECRAFT_ALIAS_OWNER_CONFLICT')
      await tx.query(`INSERT INTO ac_discord_minecraft_aliases(server_id,player_id,principal_id,player_name,verification,connection_id,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(server_id,player_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
      [serverId,approval.player_id,owner.principal_id,reservation.player_name,reservation.account_kind==='microsoft'?'microsoft_pending':'local_connection',approval.connection_id,{operationId,source:'actual_owned_server_connection',microsoftVerified:false}])
      await tx.query("UPDATE ac_discord_join_approvals SET status='approved',receipt=$2 WHERE operation_id=$1",[operationId,receipt])
      await tx.query('UPDATE ac_discord_name_reservations SET approved_at=now() WHERE reservation_id=$1',[reservation.reservation_id])
    })
    return {approved:true,ownerId:owner.principal_id,playerId:approval.player_id,connectionId:approval.connection_id,microsoftVerified:false}
  }
  async function lookupMinecraft({serverId:requestedServer=serverId,playerId}) {
    if (!uuid.test(playerId || '') || requestedServer!==serverId) fail('MINECRAFT_ALIAS_REQUIRED')
    const row=(await pool.query(`SELECT i.discord_user_id FROM ac_discord_minecraft_aliases a JOIN ac_discord_identities i USING(principal_id) WHERE a.server_id=$1 AND a.player_id=$2`,[serverId,playerId.toLowerCase()])).rows[0]
    if (!row) fail('MINECRAFT_ALIAS_NOT_LINKED')
    return getOwner(row.discord_user_id)
  }
  async function grantRemote({discordUserId,agentId,plotId,tools,expiresAt,operationId}) {
    const owner=await principal(discordUserId), expiry=+new Date(expiresAt)
    if (Array.isArray(tools)) tools=tools.map(canonicalTool)
    if (!id.test(agentId || '') || !id.test(plotId || '') || !Array.isArray(tools) || !tools.length || tools.length>toolsAllowed.size || tools.some(tool=>!toolsAllowed.has(tool)) ||
      !Number.isFinite(expiry) || expiry<=Date.now() || expiry>Date.now()+maxGrantMs || !id.test(operationId || '')) fail('BOUNDED_REMOTE_GRANT_REQUIRED')
    if (typeof resolveScope!=='function' || !await resolveScope({ownerId:owner.principal_id,agentId,plotId})) fail('REMOTE_AGENT_PLOT_OWNERSHIP_REQUIRED')
    return transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['discord-remote-scope:'+agentId+':'+plotId])
      const existing=(await tx.query('SELECT * FROM ac_discord_remote_grants WHERE request_id=$1',[operationId])).rows[0]
      const selected=[...new Set(tools)].sort()
      if (existing) {
        if (existing.principal_id!==owner.principal_id || existing.agent_id!==agentId || existing.plot_id!==plotId || JSON.stringify(existing.tools)!==JSON.stringify(selected) || +new Date(existing.expires_at)!==expiry) fail('REMOTE_GRANT_IMMUTABLE_TERMS')
        return grantView(existing)
      }
      const foreign=(await tx.query('SELECT 1 FROM ac_discord_remote_grants WHERE agent_id=$1 AND plot_id=$2 AND principal_id<>$3 AND revoked_at IS NULL AND expires_at>now()',[agentId,plotId,owner.principal_id])).rowCount
      if (foreign) fail('REMOTE_AGENT_PLOT_ALREADY_GRANTED')
      return grantView((await tx.query('INSERT INTO ac_discord_remote_grants(grant_id,request_id,principal_id,agent_id,plot_id,tools,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),operationId,owner.principal_id,agentId,plotId,JSON.stringify(selected),new Date(expiry)])).rows[0])
    })
  }
  const grantView = row=>({id:row.grant_id,grantId:row.grant_id,principalId:row.principal_id,ownerId:row.principal_id,ownerPlayerId:row.principal_id,agentId:row.agent_id,slotName:row.agent_id,plotId:row.plot_id,tools:row.tools,expiresAt:new Date(row.expires_at).toISOString(),expiresAtMs:+new Date(row.expires_at),generation:1,revoked:Boolean(row.revoked_at)})
  async function revokeRemote({discordUserId,grantId}) {
    const owner=await principal(discordUserId)
    if (!uuid.test(grantId || '')) fail('REMOTE_GRANT_REQUIRED')
    const row=(await pool.query('UPDATE ac_discord_remote_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_id=$1 AND principal_id=$2 RETURNING *',[grantId,owner.principal_id])).rows[0]
    if (!row) fail('REMOTE_GRANT_OWNER_REQUIRED')
    return grantView(row)
  }
  async function authorizeRemote({discordUserId,agentId,plotId,tool,grantId}) {
    const owner=await principal(discordUserId)
    tool=canonicalTool(tool)
    if (!toolsAllowed.has(tool) || !id.test(agentId || '') || !id.test(plotId || '') || grantId!==undefined && !uuid.test(grantId)) fail('REMOTE_PHYSICAL_TOOL_SCOPE_REQUIRED')
    const row=(await pool.query(`SELECT * FROM ac_discord_remote_grants WHERE principal_id=$1 AND agent_id=$2 AND plot_id=$3
      AND revoked_at IS NULL AND expires_at>now() AND tools ? $4 AND ($5::uuid IS NULL OR grant_id=$5) ORDER BY created_at DESC LIMIT 1`,[owner.principal_id,agentId,plotId,tool,grantId||null])).rows[0]
    if (!row || typeof resolveScope!=='function' || !await resolveScope({ownerId:owner.principal_id,agentId,plotId})) fail('REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE')
    return {...grantView(row),discordUserId,ownerId:owner.principal_id}
  }
  async function issueGrant({discordUserId,slotName,plotId=slotName,tools,ttlMs=3600000,operationId=randomUUID()}) {
    const owner=await principal(discordUserId)
    if (!Number.isSafeInteger(ttlMs) || ttlMs<1 || ttlMs>maxGrantMs || !id.test(operationId || '') || !Array.isArray(tools) || !tools.length || tools.some(tool=>!toolsAllowed.has(canonicalTool(tool)))) fail('BOUNDED_REMOTE_GRANT_REQUIRED')
    const existing=(await pool.query('SELECT * FROM ac_discord_remote_grants WHERE request_id=$1',[operationId])).rows[0]
    if (existing) {
      const selected=[...new Set(tools.map(canonicalTool))].sort()
      if (existing.principal_id!==owner.principal_id || existing.agent_id!==slotName || existing.plot_id!==plotId || JSON.stringify(existing.tools)!==JSON.stringify(selected)) fail('REMOTE_GRANT_IMMUTABLE_TERMS')
      if (existing.revoked_at || +new Date(existing.expires_at)<=Date.now()) fail('REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE')
      if (typeof resolveScope!=='function' || !await resolveScope({ownerId:owner.principal_id,agentId:slotName,plotId})) fail('REMOTE_AGENT_PLOT_OWNERSHIP_REQUIRED')
      return grantView(existing)
    }
    return grantRemote({discordUserId,agentId:slotName,plotId,tools,expiresAt:new Date(Date.now()+ttlMs).toISOString(),operationId})
  }
  async function authorizeGrant({discordUserId,grantId,ownerId,slotName,action}) {
    if (!uuid.test(grantId || '')) fail('REMOTE_GRANT_REQUIRED')
    const row=(await pool.query('SELECT * FROM ac_discord_remote_grants WHERE grant_id=$1',[grantId])).rows[0]
    if (!row || ownerId && row.principal_id!==ownerId || slotName && row.agent_id!==slotName) fail('REMOTE_GRANT_OWNER_REQUIRED')
    return authorizeRemote({discordUserId,grantId,agentId:row.agent_id,plotId:row.plot_id,tool:action})
  }
  return {beginSetup,completeSetup,getOwner,reserveMinecraft,approveMinecraftJoin,lookupMinecraft,getMinecraftOwner:(serverId,playerId)=>lookupMinecraft({serverId,playerId}),grantRemote,issueGrant,revokeRemote,authorizeRemote,authorizeGrant}
}
