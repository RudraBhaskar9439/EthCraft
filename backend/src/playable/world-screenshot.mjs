import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const hash=value=>createHash('sha256').update(value).digest('hex')
const position=value=>Array.isArray(value)?value:[value?.x,value?.y,value?.z]
const integerPoint=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isSafeInteger)

/** Reads only loaded native client observations. It never joins, moves or edits. */
export function snapshotWorld(bot,{bounds,target,worldName}={}){
 if(!bot?.entity?.position||bot.version!=='1.21.11'||typeof bot.blockAt!=='function'||typeof bot.world?.getColumn!=='function')throw Error('LIVE_MINEFLAYER_OBSERVATION_REQUIRED')
 const min=position(bounds?.min),max=position(bounds?.max)
 if(!integerPoint(min)||!integerPoint(max)||min[1]<0||max[1]>255||max.some((n,i)=>n<min[i]||n-min[i]>=32)||max.reduce((volume,n,i)=>volume*(n-min[i]+1),1)>32768)throw Error('BOUNDED_REGISTERED_CAPTURE_REGION_REQUIRED')
 const center=target?position(target):min.map((n,i)=>(n+max[i])/2)
 if(center.length!==3||center.some((n,i)=>!Number.isFinite(n)||n<min[i]||n>max[i]))throw Error('CAPTURE_TARGET_OUTSIDE_OBSERVED_REGION')
 const palette=[],cells=[],lookup=new Map(),chunkHashes={}
 const observedAt=new Date().toISOString()
 // Chunk hashes cover the exact loaded client columns used, not an invented
 // blueprint or an arbitrary server file. All reads below share one JS turn.
 for(let cx=Math.floor(min[0]/16);cx<=Math.floor(max[0]/16);cx++)for(let cz=Math.floor(min[2]/16);cz<=Math.floor(max[2]/16);cz++){
  const column=bot.world.getColumn(cx,cz);if(!column||typeof column.toJson!=='function')throw Error('CAPTURE_CHUNK_NOT_LOADED')
  const raw=column.toJson();chunkHashes[cx+','+cz]=hash(typeof raw==='string'?raw:JSON.stringify(raw))
 }
 const Vec=bot.entity.position.constructor
 for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++)for(let z=min[2];z<=max[2];z++){
  const block=bot.blockAt(new Vec(x,y,z));if(!block||typeof block.getProperties!=='function')throw Error('CAPTURE_BLOCK_NOT_OBSERVED')
  const entry={name:block.name,properties:block.getProperties()},key=JSON.stringify(entry)
  let index=lookup.get(key);if(index===undefined){index=palette.length;palette.push(entry);lookup.set(key,index)}cells.push(index)
 }
 const region={min,max},distance=Math.max(max[0]-min[0]+1,max[2]-min[2]+1)
 const camera={position:[center[0]+distance*0.9,Math.max(max[1]+4,center[1]+distance*0.75),center[2]+distance*1.05],target:center}
 const provenance={schema:'agentcity.world-capture.v1',captureId:randomUUID(),agent:String(bot.username||bot.entity.username||'unknown'),world:String(worldName||bot.game?.dimension||'unknown'),clientVersion:bot.version,observedAt,
  source:'Actual loaded Mineflayer client world cache; independent overview camera; not a Minecraft client framebuffer',bounds:region,chunkHashes,
  observedBlockHash:hash(JSON.stringify({bounds:region,palette,cells})),paletteStates:palette.length,observedCells:cells.length}
 return{schema:'agentcity.world-snapshot.v1',clientVersion:bot.version,bounds:region,palette,cells,camera,provenance,
  agentEntity:{id:bot.entity.id||1,name:'player',pos:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},width:0.6,height:1.8,yaw:bot.entity.yaw||0,pitch:bot.entity.pitch||0}}
}

export async function captureWorldScreenshot(bot,{bounds,target,worldName,outputDirectory,rendererUrl='http://127.0.0.1:8793'}={}){
 const endpoint=new URL(rendererUrl)
 if(endpoint.origin!=='http://127.0.0.1:8793'||endpoint.pathname!=='/'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('LOOPBACK_NATIVE_RENDERER_REQUIRED')
 const snapshot=snapshotWorld(bot,{bounds,target,worldName})
 const response=await fetch(new URL('/capture',endpoint),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(50000)})
 if(!response.ok)throw Error('ACTUAL_WORLD_CAPTURE_UNAVAILABLE')
 const parts=[];let received=0
 for await(const part of response.body){received+=part.length;if(received>8000000)throw Error('CAPTURE_REPLY_TOO_LARGE');parts.push(part)}
 const raw=Buffer.concat(parts).toString('utf8')
 const result=JSON.parse(raw),buffer=Buffer.from(result.png||'','base64'),metadata=result.metadata
 if(buffer.length<100||buffer.length>4000000||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||buffer.subarray(-12).toString('hex')!=='0000000049454e44ae426082'||buffer.readUInt32BE(16)!==960||buffer.readUInt32BE(20)!==640)throw Error('VALID_BOUNDED_PNG_REQUIRED')
 if(metadata?.captureId!==snapshot.provenance.captureId||metadata.observedBlockHash!==snapshot.provenance.observedBlockHash||metadata.pngSha256!==hash(buffer)||metadata.world!==snapshot.provenance.world||metadata.agent!==snapshot.provenance.agent)throw Error('CAPTURE_PROVENANCE_MISMATCH')
 let file
 if(outputDirectory){const directory=resolve(outputDirectory);await mkdir(directory,{recursive:true,mode:0o700});file=join(directory,metadata.captureId+'.png');await writeFile(file,buffer,{flag:'wx',mode:0o600});await writeFile(file+'.json',JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600})}
 return{file,buffer,metadata}
}
