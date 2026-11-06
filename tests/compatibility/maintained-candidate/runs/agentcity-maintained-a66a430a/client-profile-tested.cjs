'use strict'
const path = require('node:path')
const mineflayer = require(path.resolve(__dirname, '../node_modules/mineflayer'))
const createBot = mineflayer.createBot
const counts = []

// Candidate profile only: send complete finite coordinates for status-only movement through Via26.3.
mineflayer.createBot = options => {
  if (options.host !== '127.0.0.1' || options.port !== 25596 || options.version !== '1.21.11') throw new Error('candidate_client_profile_binding_required')
  const bot = createBot(options)
  const count = { player: options.username, promotedStatusOnlyPackets: 0 }
  counts.push(count)
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, data) => {
    if (name !== 'flying') return write(name, data)
    const position = bot.entity?.position
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) throw new Error('candidate_finite_position_required')
    count.promotedStatusOnlyPackets++
    return write('position', { x: position.x, y: position.y, z: position.z, onGround: data.onGround,
      flags: { onGround: Boolean(data.flags?.onGround ?? data.onGround), hasHorizontalCollision: Boolean(data.flags?.hasHorizontalCollision) } })
  }
  return bot
}
process.on('exit', () => console.log(JSON.stringify({ candidateClientProfile: 'complete-position-instead-of-status-only', counts })))
