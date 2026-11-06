'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const mineflayer = require('../compatibility/node_modules/mineflayer')

const destination = process.env.AC_WORLD_REPORT
assert.ok(destination, 'AC_WORLD_REPORT is required')
const port = Number(process.env.AC_WORLD_PORT || 25577)
const timeoutSeconds = Number(process.env.AC_WORLD_TIMEOUT_SECONDS || 180)
assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 180 && timeoutSeconds <= 2880)
const expectedStatus = process.env.AC_WORLD_EXPECTED_STATUS || 'pass'
assert.ok(['pass', 'incomplete'].includes(expectedStatus))
assert.ok([25577, 25579, 25580].includes(port), 'candidate fixture requires an allowlisted isolated loopback port')
const username = 'WorldObserver'
assert.ok(username.length <= 16, 'fixture username must fit the Minecraft protocol')
const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, version: '1.21.11', auth: 'offline' })
const report = { status: 'fail', purpose: 'offline independent world-read fixture, not independent human proof', observations: [] }
let closing = false
let finished = false
let timer
let inputQueue = Promise.resolve()

function truth (value) {
  assert.ok([true, false, 'true', 'false'].includes(value), `Invalid block boolean: ${value}`)
  return value === true || value === 'true'
}

function readAt (position, material) {
  const target = bot.entity.position.offset(position[0] - bot.entity.position.x, position[1] - bot.entity.position.y, position[2] - bot.entity.position.z)
  const block = bot.blockAt(target)
  assert.ok(block, `Missing client block observation ${position}`)
  assert.equal(block.name, material)
  return block.getProperties()
}

async function finish (error) {
  if (finished) return
  finished = true
  closing = true
  clearTimeout(timer)
  if (error) report.error = String(error.stack || error)
  report.finished_at = new Date().toISOString()
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  } catch (writeError) {
    report.status = 'fail'
    report.error = `Evidence write failed: ${writeError.message}`
  }
  console.log(JSON.stringify({ status: report.status, cases: report.observations.length, error: report.error }))
  if (report.status !== expectedStatus) process.exitCode = 1
  bot.quit('Candidate observations retained')
  setTimeout(() => process.exit(process.exitCode || 0), 1000).unref()
}

bot.on('error', error => { if (!closing) finish(error) })
bot.on('kicked', reason => { if (!closing) finish(new Error(`Observer kicked: ${JSON.stringify(reason)}`)) })
bot.on('end', reason => { if (!closing) finish(new Error(`Observer ended: ${reason}`)) })
bot.on('messagestr', message => {
  if (finished) return
  try {
    if (message.startsWith('AC_CANDIDATE_CLICK ')) {
      const click = JSON.parse(message.slice('AC_CANDIDATE_CLICK '.length))
      inputQueue = inputQueue.then(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        const target = bot.entity.position.offset(click.position[0] - bot.entity.position.x, click.position[1] - bot.entity.position.y, click.position[2] - bot.entity.position.z)
        const lever = bot.blockAt(target)
        assert.ok(lever && lever.name === 'lever', 'native input requires the actual lever')
        assert.notEqual(truth(lever.getProperties().powered), click.desired_powered, 'native input request must change an actual lever')
        await bot.activateBlock(lever)
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(truth(bot.blockAt(target).getProperties().powered), click.desired_powered, 'native interaction must set the desired actual lever state')
        bot.chat(`/candidate clicked ${click.request}`)
      }).catch(finish)
    } else if (message.startsWith('AC_CANDIDATE ')) {
      const row = JSON.parse(message.slice('AC_CANDIDATE '.length))
      const client = { suite: row.suite, case_index: row.case_index, a: row.a, b: row.b, expected: row.expected, observed: row.observed, plugin_passed: row.passed, controls: [], lamps: [] }
      for (const control of row.controls) {
        const actual = readAt(control.position, 'lever')
        assert.equal(truth(actual.powered), control.powered, 'client/plugin control mismatch')
        client.controls.push({ position: control.position, properties: actual })
      }
      for (const lamp of row.lamps) {
        const actual = readAt(lamp.position, 'redstone_lamp')
        assert.equal(truth(actual.lit), lamp.lit, 'client/plugin lamp mismatch')
        client.lamps.push({ position: lamp.position, properties: actual })
      }
      report.observations.push(client)
      console.log(JSON.stringify({ suite: row.suite, case: row.case_index, a: row.a, b: row.b, expected: row.expected, actual: row.observed, passed: row.passed }))
    } else if (message.startsWith('AC_CANDIDATE_RESULT ')) {
      report.server_summary = JSON.parse(message.slice('AC_CANDIDATE_RESULT '.length))
      report.status = report.server_summary.status
      finish()
    }
  } catch (error) {
    finish(error)
  }
})
bot.once('spawn', async () => {
  try {
    assert.equal(bot.game.gameMode, 'survival')
    await bot.waitForChunksToLoad()
    await bot.waitForTicks(20)
    // Diagnostic lever actuator is teleported by the isolated fixture, not a construction/navigation proof.
    bot.physicsEnabled = false
    bot.chat('/candidate run')
  } catch (error) {
    finish(error)
  }
})
timer = setTimeout(() => finish(new Error(`Candidate observation deadline exceeded ${timeoutSeconds} seconds`)), timeoutSeconds * 1000)
