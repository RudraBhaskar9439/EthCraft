import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Events, MessageFlags } from '../../backend/node_modules/discord.js/src/index.js'
import { bankReply, createDiscordBridge, discordCommands } from '../../backend/src/discord/bot.mjs'
import { createBankDiscordRuntime } from '../../backend/src/discord/bank-runtime.mjs'

const root = new URL('../../', import.meta.url), runId = randomUUID()
const report = { schema: 'agentcity.bank-bot-transport.v1', runId, scope: 'In-memory Discord transport and service fixtures only; no credentials, network, database, or actual signatures.', checks: [], publicDiscordPosts: 0, gatewayConnections: 0, publicTransactions: 0, actualSignatures: 0 }
const check = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
const users = [1, 2, 3].map(index => ({ discordUserId: '66000000000000000' + index, ownerId: randomUUID(), ownerName: 'Fixture' + index }))
const settings = { enabled: true, applicationId: '880000000000000001', guildId: '770000000000000001', botToken: 'fixture-only', organizedServer: true }
const identity = { getOwner: async id => users.find(user => user.discordUserId === id) || null }
const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) }
const agents = { status: () => [], handleRemote: async () => { throw Error('UNEXPECTED_AGENT_ACTION') } }
const loans = { borrower: '0x' + '2'.repeat(40), tokenId: '7', ownershipNonce: '3', revision: '2', snapshotHash: '0x' + 'a'.repeat(64), valuation: '10000000', principal: '3000000', repayment: '3030000', term: 3600, grace: 600, offerExpiry: 1900000100, auctionDuration: 1800, auctionReserve: '3000000' }
const loanId = '0x' + 'b'.repeat(64), workId = '0x' + 'c'.repeat(64)
const work = { workId, amount: '2000000000000000000', worker: '0x' + '3'.repeat(40), deadline: 1900000200, reviewPeriod: 600, termsHash: '0x' + 'd'.repeat(64), status: 'funded' }
const records = new Map(), requests = [], confirmationRequests = [], registrations = []
let fixtureSignatures = 0, runtime
const service = {
  async preview(request) {
    requests.push(request)
    let terms = { loanId, loanTerms: loans }
    if (request.action === 'swap') terms = { tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountOut: '2000000000000000000', maximum: '1250000', deadline: 1900000100 }
    if (request.action === 'workfund') terms = { ...work, workDeadline: work.deadline }
    const value = { operationId: request.operationId, action: request.action, terms, status: 'preview', termsDigest: 'fixture-exact-terms', expiresAtMs: 1900000000000, consented: false }
    records.set(request.operationId, { principalId: request.principalId, value })
    return value
  },
  async status({ principalId, operationId }) {
    const record = records.get(operationId)
    if (!record || record.principalId !== principalId) throw Error('BANK_OPERATION_OWNER_REQUIRED')
    return record.value
  },
  async confirm(input) {
    assert.equal(runtime.authorize(input), true, 'Only actual click enters the adapter consent context')
    confirmationRequests.push(input)
    const value = await this.status(input)
    if (!value.consented) { fixtureSignatures++; value.consented = true; value.status = 'complete' }
    return value
  },
  async loans() { return { loans: [{ loanId, terms: loans, status: 'active' }] } },
  async history() { return { principalBorrowed: '3000000', principalRepaid: '3000000', timelyPrincipalRepaid: '3000000', timelyLoansRepaid: '1', defaults: '0', badDebt: '0', activePrincipal: '0', feePips: 3000 } },
  async credits() { return { amountBaseUnits: '3030000', token: 'USDC' } },
  async works() { return { works: [work] } }
}
runtime = await createBankDiscordRuntime({ identity, service })
function fakeClient() {
  const client = new EventEmitter()
  client.user = { id: settings.applicationId }
  client.guilds = { fetch: async id => {
    assert.equal(id, settings.guildId)
    return { members: { fetch: async userId => { if (!users.some(user => user.discordUserId === userId)) throw Error('FIXTURE_NOT_IN_GUILD'); return { id: userId } } } }
  } }
  client.login = async () => { setImmediate(() => client.emit(Events.ClientReady)) }
  client.destroy = () => {}
  return client
}
async function bridge(bank) {
  return createDiscordBridge({ settings, pool, identity, agents, bank, client: fakeClient(),
    restClient: { put: async (_route, payload) => { registrations.push(payload.body) } },
    experienceFactory: async () => ({ start: async () => {}, close: async () => {}, status: () => ({ fixture: true }) }) })
}
function interaction(values = {}, user = users[0]) {
  const value = { id: randomUUID(), user: { id: user.discordUserId, bot: false }, guildId: settings.guildId, commandName: values.commandName || 'bank', customId: values.customId, responses: [], deferred: false, replied: false,
    options: { getString: name => typeof values[name] === 'string' ? values[name] : null, getInteger: name => typeof values[name] === 'number' ? values[name] : null, getUser: name => values[name] ? { id: values[name] } : null },
    deferReply: async payload => { assert.equal(payload.flags, MessageFlags.Ephemeral); value.deferred = true },
    editReply: async payload => { assert(value.deferred); value.responses.push(payload); value.replied = true },
    reply: async payload => { assert.equal(payload.flags, MessageFlags.Ephemeral); value.responses.push(payload); value.replied = true },
    isAutocomplete: () => false, isButton: () => Boolean(values.customId), isChatInputCommand: () => !values.customId, isStringSelectMenu: () => false, isModalSubmit: () => false }
  return value
}
const text = response => [response.content, ...(response.embeds || []).flatMap(embed => { const value = embed.toJSON(); return [value.description || '', ...(value.fields || []).map(field => field.name + ': ' + field.value)] })].join('\n')
const confirmation = response => response.components[0].toJSON().components[0].custom_id
let enabled, disabled
try {
  const legacy = discordCommands(), configured = discordCommands({ bankEnabled: true }), command = configured.at(-1)
  assert.deepEqual(legacy, discordCommands({ bankEnabled: false }))
  assert.deepEqual(configured.slice(0, -1), legacy)
  assert.equal(legacy.some(value => value.name === 'bank'), false)
  assert.equal(command.name, 'bank'); assert(command.options.length <= 25)
  assert.deepEqual(command.options[0].choices.map(value => value.value), ['loans','history','credits','works','offer','borrow','cancel_offer','repay','auction','bid','settle','claim','withdraw','swap','checkout','workfund','workaccept','workrefund','status','retry'])
  assert.equal(command.options.find(option => option.name === 'borrower').type, 6)
  assert.equal(command.options.find(option => option.name === 'worker').type, 6)
  assert(command.options.some(option => option.type === 4)); check('Bank command is opt-in; existing commands are unchanged and new options are typed and bounded')

  disabled = await bridge()
  await disabled.start()
  assert.equal(registrations.at(-1).some(value => value.name === 'bank'), false)
  const missing = interaction({ action: 'borrow', loan: loanId }); await disabled.interaction(missing)
  assert.equal(requests.length, 0); assert.equal(fixtureSignatures, 0)
  const panel = interaction({ commandName: 'agents' }); await disabled.interaction(panel)
  assert(panel.responses[0].components.length); check('No bank runtime means no bank registration or signing; legacy agent panel still works')

  enabled = await bridge(runtime); await enabled.start()
  assert.equal(registrations.at(-1).at(-1).name, 'bank')
  const offer = interaction({ action: 'offer', borrower: users[1].discordUserId, principal: '3', repayment: '3.03', valuation: '10', term: 3600, grace: 600, reserve: '3', auction_duration: 1800, asset: '7' })
  await enabled.interaction(offer)
  const request = requests.at(-1), content = text(offer.responses[0])
  assert.equal(request.borrowerPrincipalId, users[1].ownerId); assert.equal(request.principalId, users[0].ownerId)
  for (const fragment of ['3 USDC','3.03 USDC','Asset 7','3600 seconds / 600 seconds','10 USDC','1800 seconds / 3 USDC','1900000100']) assert(content.includes(fragment), fragment)
  assert.equal(fixtureSignatures, 0); assert.equal(runtime.authorize({}), false)
  const originalId = request.operationId, buttonId = confirmation(offer.responses[0])
  assert.throws(() => bankReply({ operation: { action: 'borrow', status: 'preview', operationId: 'invalid', terms: {} }, confirmation: { operationId: 'invalid' } }), /BANK_EXACT_LOAN_TERMS_REQUIRED/)
  assert.equal(buttonId, 'ac:bank-confirm:' + encodeURIComponent(originalId)); check('Loan preview shows exact immutable money, collateral, term, grace and auction terms without signing')

  const wrong = interaction({ customId: buttonId }, users[2]); await enabled.interaction(wrong)
  assert.equal(confirmationRequests.length, 0)
  const accepted = interaction({ customId: buttonId }); await enabled.interaction(accepted)
  assert.equal(fixtureSignatures, 1); assert.equal(confirmationRequests[0].operationId, originalId)
  assert.equal(confirmationRequests[0].confirmationId, 'discord:' + accepted.id)
  assert.equal(confirmationRequests[0].principalId, users[0].ownerId)
  await enabled.interaction(interaction({ customId: buttonId })); assert.equal(fixtureSignatures, 1)
  assert.equal(runtime.authorize(confirmationRequests[0]), false); check('Only actual preview owner can confirm; original operation survives click IDs and repeat clicks do not resign')

  const swap = interaction({ action: 'swap', token_in: 'USDC', token_out: 'CITY', amount: '2', maximum: '1.25' })
  await enabled.interaction(swap)
  assert.equal(requests.at(-1).amountOut, '2'); assert.equal(requests.at(-1).maxAmountIn, '1.25')
  const swapText = text(swap.responses[0]); for (const fragment of ['2 CITY','1.25 USDC','1900000100','Preview expires']) assert(swapText.includes(fragment))
  assert.equal(fixtureSignatures, 1)
  assert.throws(() => bankReply({ operation: { action: 'swap', status: 'preview', operationId: 'invalid', terms: {} }, confirmation: { operationId: 'invalid' } }), /BANK_EXACT_SWAP_TERMS_REQUIRED/)
  check('Exact-output swap displays maximum spend and both deadlines before confirmation; incomplete terms fail closed')

  const funding = interaction({ action: 'workfund', worker: users[1].discordUserId, work: workId, amount: '2', deadline: 1900000200, review: 600 })
  await enabled.interaction(funding)
  assert.equal(requests.at(-1).workerPrincipalId, users[1].ownerId)
  assert(text(funding.responses[0]).includes('2 CITY')); assert(text(funding.responses[0]).includes(work.termsHash))
  const count = requests.length
  await enabled.interaction(interaction({ action: 'offer', borrower: '660000000000000099' }))
  assert.equal(requests.length, count); check('Borrowers and workers resolve verified guild identity IDs; unknown recipients dispatch nothing')

  const before = requests.length, confirms = confirmationRequests.length
  const foreignGuild = interaction({ action: 'offer' }); foreignGuild.guildId = '770000000000000099'
  await enabled.interaction(foreignGuild); assert.equal(foreignGuild.deferred, false)
  const bot = interaction({ action: 'offer' }); bot.user.bot = true; await enabled.interaction(bot)
  const expired = interaction({ action: 'offer' }); expired.deferReply = async () => { throw Object.assign(Error('Unknown interaction'), { code: 10062, status: 404 }) }
  await enabled.interaction(expired)
  const expiredClick = interaction({ customId: buttonId }); expiredClick.deferReply = expired.deferReply
  await enabled.interaction(expiredClick)
  assert.equal(requests.length, before); assert.equal(confirmationRequests.length, confirms)
  check('Wrong guild, bot user and failed acknowledgement dispatch no previews or confirmations')

  for (const action of ['loans','history','credits','works']) {
    const read = interaction({ action }); await enabled.interaction(read)
    assert.equal(read.deferred, true); assert.equal(read.responses[0].components.length, 0)
    const content = text(read.responses[0]); assert(!content.includes('[object Object]'))
    assert(content.includes(action === 'loans' ? '3.03 USDC' : action === 'history' ? '0.3%' : action === 'credits' ? '3.03 USDC' : '2 CITY'))
  }
  assert.equal(fixtureSignatures, 1); check('Loans, wallet history, credits and work are readable ephemeral replies without confirmation or signing')
  report.result = 'pass'; report.fixtureSignatures = fixtureSignatures
} catch (error) { report.result = 'fail'; report.error = error.message; throw error }
finally {
  await enabled?.close(); await disabled?.close()
  report.sourceHashes = Object.fromEntries(await Promise.all(['backend/src/discord/bot.mjs','backend/src/discord/bank-runtime.mjs','tests/bank/bot-transport.mjs'].map(async path => [path, createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')])))
  const directory = new URL('evidence/runs/bank-bot-transport/' + runId + '/', root)
  await mkdir(directory, { recursive: true }); await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n')
  console.log('Evidence: ' + directory.pathname)
}
