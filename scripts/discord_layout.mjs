// Operator-only layout preparation. --plan is read-only Discord inspection;
// --apply is the explicit channel provisioning action. No Gateway connection.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readDiscordConfiguration } from '../backend/src/discord/settings.mjs'
import { createDiscordServerLayout } from '../backend/src/discord/server-layout.mjs'
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { Client, GatewayIntentBits, Routes } = require('discord.js')
const { Pool } = require('pg')
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2)
const action = args.shift() || '--plan'
let pool, client
try {
  if (!['--plan','--apply'].includes(action) || args.length && (args.length !== 2 || args[0] !== '--agents')) throw Error('DISCORD_LAYOUT_USAGE')
  const agents = args.length ? JSON.parse(await readFile(args[1], 'utf8')) : []
  if (!Array.isArray(agents) || agents.length > 50) throw Error('DISCORD_LAYOUT_AGENTS_INVALID')
  const settings = await readDiscordConfiguration(root, { required: true })
  client = new Client({ intents: [GatewayIntentBits.Guilds] })
  client.rest.setToken(settings.botToken)
  const application = await client.rest.get(Routes.oauth2CurrentApplication())
  if (application.id !== settings.applicationId) throw Error('DISCORD_APPLICATION_TOKEN_MISMATCH')
  const guild = await client.guilds.fetch(settings.guildId)
  const configuration = JSON.parse(await readFile(new URL('../.local/backend/environment.json', import.meta.url), 'utf8'))
  pool = new Pool({ connectionString: configuration.databaseUrl, max: 3 })
  const layout = createDiscordServerLayout({ pool, guild, coordinatorBotId: application.id, serverId: settings.serverId })
  let result
  if (action === '--apply') { await layout.initialize(); result = await layout.reconcile({ agents }) }
  else result = await layout.preflight({ agents })
  console.log(JSON.stringify({ action, guildId: guild.id, ...result, existingChannelsDeleted: 0, administratorVisibility: true }))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : /^[A-Z_]+$/.test(error.message || '') ? error.message : 'DISCORD_LAYOUT_FAILED'
  console.error(JSON.stringify({ status: 'blocked', code, note: 'No raw Discord request or credential details printed.' }))
  process.exitCode = 1
} finally { if (pool) await pool.end(); if (client) client.destroy() }
