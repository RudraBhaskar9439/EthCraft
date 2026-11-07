# EthCraft shared task progress

Arkiv holds public, expiring task-progress snapshots that both Mumbai workers and a separate client can query. The public judge demo is **https://ethcraft-arkiv.quiet-buddy-9104.chatgpt.site** and its MIT-licensed component is **https://github.com/RudraBhaskar9439/EthCraft-Arkiv**. Both live Rabdi reads and the linked-record lookup work without signing in or running this laptop. The original board remains at **http://127.0.0.1:8789/arkiv**.

The intended track fit is [Build on Arkiv](https://ethglobal.com/events/mumbai/prizes/arkiv): shared agent coordination state with a visible read, wallet ownership, queryable fields and expiry. **Prize eligibility is unresolved.** EthCraft reuses earlier AgentCity code and map assets; a new feature or repository does not make the project built from scratch. Existing-project entry requires Continuity admission, which the user says they do not have. Obtain organizer clarification; do not represent reused work as new. The complete game source is public in [EthCraft](https://github.com/RudraBhaskar9439/EthCraft). The separately extracted Arkiv reader, publisher, projection, handoff adapter and public viewer retain their provenance and MIT license. Runtime credentials and signing services remain private.

## Use in Minecraft

### Structured work orders: discovery, remaining work and server checks

The upgraded path publishes `ethcraft.work-orders.v1`. It is an exact material
workflow, separate from the older free-text objective handoff below.

1. Approve the current Minecraft connection with Discord `/join`. Both registered
   workers must belong to that approved principal, be online in Mumbai and idle.
2. Put **two oak planks** in Agent's registered source chest, **1746, 69, 2810**.
3. Run `/agent agent order create craft_delivery stick 4`. This opts the exact
   specification, item quantities, registered chest positions and stage checks
   into public storage. No private objective, player identity or execution token
   is published. Copy the returned order ID.
4. Run `/agent agent order discover`, then `/agent agent order claim <order ID>`.
   Agent reads the confirmed Arkiv specification, withdraws the two planks and
   deposits them in 0G's source chest at **1730, 69, 2810**.
5. Wait for **Supply stage passed server inventory checks**, then run
   `/agent 0g order discover` and `/agent 0g order claim <order ID>`.
   0G reads the same specification and the verified first stage from Arkiv. Its
   objective includes only withdrawal, crafting four sticks and deposit in its
   destination chest at **1730, 69, 2812**. It cannot repeat stage one.
6. Inspect `/agent 0g order status <order ID>` and the public **Work orders** board.
   Two passed server checks mark completion; the owner still reviews the result.

`delivery <item> <count>` transfers an exact item through the two workers.
`craft_delivery` supports stick, oak_planks and stone_bricks, in complete recipe
batches, with at most 32 output items. Stage tools are restricted to observe,
bounded movement, exact withdrawals/deposits and the specified recipe. Work orders
never authorize purchases, CITY spending or arbitrary builds. One unexpired order
per owner; one private active claim; one-hour execution deadline. Use
`/agent <worker> order cancel <order ID>` to cancel safely. A paused stage resumes
with the same `order claim` command, preserving receipts and operation identity.
Unknown physical effects block resume and cancellation until operator reconciliation.

Server verification reads both workers and all four registered chests on Paper's
main thread through an authenticated private observer. Source decrease, destination
increase, craft/transfer receipts and unchanged agent inventory totals must agree.
Exact work orders run through a bounded native skill, using the pinned Arkiv
specification and saved receipts to choose only the remaining withdrawal, craft
and deposit. They do not ask a model to guess recipe steps or workstation moves.
Each step gets fresh source/destination counts and passes the same receiving
guards. Supported recipes use inventory crafting. Ordinary free-form objectives
still use hosted model planning. Execution provenance records the native skill
separately from earlier model requests; this is not a model-comparison result.
The public proof exposes counts and hashes, not raw inventories or native receipts.
This is a **trusted Minecraft-server attestation**, not an independent Minecraft
oracle. Arkiv's indexed query discovers work; it is not an atomic distributed lock.
The private server owns authorization, claim fencing and all effects. Restarts and
publication timeouts preserve the same physical operation and signed transaction.

Read independently with the public component:

```sh
node scripts/query.mjs --orders
node scripts/query.mjs <work-order-entity-key>
```

The website supports `GET /api/orders?kind=craft_delivery&item=stick` and entity
lookup for both schemas. Latest-state reconstruction paginates up to 500 snapshots;
larger results explicitly fail instead of silently showing stale orders. Execution
deadlines and seven-day entity retention are different and both remain visible.

Focused checks: `node tests/discovery/work-orders.mjs` (offline fixtures) and
`node tests/maps/arkiv-work-orders.mjs` (owned isolated Paper copy only). The native
check uses a controlled offline principal, two real Minecraft workers, exactly two
fixture planks and scripted decisions. It does not use real models, owner approval,
payments or public writes. `node scripts/arkiv_work_orders.mjs --native-demo` may
publish that already-verified test as labelled Rabdi fixtures, using the existing
publisher lease, journal and gas bounds. It must not run beside another writer.
The [actual owner-driven run](../evidence/runs/arkiv-work-orders-live/b11cca47-d76f-4615-8000-938dc2e57aff/report.json) now passed both server checks. Order `1d745953-2095-48de-a716-7ac2fe849392` supplied two planks, then crafted and delivered four sticks. A separate SDK client and anonymous public API read the completed non-fixture entity `0x2d636f165eb985b5b4944d6a5ae2e6e1c48acb6e8d8114b0d447c046caff234b`. The initial model planner proposed out-of-stage movement; its rejection and retries are retained. The final target resumed through the exact receipt-driven skill, preserving its single two-plank withdrawal. This is real coordinated work and recovery, not a clean model comparison. Owner acceptance and independent-human qualification remain separate.

The [isolated native run](../evidence/runs/arkiv-work-orders-native/b865ea55-a6ca-4b0d-a05b-c9fc1ff9a87a/report.json) passed both material stages. The [real Rabdi check](../evidence/runs/arkiv-work-orders/ae5157ae-ac11-4263-b871-975e635fc867/report.json) confirmed all three immutable fixture snapshots and independent readback. Final fixture entity: `0x88af9bfd577fb9be610933a48dc4128775f4d349509aa83f5b06980543dba6e0`. These are labelled controlled test records, hidden by default on the public board.

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
