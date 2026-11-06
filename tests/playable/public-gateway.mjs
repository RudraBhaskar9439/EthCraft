// Actual isolated HTTP servers; no current console, tunnel or account touched.
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import vm from 'node:vm'
import {spawn} from 'node:child_process'
import {createPublicGateway} from '../../backend/src/discord/public-gateway.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url)),origin='https://onboarding.example.invalid',seen=[]
const report={status:'fail',scope:'Actual isolated loopback HTTP gateway checks and onboarding callback bootstrap; no public tunnel or production-service changes',checks:[],sourceSha256:createHash('sha256').update(await readFile(new URL('../../backend/src/discord/public-gateway.mjs',import.meta.url))).digest('hex')}
report.sources={}
for(const path of ['backend/src/server.mjs','companion/src/discord-setup.jsx','companion/src/player-wallet.jsx','companion/dist/discord-setup.js','companion/dist/player-wallet.js'])report.sources[path]=createHash('sha256').update(await readFile(join(root,path))).digest('hex')
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const upstream=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);seen.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});res.writeHead(200,{'Content-Type':'application/json','Content-Security-Policy':"default-src 'self'",'Set-Cookie':'operator-secret=fixture; HttpOnly'});res.end(JSON.stringify({ok:true,path:req.url}))})
upstream.listen(0,'127.0.0.1');await once(upstream,'listening')
const gateway=createPublicGateway({publicOrigin:origin,upstreamPort:upstream.address().port});gateway.listen(0,'127.0.0.1');await once(gateway,'listening')
const call=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:gateway.address().port,path,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end(body)})
let consoleFixture
try{
 const callback='/discord/setup?code=fixture-oauth-code&state=fixture-state'
 assert.equal((await call(callback)).status,200);assert.equal(seen.at(-1).path,callback)
 assert.equal((await call('/player-wallet?code=fixture-player-code&state=fixture-player-state')).status,200)
 const before=seen.length
 for(const route of ['/','/api/demo','/wallet','/human','/api/human/status','/api/wallet/handoffs/fixture','/discord/../api/demo','/discord%2fsetup','//evil.example/discord/setup','/api/discord/config?path=/api/demo'])assert.notEqual((await call(route)).status,200)
 assert.equal(seen.length,before)
 pass('OAuth query survives allowed onboarding pages while operator routes encoded paths and API query routing never reach upstream')
 const result=await call('/api/discord/complete',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer ignored-fixture',Cookie:'ignored=fixture','X-Forwarded-Host':'evil.example','X-AgentCity-Token':'ignored-admin-fixture'},body:JSON.stringify({challenge:'fixture',accessToken:'fixture'})})
 assert.equal(result.status,200);assert.equal(seen.at(-1).headers.host,new URL(origin).host);assert.equal(seen.at(-1).headers.origin,origin)
 for(const header of ['authorization','cookie','x-forwarded-host','x-agentcity-token'])assert.equal(seen.at(-1).headers[header],undefined)
 assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.headers['content-security-policy'],"default-src 'self'")
 assert.equal((await call('/api/discord/wallet',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403)
 assert.equal((await call('/api/player-wallet/link',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'})).status,403)
 pass('setup POST preserves exact approved origin and JSON body while stripping authorization cookies forwarded host and upstream cookies')
 const beforeLarge=seen.length
 assert.equal((await call('/api/discord/complete',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':'16385'},body:'x'.repeat(16385)})).status,413)
 assert.equal((await call('/api/discord/complete',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Transfer-Encoding':'chunked'},body:'x'.repeat(16385)})).status,413)
 assert.equal((await call('/discord/setup',{method:'DELETE'})).status,404)
 assert.equal((await call('/discord/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,404)
 assert.equal(seen.length,beforeLarge)
 pass('strict route methods and 16KiB request limit refuse unsupported input before upstream delivery')
 const jsx=await readFile(new URL('../../companion/src/discord-setup.jsx',import.meta.url),'utf8')
 const bootstrap=jsx.slice(jsx.indexOf('const freshChallenge'),jsx.indexOf('function Setup()'))
 let replaced
 const storage=new Map()
 vm.runInNewContext(bootstrap,{URLSearchParams,Date,location:{hash:'#challenge=fixture-private-capability',pathname:'/discord/setup',search:'?code=fixture-code&state=fixture-state'},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},history:{replaceState:(_a,_b,path)=>{replaced=path}}})
 assert.equal(replaced,'/discord/setup?code=fixture-code&state=fixture-state');assert(!replaced.includes('challenge'))
 assert.equal(JSON.parse(storage.get('agentcity-discord-setup')).value,'fixture-private-capability')
 const serverSource=await readFile(new URL('../../backend/src/server.mjs',import.meta.url),'utf8')
 const routing=serverSource.slice(serverSource.indexOf('  let onboardingPage=null'),serverSource.indexOf('  const playerPath='))
 assert.equal(vm.runInNewContext('(function(){'+routing+';return onboardingPage})()',{URL,request:{url:callback},response:{writeHead:()=>({end(){}})}}),'/discord/setup')
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const consolePort=probe.address().port;await new Promise(resolve=>probe.close(resolve))
 consoleFixture=spawn(process.execPath,[join(root,'backend/src/server.mjs')],{cwd:root,env:{...process.env,AGENTCITY_LOCAL_PORT:String(consolePort)},stdio:'ignore',windowsHide:true})
 let actualResponse
 for(let attempt=0;attempt<100;attempt++){
  if(consoleFixture.exitCode!==null)throw Error('Isolated console fixture stopped before HTTP validation')
  try{actualResponse=await fetch('http://127.0.0.1:'+consolePort+callback);break}catch{await new Promise(resolve=>setTimeout(resolve,100))}
 }
 assert.equal(actualResponse?.status,200);assert.match(await actualResponse.text(),/discord-setup\.js/)
 const playerResponse=await fetch('http://127.0.0.1:'+consolePort+'/player-wallet?code=fixture-code&state=fixture-state')
 assert.equal(playerResponse.status,200);assert.match(await playerResponse.text(),/player-wallet\.js/)
 pass('actual frontend bootstrap removes private fragment but preserves OAuth query and console recognizes only onboarding page pathname')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{if(consoleFixture?.exitCode===null){consoleFixture.kill();await once(consoleFixture,'exit')}gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);const directory=join(root,'evidence/runs/public-gateway',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
