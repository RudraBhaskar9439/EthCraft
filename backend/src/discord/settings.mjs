import { readFile, stat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

const snowflake = /^[0-9]{5,22}$/
export async function readDiscordConfiguration(root, { required = false, credentials = true } = {}) {
  let settings
  try { settings = JSON.parse(await readFile(join(root, '.local/discord/settings.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && !required) return null; throw error }
  if (!settings || !snowflake.test(settings.applicationId || '') || !snowflake.test(settings.guildId || '')) throw Error('DISCORD_APPLICATION_AND_GUILD_REQUIRED')
  for (const key of ['panelChannelId', 'workChannelId', 'transactionsChannelId', 'welcomeChannelId', 'marketplaceChannelId']) if (settings[key] && !snowflake.test(settings[key])) throw Error('DISCORD_CHANNEL_ID_INVALID')
  if(settings.organizedServer!==undefined&&typeof settings.organizedServer!=='boolean')throw Error('DISCORD_ORGANIZED_SERVER_INVALID')
  if(settings.identityOnly!==undefined&&typeof settings.identityOnly!=='boolean')throw Error('DISCORD_IDENTITY_ONLY_MODE_INVALID')
  if(settings.agentCredentialsFile!==undefined&&!isAbsolute(settings.agentCredentialsFile))throw Error('AGENT_PRIVATE_CREDENTIAL_FILE_REQUIRED')
  const origin = new URL(settings.origin || 'http://127.0.0.1:8789')
  if (origin.origin !== (settings.origin || origin.origin) || origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw Error('DISCORD_ONBOARDING_ORIGIN_REQUIRED')
  const result = { ...settings, origin: origin.origin, serverId: settings.serverId || 'agentcity-playable', enabled: settings.enabled === true }
  if (!credentials || !result.enabled && !required) return result
  if (!isAbsolute(settings.credentialsFile || '')) throw Error('DISCORD_PRIVATE_CREDENTIAL_FILE_REQUIRED')
  const file = await realpath(settings.credentialsFile), info = await stat(file), parent = await stat(dirname(file))
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077 || parent.uid !== process.getuid() || parent.mode & 0o077)) throw Error('DISCORD_CREDENTIALS_REQUIRE_PRIVATE_UNIX_STORAGE')
  if (!info.isFile() || info.size > 8192) throw Error('DISCORD_PRIVATE_CREDENTIAL_FILE_INVALID')
  const secrets = JSON.parse(await readFile(file, 'utf8'))
  if (typeof secrets.botToken !== 'string' || secrets.botToken.length < 30 || /\s/.test(secrets.botToken)) throw Error('DISCORD_BOT_TOKEN_REQUIRED')
  return { ...result, botToken: secrets.botToken }
}
