import {createHash} from 'node:crypto'
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const ADDRESS=/^0x[a-f0-9]{40}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}

// Existing account view only: no custody provider, session creation or signer.
export function createGameWalletView({pool,identity,serverId,gameSession}={}){
 if(!pool?.query||typeof identity?.getMinecraftOwner!=='function'||!serverId||typeof gameSession!=='function')fail('DISCORD_GAME_WALLET_CONFIGURATION_REQUIRED')
 return async function gameWalletView(event){
  if(!UUID.test(event?.playerId||'')||!UUID.test(event?.connectionId||''))fail('DISCORD_GAME_WALLET_CONNECTION_REQUIRED')
  const playerId=event.playerId.toLowerCase(),connectionId=event.connectionId.toLowerCase()
  let owner
  try{owner=await identity.getMinecraftOwner(serverId,playerId)}catch(error){if(error.code==='MINECRAFT_ALIAS_NOT_LINKED')return{mapped:false};throw error}
  if(!UUID.test(owner?.ownerId||'')||owner.minecraftPlayerId?.toLowerCase()!==playerId)fail('DISCORD_GAME_WALLET_OWNER_CONFLICT')
  const check=async()=>{
   const current=await gameSession({serverId,playerId})
   if(current?.online!==true||current.pendingAuthentication!==false||current.playerId?.toLowerCase()!==playerId||
    current.connectionId?.toLowerCase()!==connectionId||current.principalId?.toLowerCase()!==owner.ownerId.toLowerCase()||
    current.playerName?.toLowerCase()!==owner.ownerName?.toLowerCase()||current.serverId&&current.serverId!==serverId)fail('DISCORD_GAME_WALLET_APPROVED_CONNECTION_REQUIRED')
  }
  await check()
  const alias=(await pool.query(`SELECT a.principal_id FROM ac_discord_minecraft_aliases a
   JOIN ac_discord_join_approvals j ON j.server_id=a.server_id AND j.player_id=a.player_id
    AND j.principal_id=a.principal_id AND j.connection_id=a.connection_id AND j.status='approved'
   WHERE a.server_id=$1 AND a.player_id=$2 AND a.principal_id=$3 AND a.connection_id=$4`,[serverId,playerId,owner.ownerId,connectionId])).rows
  if(alias.length!==1)fail('DISCORD_GAME_WALLET_ALIAS_APPROVAL_REQUIRED')
  const rows=(await pool.query(`SELECT d.address AS alias_address,d.provider_account_id AS alias_provider_id,w.*
   FROM ac_discord_wallet_aliases d JOIN ac_playable_testnet_wallets w USING(wallet_id)
   WHERE d.principal_id=$1 AND d.wallet_id=$2`,[owner.ownerId,'UNICHAIN_SEPOLIA_PLAYABLE:'+owner.ownerId.toLowerCase()])).rows
  await check()
  if(!rows.length)return{mapped:true,ready:false,ownerId:owner.ownerId,message:'Set up your managed test wallet through /wallet in Discord. Wallet setup is handled in Discord and the browser.'}
  if(rows.length!==1)fail('DISCORD_GAME_WALLET_ALIAS_OWNER_CONFLICT')
  const wallet=rows[0]
  if(wallet.environment!=='UNICHAIN_SEPOLIA_PLAYABLE'||wallet.provider_type!=='privy'||!ADDRESS.test(wallet.address)||
   wallet.alias_address?.toLowerCase()!==wallet.address.toLowerCase()||wallet.alias_provider_id!==wallet.provider_account_id||
   !owner.privySubject||wallet.auth_subject_hash!==createHash('sha256').update(owner.privySubject).digest('hex'))fail('DISCORD_GAME_WALLET_ALIAS_OWNER_CONFLICT')
  const address=wallet.address.toLowerCase()
  return{mapped:true,ready:true,ownerId:owner.ownerId,address,chainId:1301,provider:'privy',spendingAuthorized:false,
   message:`Your Discord-linked wallet: ${address} (Unichain Sepolia). Open /wallet in Discord for wallet setup and controls.`}
 }
}
