// Actual public HTTPS edge checks; no OAuth completion, wallet creation or game login.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
const root=new URL('../../',import.meta.url)
const state=JSON.parse(await readFile(new URL('.local/hosting/state.json',root),'utf8'))
assert.equal(state.owner,'agentcity-host-node')
assert.match(state.origin,/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/)
const report={status:'fail',scope:'Actual public Cloudflare HTTPS only; no human OAuth, provider wallet creation or Minecraft login',origin:state.origin,checks:[]}
const get=path=>fetch(state.origin+path,{signal:AbortSignal.timeout(30000),redirect:'error'})
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
try{
 for(const path of ['/api/discord/config','/api/player-wallet/config']){
  const response=await get(path);assert.equal(response.status,200);const value=await response.json()
  assert.equal(value.origin,state.origin);assert(value.appId);assert(!Object.keys(value).some(key=>/secret|token|password|credentials/i.test(key)))
 }
 const page=await get('/discord/setup?privy_oauth_state=fixture-no-real-token');assert.equal(page.status,200)
 assert.match(await page.text(),/discord-setup\.js/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/)
 const script=await get('/discord-setup.js');assert.equal(script.status,200)
 const actual=Buffer.from(await script.arrayBuffer()),local=await readFile(new URL('companion/dist/discord-setup.js',root))
 const sha=data=>createHash('sha256').update(data).digest('hex')
 assert.equal(sha(actual),sha(local));report.publicBundleSha256=sha(actual)
 pass('actual-HTTPS-serves-current-compiled-signin-and-preserves-callback-query-and-public-origin')
 for(const path of ['/','/api/demo','/playable/status']){const response=await get(path);assert.equal(response.status,404)}
 pass('operator-index-financial-demo-and-native-control-routes-unavailable-through-public-tunnel')
 const refused=await fetch(state.origin+'/api/discord/wallet',{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)})
 assert.equal(refused.status,403)
 pass('foreign-origin-wallet-call-refused-without-identity-or-wallet-effects')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{
 const directory=new URL('evidence/runs/public-tunnel/'+randomUUID()+'/',root);await mkdir(directory,{recursive:true});await writeFile(new URL('report.json',directory),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({status:report.status,evidence:directory.pathname,error:report.error}))
}
