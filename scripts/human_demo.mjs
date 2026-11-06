import { readMinecraftAuthority } from '../backend/src/identity/minecraft-sessions.mjs'
import { requireHumanIdentities } from '../backend/src/workflow/human-demo.mjs'
import { openHumanDemoRuntime } from '../backend/src/workflow/human-demo-runtime.mjs'

const [command, value, builder, ...rest] = process.argv.slice(2)
const hash = /^0x[a-f0-9]{64}$/i
if (rest.length || !['--identities', '--register', '--status', '--funding-plan'].includes(command) ||
    (command === '--identities' ? !value || !builder : !hash.test(value || '') || builder)) {
  throw new Error('usage: --identities REQUESTER_WALLET BUILDER_WALLET | --register AGREEMENT_HASH | --status AGREEMENT_HASH | --funding-plan AGREEMENT_HASH')
}
const authority = ['--identities', '--register'].includes(command) ? await readMinecraftAuthority() : null
const runtime = await openHumanDemoRuntime({ identityServerId: authority?.metadata.serverId })
try {
  let result
  if (command === '--identities') result = { identities: await requireHumanIdentities({ store: runtime.store, serverId: authority.metadata.serverId, requester: value, builder }),
    source: 'historical_authenticated_login_and_wallet_control', simultaneousMultiplayerVerified: false }
  if (command === '--register') {
    const registered = await runtime.workflow.register(value)
    result = { agreementHash: registered.agreement_hash, jobId: registered.job_id, status: 'registered', humanWalletActionsRequired: true }
  }
  if (command === '--status') result = await runtime.workflow.sync(value)
  if (command === '--funding-plan') result = await runtime.workflow.fundingPlan(value)
  console.log(JSON.stringify({ ...result, realMoneySpent: 0, transactionsSubmittedByCommand: 0, economicBridge: false }, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2))
} finally { await runtime.close() }
