import { createServer } from 'node:http'
import { writeFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { createBankLaptopRuntime } from '../backend/src/bank/laptop-runtime.mjs'
import { createBankHttpHandler } from '../backend/src/bank/http.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), port = 8794
process.env.PATH = join(homedir(), '.foundry/bin') + delimiter + (process.env.PATH || '')
const capability = randomBytes(32).toString('hex')
let runtime, opening
const open = async () => runtime || (opening ||= createBankLaptopRuntime({ rootDirectory: root,
  manifestFile: '.local/marketplace/public-deployment.json' }).then(value => runtime = value).catch(error => { opening = null; throw error }))
const server = createServer(createBankHttpHandler({ rootDirectory: root, port, capability, getRuntime: open,
  staticFiles: { '/': ['marketplace.html', 'text/html; charset=utf-8'],
    '/marketplace.mjs': ['marketplace.mjs', 'text/javascript; charset=utf-8'],
    '/marketplace.css': ['bank.css', 'text/css; charset=utf-8'] } }))
server.listen(port, '127.0.0.1', async () => {
  await mkdir(join(root, '.local/marketplace'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, '.local/marketplace/server.json'), JSON.stringify({ owner: 'agentcity-laptop-marketplace',
    pid: process.pid, port, root, script: fileURLToPath(import.meta.url), capability, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  console.log('AgentCity laptop marketplace: http://127.0.0.1:' + port)
})
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return
  closing = true
  server.close()
  await runtime?.close()
  process.exit(0)
})
