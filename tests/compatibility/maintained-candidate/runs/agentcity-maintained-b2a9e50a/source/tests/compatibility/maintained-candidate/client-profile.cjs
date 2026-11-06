'use strict'
const path = require('node:path')
const mineflayer = require(path.resolve(__dirname, '../node_modules/mineflayer'))
const createBot = mineflayer.createBot
const counts = []

// Mineflayer emits physicsTick before its movement update: close the preceding logical client tick.
mineflayer.createBot = options => {
  if (options.host !== '127.0.0.1' || options.port !== 25596 || options.version !== '1.21.11') throw new Error('candidate_client_profile_binding_required')
  const bot = createBot(options)
  const count = { player: options.username, physicsTickBoundaries: 0 }
  counts.push(count)
  bot.on('physicsTick', () => {
    if (bot._client.state !== 'play') return
    bot._client.write('tick_end', {})
    count.physicsTickBoundaries++
  })
  return bot
}
process.on('exit', () => console.log(JSON.stringify({ candidateClientProfile: '1.21.11-tick-end-at-physics-cadence', counts })))
