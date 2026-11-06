// Packaging-only fixture. No host service, database, provider or credentials are touched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runId = randomUUID(), name = 'agentcity-packaging-smoke-' + runId.slice(0, 8)
const directory = join(root, 'evidence/runs/playable-packaging', runId)
await mkdir(directory, { recursive: true })
const report = { status: 'fail', runId, scope: 'Credential-free Docker container loopback HTTP packaging fixture only', tests: [], databaseWrites: 0, providerWallets: 0, publicTransactions: 0, realMoneySpentUsd: 0, independentHumans: 0 }
function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  if (result.status !== 0) throw Error('Docker ' + args[0] + ' failed: ' + (result.stderr || result.error?.message || '').slice(0, 1000))
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim()
}
let created = false
try {
  report.image = JSON.parse(docker(['image', 'inspect', 'agentcity-playable:deployment-candidate']))[0].Id
  docker(['run', '--detach', '--name', name, '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=0700', '--env', 'AGENTCITY_LOCAL_PORT=18789', 'agentcity-playable:deployment-candidate', 'smoke'])
  created = true
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync('docker', ['exec', name, 'node', '-e', "fetch('http://127.0.0.1:18789/api/player-wallet/config').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.status === 0) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'Credential-free HTTP server starts')
  const result = JSON.parse(docker(['exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {access,writeFile} from 'node:fs/promises'; import {get} from 'node:http';
    assert.equal(process.getuid(),10001); assert.equal(process.version,'v26.3.1');
    for(const path of ['/run/agentcity-owner/owner.json','/run/agentcity-runtime/credentials.json','/app/.local/playable-testnet/wallet-settings.json','/var/run/docker.sock'])await assert.rejects(access(path));
    await assert.rejects(writeFile('/app/forbidden','x'),e=>['EROFS','EACCES'].includes(e.code));
    const responses=[];for(const path of ['/player-wallet','/player-wallet.js','/api/player-wallet/config']){const r=await fetch('http://127.0.0.1:18789'+path);assert.equal(r.status,200);const body=await r.text();if(path.endsWith('/config'))assert.equal(JSON.parse(body).configured,false);else assert.ok(body.length>100);responses.push({path,status:r.status,bytes:body.length})}
    const badHost=await new Promise((resolve,reject)=>get('http://127.0.0.1:18789/api/player-wallet/config',{headers:{host:'untrusted.invalid'}},r=>{r.resume();resolve(r.statusCode)}).once('error',reject));assert.equal(badHost,403);
    console.log(JSON.stringify({uid:process.getuid(),node:process.version,responses,foreignHostStatus:badHost}));
  `]))
  const container = JSON.parse(docker(['inspect', name]))[0]
  assert.equal(container.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL'])
  assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  assert.equal(container.Mounts.length, 0)
  assert.equal(Object.keys(container.HostConfig.PortBindings || {}).length, 0)
  report.tests.push({ name: 'pinned-image-nonroot-readonly-no-credentials-no-docker-socket-no-published-ports', status: 'pass' })
  report.tests.push({ name: 'actual-player-page-built-bundle-config-and-foreign-host-rejection', status: 'pass', result })
  report.sourceHashes = Object.fromEntries(await Promise.all(['Dockerfile', 'Dockerfile.dockerignore', 'entrypoint.mjs', 'compose.yaml', 'compose.infrastructure.yaml', 'nginx.conf.example', 'wallet-upstream.conf'].map(async path => [path, createHash('sha256').update(await readFile(join(root, 'ops/playable-production', path))).digest('hex')])))
  let auditEvidence
  try {
    const before = JSON.parse((await readFile(join(root, '.local/companion-audit-before.json'), 'utf16le')).replace(/^\uFEFF/, ''))
    const after = JSON.parse((await readFile(join(root, '.local/companion-audit-after.json'), 'utf8')).replace(/^\uFEFF/, ''))
    await writeFile(join(directory, 'companion-audit-before.json'), JSON.stringify(before, null, 2) + '\n')
    await writeFile(join(directory, 'companion-audit-after.json'), JSON.stringify(after, null, 2) + '\n')
    assert.equal(after.vulnerabilities.ws, undefined, 'Vulnerable ws8.18 overrides remove the ws advisories')
    auditEvidence = { companionBefore: before.metadata.vulnerabilities, companionAfter: after.metadata.vulnerabilities }
  } catch (error) { if (error.code !== 'ENOENT') throw error; auditEvidence = { auditEvidence: 'Not supplied; this run verifies packaging only' } }
  report.buildFindings = { botDependencyAudit: 'npm ci reported 6 moderate vulnerabilities in existing lockfile', ...auditEvidence,
    compatibleFix: 'Only ws8.18.0 and8.18.3 overridden to8.21.0; no force or SDK major changes',
    unresolved: 'Zod3->4 API major, decode-uri-component CJS->ESM and UUID buffer bounds; production release remains blocked pending supported upstream fixes and authentication verification' }
  report.status = 'pass'
} catch (error) {
  report.error = error.message.slice(0, 2000)
  process.exitCode = 1
} finally {
  if (created) { report.containerLog = docker(['logs', name]); docker(['rm', '--force', name]) }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ status: report.status, evidence: directory, tests: report.tests.length, error: report.error }))
