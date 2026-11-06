import { createServer } from 'node:http'
import { writeFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { createBankLaptopRuntime } from '../backend/src/bank/laptop-runtime.mjs'
import { createBankHttpHandler } from '../backend/src/bank/http.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), port = 8794, origin = `http://127.0.0.1:${port}`
process.env.PATH = join(homedir(), '.foundry/bin') + delimiter + (process.env.PATH || '')
const capability = randomBytes(32).toString('hex')
let runtime, opening
const open = async () => runtime || (opening ||= createBankLaptopRuntime({ rootDirectory: root }).then(value => runtime = value).catch(error => { opening = null; throw error }))
const server = createServer(createBankHttpHandler({ rootDirectory: root, port, capability, getRuntime: open }))
server.listen(port, '127.0.0.1', async () => {
  await mkdir(join(root, '.local/bank'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, '.local/bank/server.json'), JSON.stringify({ owner: 'agentcity-laptop-bank', pid: process.pid, port, root,
    script: fileURLToPath(import.meta.url), capability, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  console.log('AgentCity laptop testnet bank: ' + origin)
})
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true
  server.close()
  await runtime?.close()
  process.exit(0)
})
