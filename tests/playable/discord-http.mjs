// Actual local HTTP assets and request boundary; no OAuth, wallet or game mutation.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const origin='http://127.0.0.1:8789'
const report={status:'fail',scope:'Local HTTP routes only; no successful OAuth, provider wallet, Discord message or Minecraft effect',checks:[]}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
try {
  let response
  for(let attempt=0;attempt<120;attempt++){
    try { response=await fetch(origin+'/api/discord/config',{signal:AbortSignal.timeout(3000)}); if(response.ok) break } catch {}
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  assert.equal(response?.status,200,'The coordinated console must finish startup before HTTP verification')
  const config=await response.json()
  assert.equal(config.configured,true);assert(config.appId)
  assert.deepEqual(Object.keys(config).sort(),['appId','applicationId','configured','origin'])
  response=await fetch(origin+'/discord/setup');assert.equal(response.status,200)
  assert.match(await response.text(),/discord-setup\.js/)
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/)
  response=await fetch(origin+'/discord-setup.js');assert.equal(response.status,200)
  assert.match(response.headers.get('content-type'),/javascript/)
  pass('current console serves Discord setup HTML compiled bundle and only public configuration')
  response=await fetch(origin+'/api/discord/complete',{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:'{}'})
  assert.equal(response.status,403)
  response=await fetch(origin+'/api/discord/wallet',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessToken:'fixture-invalid',ownerId:randomUUID()})})
  assert.equal(response.status,409)
  assert.equal((await response.json()).error,'DISCORD_SETUP_FIELDS_REQUIRED')
  pass('foreign browser origins and caller-selected wallet owners refused before identity or provider operations')
  report.status='pass'
} catch(error) { report.error=error.message;process.exitCode=1 }
finally {
  const directory=new URL('../../evidence/runs/discord-http/'+randomUUID()+'/',import.meta.url)
  await mkdir(directory,{recursive:true});await writeFile(new URL('report.json',directory),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,error:report.error,evidence:directory.pathname}))
}
