# EthCraft shared task progress

Arkiv holds public, expiring task-progress snapshots that both Mumbai workers and a separate client can query. The public judge demo is **https://ethcraft-arkiv.quiet-buddy-9104.chatgpt.site** and its MIT-licensed component is **https://github.com/RudraBhaskar9439/EthCraft-Arkiv**. Both live Rabdi reads and the linked-record lookup work without signing in or running this laptop. The original board remains at **http://127.0.0.1:8789/arkiv**.

The intended track fit is [Build on Arkiv](https://ethglobal.com/events/mumbai/prizes/arkiv): shared agent coordination state with a visible read, wallet ownership, queryable fields and expiry. **Prize eligibility is unresolved.** EthCraft reuses earlier AgentCity code and map assets; a new feature or repository does not make the project built from scratch. Existing-project entry requires Continuity admission, which the user says they do not have. Obtain organizer clarification; do not represent reused work as new. The complete game repository remains private; the extracted Arkiv reader, publisher, projection, handoff adapter and public viewer are now public with their provenance and MIT license.

## Use in Minecraft

Keep Minecraft connected and approve the actual connection with Discord `/join`.

```text
/agent agent task Gather wood and build a small house using available supplies.
/agent agent publish
/agent agent board
/agent agent wait
/agent 0g handoff <source-job-UUID-from-the-board>
/agent 0g status
/agent 0g unshare
```

`publish` opts the current objective into public **typed action facts and block positions**. It excludes the prompt, working plan, private reasoning, messages, Discord/player identifiers, inventory dump and raw wallet/native receipts. Future updates follow observed progress while the worker runs. `unshare` stops future updates; an already submitted record remains public until expiry or deletion by its publisher.

Handoff uses the same approved owner's other worker. It pauses the source, waits for work to stop, rejects unknown effects and active locks, publishes the safe state and **reads that entity from Arkiv** before creating a new target objective. Its local private objective stays local. The target receives advisory facts, observes the actual world and its own supplies, and retains its own tool, wallet and inference guards. Materials are not teleported between workers. Deposit supplies in a shared registered chest before switching when the next stage needs them. A durable handoff marker prevents the source objective from restarting during transfer. Arkiv data never grants permissions or proves payment.

## Run a query without the game or backend

```sh
npm ci --prefix backend --ignore-scripts
node scripts/arkiv_tasks.mjs --query
node scripts/arkiv_tasks.mjs --query provider=0g
node scripts/arkiv_tasks.mjs --query provider=claude status=paused
node scripts/arkiv_tasks.mjs --query offset=100
```

The public [deployment manifest](deployment.json) supplies the namespace and publisher when local configuration is absent. Rabdi chain **7794095**, public RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`. Writer wallet: **0x5a262B9621eD0F00Fe776bb85084E9561cF18608**. An optional `ARKIV_ACCESS_KEY` environment variable enables an Arkiv Hub access key for this CLI; never commit local credentials. Reads are currently tested against the free public endpoint, which is rate limited.

The SDK query is:

```js
client.select('*').from(TaskProgress)
  .ownedBy('0x5a262B9621eD0F00Fe776bb85084E9561cF18608')
  .where(eq('server', '85f700ee06a3208b76d02f3aef30c330aca35dddab2daa1074f5281db9e3d501'))
  .orderBy(desc('revision')).limit(100).offset(0).fetch()
```

Use the exported schema in `backend/src/arkiv/tasks.mjs`. Revision deduplication and status filtering occur after the read. Older pages are history; the UI does not claim an old paused revision is the globally current state. Reads reject other publishers, malformed payloads and wrong namespaces.

## Operator setup and qualification

```sh
node scripts/arkiv_tasks.mjs --prepare
node scripts/arkiv_tasks.mjs --status
node tests/discovery/task-board.mjs
node scripts/arkiv_tasks.mjs --demo
```

The writer reuses the separate development publisher keystore, **not a player's Privy wallet**. It preserves a private publication journal in `.local/arkiv/publications.json`, including signed bytes before broadcast. A timeout reconciles or rebroadcasts the same transaction; it never substitutes a new signed operation. Successful receipts are checked against the engine event, entity contents and publisher. The reserved gas ceiling is **0.1 tGLM per transaction and 1 tGLM cumulative**, at most 200 snapshots in this deployment journal. Usage and history do not reset on task restart. No mainnet assets, CITY, swaps, agent spending or inference calls are used for publication. A depleted cap stops publication, not local game recovery.

`--demo` creates explicitly labelled **controlled data fixtures** on the real testnet, reads through a second SDK client and checks original-transaction reuse. Reports are saved in `evidence/runs/arkiv-tasks/`, including failures. These checks are not actual owner handoffs, independent-human participation, paid labor settlement or canonical phase approval. Old Tiramisu discovery and its history are retained separately; the new route uses the pinned SDK **1.0.1** alias without upgrading the legacy SDK 0.8.1 in place.

## Submission materials and AI disclosure

The [live owner handoff report](../evidence/runs/arkiv-tasks/5118171b-8469-48a5-876f-0b1ce7b6efb8/report.json) records the actual player's publish/board/handoff test and matching Rabdi reads. The [release checks](../evidence/runs/arkiv-tasks/e6669461-91f9-4d1f-b078-effb6539c067/checks.json) record passing receiving-boundary, Survival, worker and planning-infrastructure tests. These results do not mark canonical phase gates or prize eligibility passed.

See [schema](schema.md), [friction](friction.md), [reach](reach.md), [why Arkiv](why-arkiv.md) and [how Arkiv is used](how-you-use-arkiv.md). AI assisted research, code, tests and documentation. Controlled tests and unverified human actions are labelled separately. The [MIT license](LICENSE) covers the newly authored integration files listed there; it does not relicense earlier project code, maps or dependencies.
