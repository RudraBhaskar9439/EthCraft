// Operator setup. Secrets are read from private storage and never printed.
import { fileURLToPath } from 'node:url'
import { readDiscordConfiguration } from '../backend/src/discord/settings.mjs'
import { discordCommands, discordInvite } from '../backend/src/discord/bot.mjs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { REST, Routes } = require('discord.js')
const root = fileURLToPath(new URL('../', import.meta.url))
const action = process.argv[2] || '--status'
if (!['--status', '--invite', '--invite-organized', '--check', '--register'].includes(action)) {
  console.error('Usage: node scripts/discord_setup.mjs --status|--invite|--invite-organized|--check|--register')
  process.exitCode = 1
} else {
  try {
    const settings = await readDiscordConfiguration(root, { required: true, credentials: ['--check', '--register'].includes(action) })
    if (action === '--invite' || action === '--invite-organized') console.log(discordInvite(settings,{organize:action==='--invite-organized'}))
    else if (action === '--status') console.log(JSON.stringify({ applicationId: settings.applicationId, guildId: settings.guildId, enabled: settings.enabled, origin: settings.origin, privateCredentialFileConfigured: Boolean(settings.credentialsFile) }))
    else {
      const rest = new REST({ version: '10' }).setToken(settings.botToken)
      const application = await rest.get(Routes.oauth2CurrentApplication())
      if (application.id !== settings.applicationId) throw Error('DISCORD_APPLICATION_TOKEN_MISMATCH')
      const guild = await rest.get(Routes.guild(settings.guildId))
      const result = { applicationId: application.id, guildId: guild.id, botAuthenticated: true, guildAccessible: true }
      if (action === '--register') {
        const commands = await rest.put(Routes.applicationGuildCommands(settings.applicationId, settings.guildId), { body: discordCommands() })
        result.registeredCommands = commands.map(command => command.name)
      }
      console.log(JSON.stringify(result))
    }
  } catch (error) {
    // Do not print SDK request details or stack traces containing Authorization.
    const code = error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : 'DISCORD_SETUP_FAILED')
    console.error(JSON.stringify({ status: 'blocked', code, next: 'Check the private bot-token configuration, application ID and server invite.' }))
    process.exitCode = 1
  }
}
