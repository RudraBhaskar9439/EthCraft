// Build the one new local world with the existing physical worker and inspection.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const data = JSON.parse(await readFile(join(root, '.local/fresh-world/active.json'), 'utf8'))
if (data.owner !== 'agentcity-fresh-local-world' || !/^agentcity-fresh-[a-f0-9]{8}$/.test(data.container) || data.tokenIntegration !== false) throw Error('owned_fresh_world_required')
const runtime = join(root, '.local/fresh-world', data.container)
const token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
const evidenceRoot = join(root, 'evidence/runs/fresh-world', data.container)
const retry = process.argv.slice(2)
if (retry.length && (retry.length !== 1 || retry[0] !== '--retry-initial')) throw Error('unsupported_build_argument')
if (retry.length) {
  const response = await fetch('http://127.0.0.1:25597/status', { headers: { Authorization: 'Bearer ' + token } })
  const status = await response.json()
  if (response.status !== 200 || status.state?.revision !== 0) throw Error('initial_retry_requires_unchanged_empty_world')
}
const evidence = retry.length ? join(evidenceRoot, 'attempt-' + randomUUID()) : evidenceRoot
await mkdir(evidence, { recursive: true })
const hash = async path => createHash('sha256').update(await readFile(join(root, path))).digest('hex')
const sources = Object.fromEntries(await Promise.all([
  'scripts/fresh_world.py', 'scripts/fresh_world_build.mjs', 'tests/construction/probe.cjs',
  'backend/src/bot/construction-worker.cjs', 'backend/src/bot/minecraft-adapter.cjs',
  'backend/src/bot/checkpoint-store.cjs', 'tests/compatibility/maintained-candidate/client-profile.cjs'
].map(async path => [path, await hash(path)])))
const manifest = { scope: 'Fresh local Minecraft construction; no blockchain, phase approval or independently verified people',
  status: 'in_progress', container: data.container, visitor: data.visitor, sources,
  pluginSha256: data.pluginSha256, fixtureSha256: data.fixtureSha256, independentHumansVerified: 0,
  tokenIntegration: false, segments: [] }
try {
  for (const phase of ['initial', 'resume']) {
    const reportPath = join(evidence, phase + '.json')
    let previous
    try { previous = JSON.parse(await readFile(reportPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous?.status === 'pass') {
      manifest.segments.push({ phase, status: 'pass', reused: true })
      continue
    }
    // Refuse overwriting an earlier failure; its original job and checkpoint need review.
    if (previous) throw Error('failed_build_requires_same_job_review')
    const environment = { ...process.env, AC_CONSTRUCTION_INTERNAL: 'true',
      AC_CONSTRUCTION_TOKEN: token, AC_CONSTRUCTION_RUNTIME: runtime, AC_CONSTRUCTION_REPORT: reportPath,
      AC_CONSTRUCTION_PHASE: phase, AC_CONSTRUCTION_GAME_PORT: '25596', AC_CONSTRUCTION_HTTP_PORT: '25597',
      AC_CONSTRUCTION_DEPENDENCY_ROOT: join(root, 'tests/compatibility/node_modules'), AC_CONSTRUCTION_SOURCE_ROOT: root }
    const log = []
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'), join(root, 'tests/construction/probe.cjs')],
        { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      const output = chunk => {
        const redacted = chunk.toString().split(token).join('<redacted-api-credential>').replace(/AC_SESSION\s+\S+\s+\S+/g, 'AC_SESSION <redacted>')
        log.push(redacted)
        process.stdout.write(redacted)
      }
      child.stdout.on('data', output); child.stderr.on('data', output)
      child.on('error', reject); child.on('exit', resolve)
    })
    await writeFile(join(evidence, phase + '.log'), log.join(''))
    const observed = JSON.parse(await readFile(reportPath, 'utf8'))
    if (code !== 0 || observed.status !== 'pass') throw Error('physical_build_failed; retained report requires review')
    manifest.segments.push({ phase, status: 'pass', checks: observed.checks.length })
  }
  const inspection = JSON.parse(await readFile(join(evidence, 'resume.json'), 'utf8')).inspection
  if (inspection?.status !== 'PASS' || inspection.rows.length !== 16 || inspection.rows.some(row => row.expected !== row.observed)) throw Error('actual_16_case_inspection_required')
  manifest.status = 'pass'; manifest.inspectionRunId = inspection.runId
} catch (error) {
  manifest.status = 'fail'; manifest.error = error.message
  process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'report.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ status: manifest.status, evidence: join(evidence, 'report.json'), error: manifest.error }))
}
