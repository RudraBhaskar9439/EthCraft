'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../../..')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

function createMaintainedBot (mineflayer, options, runtimeDirectory) {
  const configuration = fs.readFileSync(path.join(root, 'config/minecraft-runtime.json'))
  const config = JSON.parse(configuration)
  const profile = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'runtime-profile.json'), 'utf8'))
  assert.equal(config.environment, 'MAINTAINED_LOOPBACK_NON_TOKEN', 'maintained_runtime_required')
  assert.equal(config.token_integration, false, 'non_token_runtime_required')
  assert.equal(profile.schema, 'agentcity.minecraft-profile.v1', 'managed_runtime_profile_required')
  assert.equal(profile.environment, config.environment)
  assert.equal(profile.configSha256, digest(configuration), 'runtime_configuration_changed')
  assert.equal(profile.pluginSha256, config.application.sha256)
  assert.equal(digest(fs.readFileSync(path.join(runtimeDirectory, 'plugins/AgentCity.jar'))), profile.pluginSha256, 'runtime_plugin_changed')
  assert.equal(digest(fs.readFileSync(path.join(root, 'tests/compatibility/package-lock.json'))), config.dependencyLockSha256, 'client_dependency_lock_changed')
  assert.equal(profile.minecraft, '26.3')
  assert.equal(profile.minecraft, config.artifacts.paper.version)
  assert.equal(profile.client, '1.21.11')
  assert.equal(profile.client, config.client)
  assert.equal(profile.viaVersion, '5.12.2')
  assert.equal(profile.viaVersion, config.artifacts.ViaVersion.version)
  assert.equal(profile.viaBackwards, config.artifacts.ViaBackwards.version)
  assert.equal(profile.viaBackwards, '5.12.2')
  assert.equal(profile.javaImage, config.java_image)
  assert.equal(options.host, '127.0.0.1', 'loopback_bot_required')
  assert.equal(options.port, profile.gamePort, 'runtime_game_port_changed')
  assert.equal(options.version, profile.client)
  const bot = mineflayer.createBot(options)
  const count = { player: options.username, physicsTickBoundaries: 0 }
  bot.agentcityProtocol = count
  // physicsTick precedes Mineflayer's movement update; close the preceding logical tick.
  bot.on('physicsTick', () => {
    if (bot._client.state !== 'play') return
    bot._client.write('tick_end', {})
    count.physicsTickBoundaries++
  })
  return bot
}

module.exports = { createMaintainedBot }
