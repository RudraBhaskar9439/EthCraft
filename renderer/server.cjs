'use strict'
// Native GL only: no browser, game client, commands, credentials or filesystem API.
const http=require('node:http'),{createHash}=require('node:crypto'),{Worker}=require('node:worker_threads')
global.Worker=Worker
// Three r128's disposal path expects an animation scheduling context even for
// one-shot native frames. This supplies timers, not a browser or DOM.
global.self={requestAnimationFrame:callback=>setTimeout(()=>callback(performance.now()),16),cancelAnimationFrame:clearTimeout}
global.THREE=require('three')
const THREE=global.THREE,{createCanvas}=require('node-canvas-webgl/lib')
const {Viewer}=require('prismarine-viewer/viewer')
const Block=require('prismarine-block')('1.21.4'),Chunk=require('prismarine-chunk')('1.21.4'),{Vec3}=require('vec3')
const digest=value=>createHash('sha256').update(value).digest('hex')
let busy=false
function validate(value){
 if(value?.schema!=='agentcity.world-snapshot.v1'||value.clientVersion!=='1.21.11'||!value.provenance||typeof value.provenance.world!=='string'||typeof value.provenance.agent!=='string')throw Error('OBSERVED_SNAPSHOT_REQUIRED')
 const min=value.bounds?.min,max=value.bounds?.max
 if(![min,max].every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isSafeInteger)))throw Error('INTEGER_BOUNDS_REQUIRED')
 const size=max.map((n,i)=>n-min[i]+1),volume=size.reduce((a,b)=>a*b,1)
 if(size.some(n=>n<1||n>32)||volume>32768||min[1]<0||max[1]>255)throw Error('RENDER_BOUND_REQUIRED')
 if(!Array.isArray(value.palette)||value.palette.length<1||value.palette.length>1024||!Array.isArray(value.cells)||value.cells.length!==volume||value.cells.some(i=>!Number.isInteger(i)||i<0||i>=value.palette.length))throw Error('PALETTE_REQUIRED')
 if(digest(JSON.stringify({bounds:value.bounds,palette:value.palette,cells:value.cells}))!==value.provenance.observedBlockHash)throw Error('SNAPSHOT_HASH_MISMATCH')
 for(const p of [value.camera?.position,value.camera?.target])if(!Array.isArray(p)||p.length!==3||p.some(n=>!Number.isFinite(n))||p.some((n,i)=>Math.abs(n-min[i])>128))throw Error('CAMERA_BOUND_REQUIRED')
 return value
}
async function render(input){
 const value=validate(input),width=960,height=640,canvas=createCanvas(width,height)
 // r128 reads this timer context during renderer construction only. Remove it
 // before Viewer creates native worker_threads (which use absolute Node paths).
 global.window=global.self
 let renderer
 try{renderer=new THREE.WebGLRenderer({canvas,antialias:false,preserveDrawingBuffer:true})}finally{delete global.window}
 const viewer=new Viewer(renderer)
 try{
  if(!viewer.setVersion('1.21.4'))throw Error('RENDER_ASSETS_UNAVAILABLE')
  const states=value.palette.map(entry=>{if(!entry||!/^[a-z0-9_]{1,80}$/.test(entry.name)||!entry.properties||typeof entry.properties!=='object')throw Error('BLOCK_STATE_REQUIRED');const block=Block.fromProperties(entry.name,entry.properties,1);if(!block)throw Error('UNSUPPORTED_OBSERVED_BLOCK');return block.stateId})
  const columns=new Map(),min=value.bounds.min,max=value.bounds.max
  let index=0
  for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++)for(let z=min[2];z<=max[2];z++){
   const stateId=states[value.cells[index++]],cx=Math.floor(x/16)*16,cz=Math.floor(z/16)*16,key=cx+','+cz
   let column=columns.get(key);if(!column){column=new Chunk({minY:0,worldHeight:256});columns.set(key,column)}
   const p=new Vec3(((x%16)+16)%16,y,((z%16)+16)%16)
   column.setBlockStateId(p,stateId);column.setSkyLight(p,15)
  }
  for(const [key,column]of columns){const [x,z]=key.split(',').map(Number);viewer.addColumn(x,z,column.toJson())}
  await Promise.race([viewer.waitForChunksToRender(),new Promise((_,reject)=>setTimeout(()=>reject(Error('MESH_TIMEOUT')),30000))])
  for(let attempt=0;attempt<50&&!viewer.world.material.map;attempt++)await new Promise(resolve=>setTimeout(resolve,20))
  if(!viewer.world.material.map)throw Error('ACTUAL_TEXTURES_UNAVAILABLE')
  viewer.camera.fov=55;viewer.camera.updateProjectionMatrix();viewer.camera.position.set(...value.camera.position);viewer.camera.lookAt(new THREE.Vector3(...value.camera.target))
  let agentModel=false
  if(value.agentEntity){try{viewer.updateEntity({...value.agentEntity,name:'player',username:value.provenance.agent});agentModel=true}catch{agentModel=false}}
  viewer.update();renderer.render(viewer.scene,viewer.camera)
  const png=canvas.toBuffer('image/png')
  return{png:png.toString('base64'),metadata:{...value.provenance,renderer:'Prismarine Viewer 1.33.0 native WebGL/Mesa',renderedAt:new Date().toISOString(),assetsVersion:'1.21.4',semanticStateMapping:true,width,height,camera:value.camera,agentModel,visibleRegionOnly:true,pngSha256:digest(png)}}
 }finally{for(const worker of viewer.world.workers)await worker.terminate();viewer.resetAll();renderer.dispose();canvas.__gl__?.getExtension('STACKGL_destroy_context')?.destroy()}
}
http.createServer(async(request,response)=>{
 response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store')
 if(request.method==='GET'&&request.url==='/health'){response.end(JSON.stringify({status:'ready',renderer:'native',viewer:'1.33.0'}));return}
 if(request.method!=='POST'||request.url!=='/capture'||request.headers.origin||!request.headers['content-type']?.startsWith('application/json')){response.writeHead(403).end('{}');return}
 if(busy){response.writeHead(429).end(JSON.stringify({error:'RENDERER_BUSY'}));return}
 busy=true
 try{let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>4000000)throw Error('SNAPSHOT_TOO_LARGE');chunks.push(chunk)}const result=await render(JSON.parse(Buffer.concat(chunks).toString('utf8')));response.end(JSON.stringify(result))}
 catch(error){console.error('capture_failed:'+String(error.message).slice(0,160));response.writeHead(422).end(JSON.stringify({error:'CAPTURE_UNAVAILABLE'}))}
 finally{busy=false}
}).listen(8793,'0.0.0.0',()=>console.log('Native world renderer ready on8793; publish only127.0.0.1'))
