import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import pg from 'pg'
import { loadPrivySettings } from './testnet-wallets.mjs'
import { createWalletAuth, createPrivyTokenVerifier } from './wallet-auth.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const read=async path=>JSON.parse(await readFile(path,'utf8'))
export async function playerWalletPublicConfig() {
  try {
    const settings=await read(join(root,'.local/playable-testnet/wallet-settings.json'))
    const origin=settings.playerOrigin||'http://127.0.0.1:8789',url=new URL(origin)
    if(url.origin!==origin||url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('WALLET_AUTH_ORIGIN_REQUIRED')
    return {configured:settings.provider==='privy'&&Boolean(settings.appId),appId:settings.appId||null,origin}
  }catch(error){if(error.code==='ENOENT')return{configured:false,appId:null,reason:'PRIVY_APP_CONFIGURATION_REQUIRED'};throw error}
}

export async function openPlayerWalletAuth({pool:suppliedPool,pluginApi,origin:suppliedOrigin}={}) {
  const {settings,credentials}=await loadPrivySettings(root,{requireProvider:false})
  const origin=suppliedOrigin||settings.playerOrigin||'http://127.0.0.1:8789'
  const environment=suppliedPool?null:await read(join(root,'.local/backend/environment.json'))
  const pool=suppliedPool||new pg.Pool({connectionString:environment.databaseUrl,max:4})
  try {
    const verifyAccessToken=await createPrivyTokenVerifier({appId:settings.appId,appSecret:credentials.appSecret})
    const api=pluginApi||(async(path)=>{
      const active=await read(join(root,'.local/playable-world/active.json'))
      if(active.owner!=='agentcity-playable-pilot'||!/^agentcity-playable-[a-f0-9]{8}$/.test(active.container))throw Error('OWNED_PLAYABLE_WORLD_REQUIRED')
      const token=(await readFile(join(root,'.local/playable-world',active.container,'api-token'),'utf8')).trim()
      const response=await fetch('http://127.0.0.1:25597/playable/'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)})
      if(!response.ok)throw Error('GAME_SESSION_SERVICE_UNAVAILABLE')
      return response.json()
    })
    const allowed=async()=>{
      const file=settings.enrollmentFile||join(root,'.local/playable-testnet/enrolled-players.json')
      try{return await read(file)}catch(error){if(error.code==='ENOENT')return{};throw error}
    }
    const service=async()=>createWalletAuth({pool,verifyAccessToken,appId:settings.appId,origin,
      allowedSubjects:await allowed(),gameSession:playerId=>api('session?playerId='+encodeURIComponent(playerId))})
    return {settings,
      challenge:async input=>(await service()).challenge(input),
      complete:async input=>(await service()).complete(input),
      requireSession:async input=>(await service()).requireSession(input),
      close:async()=>{if(!suppliedPool)await pool.end()}}
  }catch(error){if(!suppliedPool)await pool.end();throw error}
}
