'use strict'

// Two disclosed local fixtures; this is not proof of independent human ownership.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const clients = []
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const redact = text => String(text)
  .replace(/AC_SESSION\s+\S+\s+\S+/g, 'AC_SESSION <redacted>')
  .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<redacted-id>')
const report = { scope: 'Actual in-game Game Coins transfer between two disclosed Mineflayer fixtures; no agents created, real wallets, blockchain action or independently verified people',
  players: ['PlayTester', 'PlayReceiver'], status: 'fail', independentHumansVerified: 0,
  publicTransactions: 0, startedAt: new Date().toISOString(), checks: [], commands: [] }

function check(name, details = {}) {
  report.checks.push({ name, status: 'pass', ...details })
  console.log(JSON.stringify({ check: name, status: 'pass', ...details }))
}

async function deadline(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds) })])
  } finally { clearTimeout(timer) }
}

async function connect(username) {
  const client = { username, messages: [], disconnected: false }
  let spawned = false, rejectLogin
  const failed = new Promise((_, reject) => { rejectLogin = reject })
  clients.push(client)
  const bot = client.bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username,
    hideErrors: true, checkTimeoutInterval: 30000 })
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) client.messages.push(text) })
  const failedBeforeSpawn = () => { if (!spawned) rejectLogin(Error(username + ' login failed: ' + (client.error || 'connection ended before spawn'))) }
  bot.on('error', error => { client.error = redact(error.message); failedBeforeSpawn() })
  bot.on('kicked', reason => { client.error = redact(typeof reason === 'string' ? reason : JSON.stringify(reason)); client.disconnected = true; failedBeforeSpawn() })
  bot.on('end', reason => { client.error ??= redact(reason || 'connection ended'); client.disconnected = true; failedBeforeSpawn() })
  await deadline(Promise.race([once(bot, 'spawn'), failed]), 45000, username + ' login timed out' + (client.error ? ': ' + client.error : ''))
  spawned = true
  return client
}

async function command(client, input, expected) {
  await delay(650)
  const start = client.messages.length
  const record = { player: client.username, command: redact(input), replies: [] }
  report.commands.push(record)
  client.bot.chat(input)
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (client.disconnected) throw Error(client.username + ' disconnected: ' + (client.error || 'unknown reason'))
    const fresh = client.messages.slice(start)
    record.replies = fresh.map(redact)
    const matched = fresh.find(line => expected.test(line))
    if (matched) return matched
    await delay(100)
  }
  throw Error(client.username + ' timed out waiting for reply to ' + redact(input))
}

async function balance(client) {
  const namedBalance = new RegExp(client.username + ': \\d+ Game Coins available, \\d+ held')
  let line = await command(client, '/wallet', new RegExp(namedBalance.source + '|Welcome! You received your one-time 100 Game Coins starter grant'))
  if (!namedBalance.test(line)) line = await command(client, '/wallet', namedBalance)
  const parsed = line.match(/: (\d+) Game Coins available, (\d+) held/)
  assert.ok(parsed, 'Wallet must show available and held balances')
  return { available: BigInt(parsed[1]), held: BigInt(parsed[2]) }
}

async function run() {
  const sender = await connect('PlayTester')
  await delay(10000)
  const recipient = await connect('PlayReceiver')
  const beforeSender = await balance(sender)
  const beforeRecipient = await balance(recipient)
  assert.ok(beforeSender.available >= 7n, 'Fixture sender needs at least 7 existing Game Coins; the test never tops up spent balances')
  check('both-fixtures-read-actual-existing-wallet-balances', {
    senderAvailable: String(beforeSender.available), recipientAvailable: String(beforeRecipient.available) })

  const previewReply = await command(sender, '/pay PlayReceiver 7', /Confirm within 5 minutes: \/accept [a-f0-9-]{36}/i)
  const previewId = previewReply.match(/\/accept ([a-f0-9-]{36})/i)[1]
  report.previewReferenceSha256 = createHash('sha256').update(previewId).digest('hex')
  const previewSender = await balance(sender)
  const previewRecipient = await balance(recipient)
  assert.deepEqual(previewSender, beforeSender)
  assert.deepEqual(previewRecipient, beforeRecipient)
  check('in-game-payment-preview-does-not-spend-or-reserve-coins')

  await command(sender, '/accept ' + previewId, /Paid 7 Game Coins to PlayReceiver/)
  const afterSender = await balance(sender)
  const afterRecipient = await balance(recipient)
  assert.equal(afterSender.available, beforeSender.available - 7n)
  assert.equal(afterRecipient.available, beforeRecipient.available + 7n)
  assert.equal(afterSender.held, beforeSender.held)
  assert.equal(afterRecipient.held, beforeRecipient.held)
  assert.equal(afterSender.available + afterRecipient.available, beforeSender.available + beforeRecipient.available)
  check('actual-in-game-confirmation-transfers-exactly-seven-coins', {
    senderAvailable: String(afterSender.available), recipientAvailable: String(afterRecipient.available) })

  await command(sender, '/accept ' + previewId, /already completed|No additional coins were sent/i)
  assert.deepEqual(await balance(sender), afterSender)
  assert.deepEqual(await balance(recipient), afterRecipient)
  check('repeating-the-same-preview-confirmation-pays-zero-extra')
  report.status = 'pass'
}

run().catch(error => { report.error = redact(error.message); process.exitCode = 1 }).finally(async () => {
  for (const client of clients) if (client.bot && !client.disconnected) client.bot.quit('Local fixture payment verification complete')
  report.finishedAt = new Date().toISOString()
  if (process.env.AC_PLAYABLE_TEST_REPORT) {
    await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT), { recursive: true })
    await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report))
})
