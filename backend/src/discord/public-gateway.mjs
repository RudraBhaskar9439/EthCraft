import {createServer,request as upstreamRequest} from 'node:http'
import {pathToFileURL} from 'node:url'

const pages=new Set(['/discord/setup','/player-wallet'])
const getRoutes=new Set([...pages,'/discord-setup.js','/discord-setup.js.LEGAL.txt','/player-wallet.js','/player-wallet.js.LEGAL.txt','/api/discord/config','/api/player-wallet/config'])
const postRoutes=new Set(['/api/discord/complete','/api/discord/wallet','/api/player-wallet/link'])
const reply=(response,status,error)=>response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify({error}))

/** Fixed loopback receiver. Request data can never select an upstream host. */
export function createPublicGateway({publicOrigin,upstreamPort=8789}={}){
 const origin=new URL(publicOrigin)
 if(origin.origin!==publicOrigin||origin.protocol!=='https:'||origin.username||origin.password||!Number.isInteger(upstreamPort)||upstreamPort<1||upstreamPort>65535)throw Error('PUBLIC_HTTPS_ORIGIN_AND_LOCAL_UPSTREAM_REQUIRED')
 const server=createServer(async(request,response)=>{
  const raw=request.url||'',rawPath=raw.split('?')[0]
  if(raw.length>8192||raw.includes('#')||!raw.startsWith('/')||raw.startsWith('//')){reply(response,400,'PUBLIC_REQUEST_INVALID');return}
  let parsed
  try{parsed=new URL(raw,'http://127.0.0.1')}catch{reply(response,400,'PUBLIC_REQUEST_INVALID');return}
  const pathname=parsed.pathname
  if(rawPath!==pathname||(!pages.has(pathname)&&parsed.search)){reply(response,404,'PUBLIC_ROUTE_UNAVAILABLE');return}
  const allowed=request.method==='GET'?getRoutes.has(pathname):request.method==='POST'?postRoutes.has(pathname):false
  if(!allowed){reply(response,404,'PUBLIC_ROUTE_UNAVAILABLE');return}
  if(request.method==='POST'&&(request.headers.origin!==publicOrigin||request.headers['content-type']!=='application/json')){reply(response,403,'PUBLIC_SETUP_ORIGIN_REQUIRED');return}
  if(request.method==='GET'&&(request.headers['transfer-encoding']||Number(request.headers['content-length']||0)!==0)){reply(response,400,'PUBLIC_GET_BODY_UNSUPPORTED');return}
  if(Number(request.headers['content-length']||0)>16384){request.resume();reply(response,413,'PUBLIC_SETUP_REQUEST_TOO_LARGE');return}
  let size=0,overLimit=false;const chunks=[]
  try{for await(const chunk of request.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16384){overLimit=true;break}chunks.push(chunk)}}catch{if(!response.destroyed)reply(response,400,'PUBLIC_REQUEST_INTERRUPTED');return}
  if(overLimit){request.resume();reply(response,413,'PUBLIC_SETUP_REQUEST_TOO_LARGE');return}
  const headers={Host:origin.host,Accept:'*/*'}
  if(request.method==='POST')Object.assign(headers,{'Content-Type':'application/json',Origin:publicOrigin,'Content-Length':String(size)})
  const upstream=upstreamRequest({hostname:'127.0.0.1',port:upstreamPort,method:request.method,path:pathname+(pages.has(pathname)?parsed.search:''),headers,timeout:40000},incoming=>{
   if(incoming.statusCode>=300&&incoming.statusCode<400){incoming.resume();reply(response,502,'PUBLIC_REDIRECT_UNAVAILABLE');return}
   const selected={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}
   for(const key of ['content-type','content-security-policy'])if(incoming.headers[key])selected[key]=incoming.headers[key]
   response.writeHead(incoming.statusCode||502,selected)
   let received=0
   incoming.on('data',chunk=>{received+=chunk.length;if(received>8388608){incoming.destroy();response.destroy();return}response.write(chunk)})
   incoming.on('end',()=>response.end())
   incoming.on('error',()=>response.destroy())
  })
  upstream.on('timeout',()=>upstream.destroy())
  upstream.on('error',()=>{if(!response.headersSent)reply(response,502,'PUBLIC_SETUP_SERVICE_UNAVAILABLE');else response.destroy()})
  response.on('close',()=>upstream.destroy())
  upstream.end(Buffer.concat(chunks))
 })
 server.headersTimeout=10000;server.requestTimeout=20000;server.maxHeadersCount=40
 return server
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2)throw Error('PUBLIC_GATEWAY_DOES_NOT_ACCEPT_UPSTREAM_ARGUMENTS')
 const server=createPublicGateway({publicOrigin:process.env.AC_PUBLIC_ORIGIN})
 server.listen(8795,'127.0.0.1',()=>console.log('Player onboarding gateway listening on loopback port 8795. Operator routes are unavailable.'))
}
