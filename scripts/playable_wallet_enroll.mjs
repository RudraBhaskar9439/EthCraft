import { readFile, open, rename, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const root=fileURLToPath(new URL('../',import.meta.url))
const args=process.argv.slice(2)
if(args.length!==4||args[0]!=='--player'||args[2]!=='--subject'||!/^[A-Za-z0-9_]{3,16}$/.test(args[1])||!/^did:privy:[A-Za-z0-9:_-]{1,200}$/.test(args[3]))throw Error('Use --player MinecraftName --subject did:privy:PUBLIC_USER_ID. This local operator command approves initial enrollment only.')
const settings=JSON.parse(await readFile(join(root,'.local/playable-testnet/wallet-settings.json'),'utf8'))
const active=JSON.parse(await readFile(join(root,'.local/playable-world/active.json'),'utf8'))
if(active.owner!=='agentcity-playable-pilot'||!/^agentcity-playable-[a-f0-9]{8}$/.test(active.container))throw Error('OWNED_PLAYABLE_WORLD_REQUIRED')
const runtime=join(root,'.local/playable-world',active.container)
const agents=JSON.parse(await readFile(join(runtime,'personal-agents.json'),'utf8'))
const player=agents.agents.find(agent=>agent.ownerName===args[1])
if(!player)throw Error('PLAYER_OWNER_NOT_KNOWN: first join and create your personal agent; this command never invents a player UUID.')
const target=settings.enrollmentFile||join(root,'.local/playable-testnet/enrolled-players.json')
let current={}
try{current=JSON.parse(await readFile(target,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
const id=player.ownerId.toLowerCase()
if(current[id]&&current[id]!==args[3])throw Error('INITIAL_ENROLLMENT_CONFLICT: existing wallet identities cannot be silently relinked.')
if(Object.entries(current).some(([other,subject])=>other!==id&&subject===args[3]))throw Error('SUBJECT_ALREADY_ENROLLED')
current[id]=args[3]
await mkdir(dirname(target),{recursive:true})
const temporary=target+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600)
try{await file.writeFile(JSON.stringify(current,null,2)+'\n');await file.sync()}finally{await file.close()}
await rename(temporary,target)
if(process.platform!=='win32'){const directory=await open(dirname(target),'r');try{await directory.sync()}finally{await directory.close()}}
console.log('Initial identity enrollment approved for '+args[1]+'. The player must still complete their own verified Privy login for the current game connection.')
