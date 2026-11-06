# AgentCity teammate handoff

> **Historical handoff — superseded for current operations.** Use the [1 November 2026 handoff](HANDOFF_2026-11-01.md) for the active server, commands, on-chain-only economy, verification limits and AI roadmap. The split route, repository and host details below describe the earlier checkpoint and are retained as history.

Prepared 30 October 2026, Asia/Calcutta. Code baseline: **`f207aee15c0ca0b26a460e9f4cc1b1a89b696263`**, branch **`main`**.

Private repository: https://github.com/RudraBhaskar9439/agentcity-minecraft

Code checkpoint: https://github.com/RudraBhaskar9439/agentcity-minecraft/commit/f207aee15c0ca0b26a460e9f4cc1b1a89b696263

## Start here

AgentCity has a working private developer pilot through the revised Phase 8 route. It has **not** completed independent-human acceptance or production qualification. The latest implementation added the human-wallet transaction flow, guarded retries, bounded test-resource provisioning and explicit synthetic market refresh. That new human flow is implemented and fixture-tested, but still requires authenticated Minecraft identities.

The owner has now confirmed they do **not** have a Microsoft account owning Minecraft Java Edition. The proposed continuation is a **wallet-only human contract demonstration**, alongside the existing separate Minecraft bot demonstration. **The wallet-only path has not been implemented.** Start with that work; do not keep asking the owner to retry a licensed Java login they cannot supply.

The fastest continuation is to develop against the repository and use the existing laptop runtime. A clone alone does not contain the database, saved worlds, downloaded runtime artifacts, local pointers or encrypted operator wallets. A clean-machine deployment has not been qualified.

### First hour

1. Obtain private GitHub repository access from Rudra and read `AGENTS.md`.
2. Read `evidence/HUMAN_WORKFLOW_CHECKPOINT.json`, `docs/HUMAN_DEMO.md` and `docs/DEPLOYMENT_ROUTE.md`.
3. Inspect the proposed wallet-only changes in the next section before running any transaction-producing command.
4. On the current host, run `python3 scripts/local_host.py status`. All six services were healthy at the handoff check on 30 October 2026 at approximately 21:24 IST.
5. Implement the wallet-only path as an explicit new verification mode, preserve the old game-authentication evidence, run focused tests, then arrange the real participants' wallet actions.

All file paths below are relative to the repository root unless an absolute host path is given. Later documentation-only commits may follow the code baseline above.

## Scope and decisions to preserve

- **Real spending limit: $0.** Local computation and already-authorized faucet-funded testnet operations are allowed. No mainnet, paid cloud, purchased cryptocurrency or paid model provider is authorized.
- **Minecraft and blockchain remain separate.** Game materials, access, construction and rewards must not depend on token balances, purchases or payouts. The contract demonstration uses synthetic stock, construction and inspection.
- **Ollama replaces unavailable 0G for the current route.** The installed model is `qwen3:1.7b`. Live 0G usage, billing and provenance have not been verified and are not needed to continue this route.
- The laptop is the temporary host. Web and game services remain on loopback. The operator console is for a trusted local operator; it has no shared-user authentication or application roles.
- Two real participants must perform their own wallet actions. Two AI agents, two generated wallets or two browser sessions do not establish independent human participation.
- The owner previously requested focused happy-path, authorization, accounting and retry checks, **not a deep edge-case sweep**. Keep historical broader requirements; do not mark them passed without execution.
- Use readable modules and existing adapters. Do not add general agent frameworks, arbitrary builds, additional markets, dynamic fees or unnecessary microservices.
- Push meaningful checkpoints with a description and test results. The earlier instruction to pause after each push was revoked; a push is not a phase gate.
- Human private keys, passwords and seed phrases remain with their owners. The server prepares transactions; each human confirms their own wallet prompt.

The original integrated Minecraft-token/0G research specification is retained for traceability. The revised pilot does not pass those original gates. Do not wire the synthetic contract receiver into the Minecraft plugin to make a demo appear integrated.

## Project behavior

The Minecraft component constructs a fixed two-bit redstone adder. Inputs A and B each range from 0 to 3; three weighted lamps display their sum. The protected checker tests all 16 combinations against actual block states. The historical failure-and-repair demonstration produced 16/16, then 10/16 with a missing carry output, then 16/16 after repair.

The construction worker makes 144 actual Survival placements using this bill:

| Material | Quantity |
| --- | ---: |
| Stone bricks | 65 |
| Levers | 4 |
| Repeaters | 16 |
| Redstone torches | 37 |
| Redstone dust | 19 |
| Redstone lamps | 3 |

The fixed access infrastructure, 198 glass blocks and nine bottom stone slabs, is disclosed separately. It is not circuit stock or token backing.

The separate contract demonstration coordinates signed terms, labor escrow, capped procurement, one synthetic material bundle, a synthetic build and inspection, explicit requester acceptance and a builder pull claim. Example terms are **6 test CRED labor**, **at most 3 test CRED materials**, and **one whole KIT**. Tokens use 18 decimals; KIT issuance/redemption counts are whole integers. No real-value price or CRED peg is promised.

## Phase status

“Verified” below describes the stated revised environment and evidence, not automatic renewal of every original canonical gate.

| Phase | Implemented and observed | Remaining implementation or verification |
| --- | --- | --- |
| P0 foundations | Scope, trust boundaries, version pins, phase tooling, preserved requirements and zero-budget route | Adopt explicit wallet-only acceptance criteria for new sessions. Recheck relevant evidence when code or dependencies change. |
| P1 calculator | Actual protected calculator behavior, permission checks, item consumption and real 16-case inspections | Broader retained release families remain separate. Renew affected game checks if plugin/runtime changes. |
| P2 construction | 144 actual placements/receipts, exact stock consumption, lost-reply resumption and protected 16/16 inspection | No licensed human multiplayer proof. Distributed-worker fencing is not established by the single-host checkpoint lock. |
| P3 inference | Proposal validation, budgets and receiving-boundary checks; actual local Ollama decisions | Live 0G remains unverified. No need to block wallet-only work on it. |
| P4 identities and discovery | Wallet challenges, EIP-712 agreements, PostgreSQL state, real local/public Arkiv developer discovery; game-auth observer implemented | **First priority: wallet-only participant mode.** Then actual human approvals and any required human-owned Arkiv records. Genuine Minecraft identity remains unverified. |
| P5 custody and issuance | Actual local/public contracts, separate roles, unique deposits and synthetic item-level backing | New human provisioning path needs an actual approved run. Synthetic backing is not Minecraft inventory or audited physical custody. |
| P6 registry and market | Actual v4 pool/hook, sequenced reports, bounded freshness and public testnet swap; explicit human-flow publisher action added | Execute the new publisher action live when the human flow is ready. Read current registry state; old healthy reports expire. |
| P7 procurement and delivery | Actual developer public purchase, canonical claim and one-time synthetic delivery; signed-byte and intent reconciliation | Real participant purchase through the new wallet flow and same-job recovery proof. Keep original nonce, quote, budget reservation and destination after uncertainty. |
| P8 inspection and settlement | Protected synthetic report, requester-only acceptance, immutable allocation, pull claim and developer replay paying zero extra | Actual human review, acceptance, builder claim and replay. Finish an accessible timeout/refund entrypoint if required; the backend action exists but the guided UI mainly covers the success path. |
| P9 experience and recovery | Local console, human test page, maintained host, actual database/service/world/local-chain recovery work | Shared-user auth/roles, portable setup, off-laptop coordinated recovery, full reboot, complete revised human experience, operational release qualification. Original broader game/recovery families remain retained. |
| P10 comparative research | Protocol and experiment plan retained | E1–E8 experiments and actual measurements remain future work. Do not infer AI superiority, organic demand or sustainable returns from one demo. |

Current release status: **P4 human verification blocked; P8 human signoff pending; production not qualified.** Local and developer-public work can be reviewed independently of that blocker.

## First implementation task for the teammate

### Add wallet-only participation

The current blocker is a product dependency in code, not a missing API key. `/human` requires two genuine online Minecraft WalletLinks before creating the final timed agreement. The owner cannot satisfy that entitlement requirement.

Implement a clearly labelled mode such as `wallet_only_synthetic` for **new** contract-demo sessions. Keep the existing game-linked mode and evidence intact.

Suggested minimal approach:

1. Persist an explicit, immutable verification mode on the new session/demo binding. Bind any changed agreement terms or scope into the canonical signed agreement. Never reinterpret an already approved or funded agreement.
2. Reuse the existing exact EIP-712 agreement approvals as wallet-control evidence where sufficient. Do not introduce an additional sign-in protocol unless it serves a concrete need. If adding wallet login, bind its challenge to origin, chain, nonce, expiry and intended role, and consume it once.
3. In wallet-only mode, require two distinct participant addresses and valid approvals from the actual requester and builder before funding, sponsorship or operator actions. Record real participation separately from cryptographic wallet control; two addresses alone do not prove two people.
4. Remove the Minecraft login prerequisite only for that explicit mode. Do not fabricate player UUIDs, write fake `identity_links`, disable `online-mode`, or mark game access verified.
5. Update the controller, runtime/workflow registration, operator eligibility, schemas, CLI callers, UI copy and tests together. The current operator eligibility also checks historical game links; changing only the Start button will not work.
6. Keep `humanGameplayVerified` false for the wallet-only route. Label all contract materials, building and inspections synthetic. The Minecraft demo remains a separate proof.
7. Preserve sender derivation, operation binding, agreement immutability, native/material caps, canonical receipt checks and protection through pending acceptance.

Important files:

- `backend/src/workflow/human-session.mjs`: input validation, pinned session, status and next-action selection.
- `backend/src/workflow/human-demo.mjs` and `human-demo.sql`: registration, original game-link checks, stable operations and workflow transitions.
- `backend/src/workflow/human-demo-operator.mjs`: readiness checks, bounded sponsorship, publisher, warehouse and attestor roles.
- `backend/src/workflow/human-demo-runtime.mjs`: public RPC and PostgreSQL wiring without automatic key loading.
- `backend/src/identity/handoff.mjs`, `http-runtime.mjs`, `minecraft-sessions.mjs`: existing approvals and game-specific authority; reuse selectively.
- `backend/src/web/human.html`, `human.mjs`, `human.css`: participant steps, transaction review, consent and recovery.
- `backend/src/server.mjs`: local operator guard, strict routes, body limits and assets.
- `scripts/human_demo.mjs`: identities/register/status/funding-plan CLI callers.
- `tests/workflow/human-session.mjs`, `human-demo.mjs`, `human-web.mjs`, `human-http.mjs`, `human-health.mjs` and `tests/identity/external-wallet.mjs`.

Focused exit criteria:

- Wallet-only sessions work with the Minecraft auth probe unavailable; game-linked sessions still refuse missing game proof.
- Both exact wallet approvals are required. Wrong sender, wrong role and changed funded terms are refused.
- Status declares the mode and omits private capabilities and unsigned transaction requests.
- Rejection, lost wallet reply and refresh do not create a second purchase or payment.
- No server code receives human private keys or automatically accepts for the requester.

### Then run the actual human demonstration

Use two actual people, with each person controlling their own wallet. They may share this computer sequentially.

| Role | Supplied public wallet |
| --- | --- |
| Requester | `0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f` |
| Builder | `0x76D7D56fb21A6969E1F07B722e3c63E2c80a7cB1` |

Do not assume any previous agreement approvals exist. Earlier “approval recorded” reports were not corroborated by persisted approvals, and old unsigned requests expired. At the code checkpoint, no new human session was started and zero genuine game-wallet links were verified.

1. Open `http://127.0.0.1:8789/human` in **Brave with the wallet extension enabled**, after implementing the new mode.
2. Prepare one new exact agreement when both people are ready. Each person reviews and signs their own approval. Register the same hash; never create a new job merely to retry an uncertain action.
3. Check actual balances. Requester needs test CRED and faucet ETH on Unichain Sepolia; builder needs faucet ETH for their claim. The explicit provisioning action persists a one-time requester deficit up to 9 test CRED and a builder deficit up to 0.0002 test ETH. It does not repeatedly top up spent balances.
4. Requester explicitly approves exactly 6 test CRED for escrow, then funds the agreed labor. Verify matching canonical events and two confirmations.
5. Requester approves the 3 test CRED procurement cap. If needed, explicitly refresh the separate synthetic market status using the publisher action.
6. Prepare one bounded purchase while the correct wallet/network are ready. The quote lasts at most 60 seconds. Requester confirms the exact transaction. Verify the canonical purchase and its bound claim.
7. Explicitly run synthetic delivery, local Ollama construction and protected synthetic inspection. Verify one delivery, exact synthetic material consumption and the bound report. This is not the Minecraft lamp report.
8. Requester reviews and explicitly accepts the protected report. Retain the lock during an uncertain acceptance; only canonical acceptance permits the claim stage.
9. Builder selects their own wallet and explicitly claims the fixed payment. Confirm the canonical receipt and amount.
10. Reconcile that same human job again and prove zero extra procurement, delivery or payment. `node scripts/human_demo.mjs --status AGREEMENT_HASH` reconciles the selected human job; update it for the new mode as needed. The generic developer resume helper targets a different retained flow and is not proof that this human job replayed safely.
11. Save immutable, redacted evidence with the exact code release, deployment, agreement hash, transaction hashes, observed outcomes and disclosed fixtures.

If independent human Arkiv discovery is part of the final acceptance criteria, implement/verify attributable human profiles, job and offer publication as well. Existing public Arkiv records used developer-controlled roles. Human-owned publication may need participant faucet gas on **Arkiv Tiramisu**, separately from Unichain gas. Never expose raw game UUIDs, email addresses or private approval URLs in discovery records.

## Code map and trust boundaries

| Area | Location | Responsibility |
| --- | --- | --- |
| Minecraft authority | `plugin/src/main/java/` | Permissions, stock, revisions, native levers, lamp checker, locks and durable world receipts |
| Physical worker | `backend/src/bot/construction-worker.cjs`, `minecraft-adapter.cjs`, `checkpoint-store.cjs` | Native Survival execution, bounded navigation, stock retrieval and observation-based recovery |
| Inference | `backend/src/inference/` | Router-shaped transport, strict proposals, Ollama decisions and budgets |
| Storage and coordination | `backend/src/storage/`, `backend/src/workflow/` | PostgreSQL transactions, leases, outbox/inbox, durable jobs and synthetic demo orchestration |
| Agreements and discovery | `backend/src/identity/`, `agreements/`, `discovery/` | Challenges, exact signed terms, approval handoffs and Arkiv records |
| Chain adapters | `backend/src/chain/` | Developer signed-byte journal, public-testnet validation and human unsigned intents |
| Procurement and delivery | `backend/src/procurement/`, `delivery/` | Aggregate cap reservation, canonical claims and one-time synthetic receiving |
| Inspection and settlement | `backend/src/inspection/`, `contracts/src/JobEscrow.sol` | Protected report binding, requester acceptance, fixed claims and timeout refunds |
| Web console | `backend/src/server.mjs`, `backend/src/web/` | Trusted local controls and private wallet pages |
| Operations | `scripts/local_host.py`, `maintained_world.py`, `ops/` | Owned-service health, snapshots, isolated restores and coordinated restart |

The backend is primarily Node ESM `.mjs`; the physical worker uses `.cjs`, the plugin is Java, contracts are Solidity and operations use Python. Older architecture prose calling the backend “TypeScript” is not an exact description of all current source.

Sources of truth: Minecraft/plugin for actual game state; PostgreSQL for workflow intent; canonical contracts for balances and settlement; Arkiv for attributable discovery; the model only proposes. Neither a dashboard nor a bot completion receipt proves functional inspection or acceptance.

### Human transaction lifecycle

`external-wallet.mjs` supports `approve_escrow`, `fund`, `approve_procurement`, `buy`, `accept`, `claim` and `refund`.

1. Prepare and persist an immutable request, sender, nonce, fee bounds, deadline and budget reservation.
2. Explicit `beginBroadcast` marks the operation unknown before releasing its transaction request once.
3. The browser requests the human wallet's transaction confirmation.
4. Record the returned original hash, then verify sender, target, calldata, value, nonce, fee bounds, canonical block, required events and two confirmations.
5. A known wallet rejection can reopen only the same still-valid intent when latest and pending nonce remain bound. Any uncertain result keeps its original reservation and requires reconciliation.

Statuses include prepared, unknown, submitted, confirming, confirmed, reverted, reorganized and reconciliation-required. Do not “fix” a stuck job by deleting its intent, assigning another nonce or preparing another purchase. Expired prepared quotes and some reverted operations intentionally require operator review; a general renewal/reset workflow has not been qualified.

## Environment and dependencies

Current host checkout:

`/Users/rudrabhaskar/Documents/Codex/agentcity-minecraft`

| Dependency | Tested or pinned value |
| --- | --- |
| Node | Host `26.3.1`; backend declares `>=26.3.1` |
| Python | Host `3.15.2`; no independently qualified cross-version minimum is promised |
| Foundry | `1.7.1`, Solidity `0.8.26`, Cancun EVM |
| PostgreSQL | 17, pinned Docker image in `scripts/local_database.py` |
| Arkiv local node | Official `arkiv-reth-dev` v0.5.1 image pinned by digest in `scripts/local_arkiv.py` |
| Ollama | Existing local installation, model `qwen3:1.7b` |
| Paper | 26.3 build 231 |
| Java runtime | Temurin 25.0.5+8, exact container digest in `config/minecraft-runtime.json` |
| Protocol bridge | ViaVersion 5.12.2 and ViaBackwards 5.12.2 |
| Client/bot protocol | Minecraft 1.21.11 |
| Mineflayer / pathfinder | 4.39.0 / 2.4.5 |
| Backend libraries | Arkiv SDK 0.8.1, pg 8.23.1, viem 2.57.13 |
| Contract libraries | OpenZeppelin 5.4.0, v4-core 1.0.2, v4-periphery 1.0.3 |

Use committed npm lockfiles and pinned runtime hashes. Do not upgrade to latest versions during handoff. The maintained bot has a necessary `tick_end` emitter on its real physics tick; removing it causes translated movement failures. Paper 26.3 also required the narrow native block accessor compatibility change. See `docs/MAINTAINED_RUNTIME.md` before touching either.

### Existing host operations

Run from the repository root:

```sh
python3 scripts/local_host.py status
python3 scripts/maintained_world.py status
python3 scripts/online_auth_probe.py status
```

To start missing owned services, after checking the host's current work:

```sh
python3 scripts/local_host.py start
```

Do not start a second backend manually while the managed one holds its port. `start` is an existing-host helper, not a fully verified clean-machine installer.

| Service | Local endpoint | Notes |
| --- | --- | --- |
| Pilot console | `http://127.0.0.1:8789/` | Trusted operator controls |
| Human flow | `http://127.0.0.1:8789/human` | Currently game-link gated; wallet-only changes needed |
| Private signing page | `http://127.0.0.1:8789/wallet` | Requires a private, expiring request capability; base URL alone is insufficient |
| PostgreSQL | `127.0.0.1:55432` | Private generated credentials |
| Local Anvil | `127.0.0.1:8547`, chain 31337 | Public fixture accounts; never use their keys on public networks |
| Local Arkiv | `127.0.0.1:8557`, chain 1337 | Official local node |
| Ollama | `http://127.0.0.1:11434` | Local inference |
| Maintained Minecraft | Game 25596, control 25597 | Primary maintained non-token saved world |
| Historical access world | Game 25588 | Preserved older user/demo world; leave unchanged |
| Original Java auth probe | Game 25598, control 25599 | Online authentication stays enabled; no valid human join recorded |

All endpoints bind to `127.0.0.1`. On a teammate's computer, `127.0.0.1` means that teammate's computer, not Rudra's laptop. Do not solve remote access by forwarding the privileged console or binding it to `0.0.0.0`.

### Fresh checkout preparation

The repository owner must invite the teammate through GitHub repository Settings → Collaborators and the teammate must accept. Do not make the repository public to bypass access setup.

```sh
git clone https://github.com/RudraBhaskar9439/agentcity-minecraft.git
cd agentcity-minecraft
git show f207aee15c0ca0b26a460e9f4cc1b1a89b696263 --stat
npm ci --prefix backend --ignore-scripts --no-audit --no-fund
npm ci --prefix contracts --ignore-scripts --no-audit --no-fund
npm ci --prefix tests/compatibility --ignore-scripts --no-audit --no-fund
```

Install the tested Node, Docker, Foundry, Python and Ollama prerequisites. Pull the model if it is absent: `ollama pull qwen3:1.7b`. Pull exact images from the scripts/manifests rather than unpinned tags; the local Arkiv helper deliberately refuses to download an uncached image automatically.

Follow `docs/MAINTAINED_RUNTIME.md` and the compatibility runbooks to rebuild/download game artifacts. The plugin build helper is `tests/inspection/build.py`; its compile classpath depends on prepared server artifacts under `.local/compatibility/server/`. The adopted application JAR is under `.local/inspection/AgentCity.jar`. Do not assume the JAR exists after cloning.

Local bootstrap helpers are `scripts/local_database.py`, `local_arkiv.py` and `local_anvil.py`. They create/reuse owned resources and reject foreign occupied ports or incompatible saved identities. Recreating local fixtures may generate different manifests and evidence; do not overwrite existing host pointers or public deployment identity to make a fresh machine look identical.

Public-testnet continuation additionally needs the private state/role configuration described below. A fresh-machine bootstrap and complete migration have **not** been run during this handoff.

## Public deployments

| Purpose | Network | Chain ID | RPC |
| --- | --- | ---: | --- |
| Settlement | Unichain Sepolia | 1301 | `https://sepolia.unichain.org` |
| Discovery | Arkiv Tiramisu | 7738577 | `https://rpc.tiramisu.db-chain.testnet.arkiv.network` |

The authoritative public deployment manifest is `contracts/public-testnet-deployment.json`. Verify chain, genesis, deployed bytecode and role identities before using it. A manifest in Git does not transfer control of its role wallets.

| Contract | Address on Unichain Sepolia |
| --- | --- |
| CRED | `0xb7f284315c88fed7e8bf3a0a1208fe8afc35abcd` |
| KIT | `0xda2ec869cc3d95e75ef6b48edb34e965e0980dd5` |
| State registry | `0xf035f2570dc6cb85fbcc1449e1455e128043d5f5` |
| Hook | `0xAaf77897b884B593A9c2a085A411C6495119C080` |
| Procurement | `0xfd48750b087e441b9fabb3f19e828a4aa6d005c2` |
| Labor escrow | `0x29a1b8f2408ba8fc7bef17d1d75f10a133328d01` |
| Official PoolManager | `0x9cB26A7183B2F4515945Dc52CB4195B0d2D06C95` |

Official PositionManager and Permit2 addresses/code identities are in the manifest. The demo uses actual official v4 infrastructure; it is not a replacement AMM.

Operator roles are separate: administrator, issuer, publisher, warehouse, inspection attestor, developer requester and developer builder. Personal human requester/builder wallets stay external to these keystores.

Registry validity is capped at 300 seconds; a new human purchase requires a freshness margin and its own quote of at most 60 seconds. The explicit publisher action journals through `ac_outbox` and retains unknown operations. Never call status polling a heartbeat that publishes automatically.

Useful commands, with different effects:

```sh
# Inspect the public deployment with the existing verification helper.
node scripts/public_testnet_verify.mjs

# Creates a NEW developer-wallet public job and sends faucet-funded transactions.
node scripts/local_demo.mjs --public-testnet

# Reconciles/resumes the retained DEVELOPER job; it may send unfinished operations.
node scripts/resume_local_settlement.mjs --public-testnet
```

Do not invoke the new-job command merely to check health. No new deployment, liquidity seed or role creation is needed just to implement wallet-only participation. If contracts change, adopt new deployment identities and new evidence explicitly; never relabel old deployed bytecode as the changed source.

## Private state and credentials

This handoff contains **no API keys, wallet private keys, passwords, seed phrases or reusable approval links**. The Git repository intentionally does not contain all operating state.

| Location on current host | What it contains or references | Handoff treatment |
| --- | --- | --- |
| `.local/backend/environment.json` | Database URL and generated credentials | Owner-controlled private transfer or regenerate for a new local DB |
| `.local/backend/` and owned Docker mounts | PostgreSQL, local node settings and data | Use logical/coordinated backups; do not copy a live DB data directory |
| `.local/public-testnet/deployment.json` | Active public manifest copy | Match it to committed deployment and actual chain |
| `.local/public-testnet/accounts.json` | Separated role settings/keystore references | Private; access only the roles needed |
| `.local/public-testnet/account-settings.json` | Initial development-wallet keystore/password-file references | Resolve the existing encrypted wallet through this file |
| Current chat workspace `work/private/agentcity-development-wallet/` | Initial encrypted developer keystore and private unlock material | Outside the repo; owner must arrange a secure transfer or choose new authorized roles |
| `.local/human-approvals/` | Participant config, retained requests and private capability links | Do not copy live links into Git, this handoff or public reports |
| `.local/human-session/active.json` | New flow's immutable active session pin when created | Never delete/replace a funded or uncertain session |
| `.local/online-auth/` | Original auth probe metadata and protected API token file | Preserve separately; not a wallet-only prerequisite |
| `.local/maintained-world/` | Saved owned world clone, pointers and protected control token | Snapshot consistently with plugin journals; preserve original source worlds |
| `.local/ops/` | Process ownership, private logs and backups | Logs may be sensitive; verify owners before stopping anything |

The initial developer wallet directory is under the original generated Codex workspace, not necessarily under the repository. Existing settings are the lookup authority; do not hardcode Rudra's home path into new runtime code.

No 0G key is required for Ollama. Arkiv SDK publication uses chain signing and gas; an unrelated API credential is not a substitute. Previously pasted third-party API credentials should be rotated before a shared/production deployment and entered privately, not copied out of chat into source. No additional secrets were requested or collected for this handoff.

If the teammate cannot access private operator state, they can still implement and fixture-test the wallet-only code. Live operations on existing contracts require the existing authorized operator or a separately adopted deployment with controlled roles.

## Verification already completed

### Real environment observations

- Actual Minecraft: 144 Survival placements and receipts, exact stock consumption, one original lost-reply replay and real 16/16 lamp inspection on the maintained candidate. Managed-world reinspection also passed 16/16.
- Actual developer public flow: Arkiv discovery, Unichain funding, real hooked-pool purchase, canonical claim, synthetic delivery, Ollama decision, protected synthetic inspection, requester acceptance and builder payment.
- Actual developer public replay: zero new purchases, zero new transactions and zero extra payment on the retained completed job.
- Actual isolated database restore at the latest human-workflow checkpoint: **381 tables and 801 rows**, with table fingerprints matching the snapshot. Live DB was not replaced.
- Actual earlier coordinated DB/backend restart: 229 tables and 569 rows preserved. Snapshot sizes differ because they are different runs; do not combine them as one test.
- Actual cold saved-world restore: restored blocks, stock and revision observed; a new actual 16/16 inspection passed.
- Actual local Anvil restore: current account state and known receipt/block identity survived; historical account state did not fully survive. Reconciliation remains mandatory.

### Focused tests at the implementation checkpoint

| Command | Recorded result | Scope |
| --- | --- | --- |
| `node tests/identity/external-wallet.mjs` | PASS, 12 groups | Mocked chain, real isolated PostgreSQL, ephemeral fixture signatures |
| `node tests/workflow/human-demo.mjs` | PASS, 7 groups | Real PostgreSQL and Ollama; scripted identities, chain and operator outcomes |
| `node tests/workflow/human-health.mjs` | PASS, 3 groups | PostgreSQL and mocked publication/freshness outcomes |
| `node tests/workflow/human-session.mjs` | PASS, 3 groups | Strict fields and pinned operation authority |
| `node tests/workflow/human-web.mjs` | PASS, 7 groups | Scripted DOM/provider/HTTP; no live MetaMask transaction |
| `node tests/workflow/human-http.mjs` | PASS, 4 groups | Actual local HTTP guards, assets and redacted status |
| `node tests/identity/wallet-expiry.mjs` | PASS | Expired approval refused before a signing call |
| `python3 -m unittest discover -s tests -v` | PASS, 56 tests | Planning/infrastructure tests, not phase completion |
| `python3 scripts/check_plan.py` | PASS | 11 phases, 270 scenario families, 18 upstreams; planning only |

These are recorded results from the code checkpoint. During handoff preparation only Git state, versions and read-only service/auth health were inspected; no full product suite or public transaction was rerun.

After the wallet-only change, rerun the affected identity/workflow/operator/browser/HTTP checks. Run the 56 Python tests and planning integrity if planning infrastructure changes. Existing contract tests run with `forge test -vv` from `contracts/`; renew those checks when contracts change. Do not run Anvil snapshot tests concurrently with unrelated transactions on that node.

The HTTP fixture assumes the owned console is running on 8789. Other component suites need their documented PostgreSQL, Ollama or node prerequisites; they are not all pure unit tests.

### Evidence entry points

- `evidence/REVISED_PHASE8_CHECKPOINT.json`: revised developer pilot phase status and actual integration/recovery references.
- `evidence/HUMAN_WORKFLOW_CHECKPOINT.json`: latest code-level human-flow implementation, source hashes, tested scope and blocked human checks.
- `evidence/HUMAN_MARKET_READINESS.json`: read-only market, role-balance and operating-cap snapshot; not a promise of current freshness or funds.
- `evidence/MAINTAINED_RUNTIME.json`: adopted game runtime and managed-host qualification.
- `evidence/RECOVERY_CHECKPOINT.json`: earlier component recovery summary.
- `evidence/runs/human-workflow/95ce2323-6c17-4ae5-bfca-49fc176b1213/report.json`: last human workflow regression at this baseline.
- `evidence/runs/human-web/e81c5cb2-8299-4542-b432-514b5cfeb088/report.json`: last browser-provider fixture at this baseline.
- `evidence/runs/human-http/7c0ce2cd-d275-4868-9449-85494a0a096f/report.json`: final live local HTTP preflight at this baseline.
- `evidence/runs/human-recovery/3ddc50e093cf4009b01c82d78e4a2384/report.json`: 381-table/801-row isolated restore.
- `evidence/P0.json` through `P10.json`, `planning/phases.json`, `planning/verification.json`, `planning/scope.json`: canonical gate machinery and retained requirements. Current source changes can make earlier approvals stale.

Run a gate to inspect its actual result, for example `python3 scripts/check_phase.py P8`. A blocked/stale gate is a reported condition to resolve, not permission to invent passing evidence or remove cases.

## Remaining release work in order

| Priority | Work | Completion evidence |
| --- | --- | --- |
| 1 | Implement explicit wallet-only mode and update all callers/eligibility checks | Focused affected suites pass; missing game access no longer blocks this explicit mode; original game evidence remains pending |
| 2 | Complete the actual two-person contract demonstration | Exact approvals, funding, purchase, synthetic inspection, manual acceptance, fixed builder claim and no-extra-effect replay on the same job |
| 3 | Complete the agreed human discovery and timeout/recovery experience | Attributable Arkiv records if required; retained terms survive expiry; explicit refund/incident paths work without changing funded rights |
| 4 | Qualify laptop operations and recovery | Off-laptop encrypted component copy restored in isolation; full reboot and controlled service restart; unknown effects reconciled before writers resume |
| 5 | Prepare any shared/public release | Real user auth, role authorization and participant/operator separation; secure transport and deployment; measured capacity, logs and actionable health; secret handling appropriate to that exposure |
| 6 | Reconcile revised acceptance and original gates | Exact fixed release/deployment and reviewed evidence; explicit record of waived/deferred original requirements rather than false passes |
| 7 | Package the demonstration and submission | Clear two-track demo, participant instructions, repository access, supported versions, limitations and accurate code/history dates |
| 8 | Run research, if it is still part of delivery | P10 E1–E8 actual trials, payer-separated costs, measured results and honest null/negative findings |

If the owner later obtains Java access, the preserved online probe and game-linked mode can be completed separately. A free human-playable platform such as Luanti is an alternative project direction requiring another game adapter; it is not implemented and should not be added alongside the current plan without a scope decision.

If 0G arrives later, retain Ollama as the local option, configure the existing Router-shaped provider boundary, and verify model capability, credits, limits and actual billing/trust evidence. Router and Direct credentials/balances are different. Do not claim 0G verification by changing a provider label.

## Recovery runbook

For a new logical database backup and isolated restore check:

```sh
python3 scripts/local_host.py backup
python3 scripts/local_host.py restore-check /absolute/path/printed/by/backup
```

The second argument is a placeholder: use the actual backup directory printed by the first command. Restore-check creates a new isolated database, verifies archive/hash/table fingerprints and does not replace the live DB or run restored workers.

Coordinated DB/backend restart, only in a verified idle window:

```sh
python3 ops/restart_recovery.py
```

Additional component checks are `ops/chain_recovery.py` and `ops/world_recovery.py COMPLETED_INTERNAL_RUN_ID`; their prerequisites and ownership checks are documented in `docs/HOST_OPERATIONS.md`. Do not supply a guessed world run ID or stop an active game server to obtain a snapshot.

A disaster copy needs the DB archive, consistent saved world/plugin journals, local-chain state and receipts, deployment identities, workflow pointers and separately protected operator configuration/keys. Keep each component's release and capture time. The revised route has no economic bridge, so separate consistent snapshots can be reconciled independently; no cross-world atomic rollback should be claimed.

Restore into isolated services with writers stopped. Public testnets cannot be rolled back by restoring a local DB. Check canonical transactions, game observations, nonces and receipts before enabling workers. Never replenish stock, repurchase materials or repay a builder merely because the restored DB missed an acknowledgement.

## Known limits and practical troubleshooting

- **Human Start disabled:** expected in the current code because genuine game links are absent. Implement the new mode; do not bypass the original auth check with fixture identities.
- **Failed to verify username:** previous TLauncher sessions were offline/invalid. A later Microsoft sign-in reported no Minecraft entitlement, and the owner confirmed no owning account. Further login retries are not the next task.
- **Old approval button inactive:** requests expire. Use one deliberate fresh new-session review when people are ready. Partially approved, funded or uncertain terms must not be silently replaced.
- **Market unhealthy/unavailable:** report freshness and KIT backing must be checked on the actual chain. The explicit publish action can refresh a synthetic report; reading status does not publish.
- **Purchase quote expired:** maximum 60 seconds. Do not silently obtain a new quote after an intent exists. Preserve the old intent and use explicit operator recovery.
- **Wallet switched during preparation:** consent is cleared. Revalidate the expected sender/network before sending; a released uncertain intent must not be converted into a different transaction.
- **Unknown submission:** recover the original hash from wallet activity or retained signed bytes and reconcile. No automatic second nonce or semantic purchase.
- **Web controls after restart:** reload the page for the new local request token. Never copy a stale CSRF token into configuration.
- **Port occupied or ownership mismatch:** inspect the identified service. Do not kill arbitrary processes, remove foreign Docker containers or delete `.local` to force startup.
- **Hosted runtime marked adopted:** the runtime config's adoption flag refers to the tested software candidate, not to production readiness, human entitlement or public exposure.
- **Single-host concurrency:** checkpoint exclusion is not a distributed lease proof. Do not advertise multi-worker scaling without the retained fencing work.
- **Refund and requester refusal:** unaccepted timeout refunds exist; acceptance and refund are mutually exclusive. The design has no automatic arbitration and can leave an honest builder unpaid when the requester refuses acceptance.
- **Security and capacity:** focused checks are not an independent contract/security audit or a load qualification. Fee accounting and operational limits need exposure-appropriate review before real-value use.

## Upstream reuse

The project already reuses the relevant upstreams; do not clone extra famous repositories simply for a dependency list.

| Upstream | Use |
| --- | --- |
| https://github.com/PaperMC/Paper | Minecraft server/plugin API |
| https://github.com/PrismarineJS/mineflayer | Physical bot execution |
| https://github.com/PrismarineJS/mineflayer-pathfinder | Bounded navigation |
| https://github.com/ViaVersion/ViaVersion and https://github.com/ViaVersion/ViaBackwards | Tested protocol translation |
| https://github.com/Redstone-Compiler/redstone-compiler | Licensed calculator candidate data |
| https://github.com/Arkiv-Network/arkiv-sdk-js | Discovery |
| https://github.com/Uniswap/v4-core and https://github.com/Uniswap/v4-periphery | Actual market infrastructure and interfaces |
| https://github.com/OpenZeppelin/openzeppelin-contracts | Token/access/signature primitives |
| https://github.com/wevm/viem | EVM and typed-signature integration |
| https://github.com/foundry-rs/foundry | Build, tests and local EVM |
| https://github.com/0gfoundation/0g-compute-ts-sdk | Future provider reference; live 0G not verified |

The 0G starter and Uniswap templates/router are references where documented, not proof that every repository is installed or deployed. License constraints and exact review metadata are in `docs/UPSTREAM_REUSE.md` and `planning/upstreams.json`; installed npm lockfiles and runtime manifests pin the actual selected dependencies. Keep upstream notices.

Headroom, RTK, Caveman and Ponytail are development tools/style guidance, not Minecraft runtime dependencies. No Voyager, MineDojo, LangChain or LangGraph runtime is required by the current fixed-calculator design.

## Documents and handoff ownership

Read current sources in this order:

1. This handoff and the latest owner instructions, especially the newly confirmed lack of Java entitlement.
2. `AGENTS.md`, `docs/DEPLOYMENT_ROUTE.md`, `docs/HUMAN_DEMO.md`, `evidence/HUMAN_WORKFLOW_CHECKPOINT.json` and `evidence/REVISED_PHASE8_CHECKPOINT.json`.
3. `docs/MAINTAINED_RUNTIME.md`, `docs/PUBLIC_TESTNET.md` and `docs/HOST_OPERATIONS.md` for their exact environments and commands.
4. `docs/IMPLEMENTATION_PLAN.md`, `docs/TESTING.md`, `docs/DECISIONS.md` and the owning phase cases.
5. Original references: `docs/references/agentcity-research-design-v3.md` and `docs/references/agentcity-system-specification-v2.pdf`.

Some earlier prose is historical: README text referring to “Prepare approval pages” predates the new `/human` flow; older host prose lists 25588, while the maintained host is 25596; `LOCAL_P3_P8_IMPLEMENTATION.md` describes an earlier checkpoint whose public work was completed later. Original architecture/P9/P10 sections describe the integrated target. Use their retained requirements for traceability, not as evidence that the current split-route pilot implements a Minecraft economy.

Repository owner responsibilities: invite the teammate, control any private-state/role-key transfer, arrange the actual second participant, retain human control of wallet prompts, and choose an off-laptop backup destination. No real-money purchase is needed for the proposed wallet-only route.

Teammate responsibilities: implement the explicit mode, preserve authority/accounting/recovery invariants, complete real human evidence, finish the agreed operational release work, and report actual results at each checkpoint. Include commit, exact environment, tests, evidence, limitations and next action. Keep failed attempts and old records; never edit history to turn a fixture into a human pass.

No wallet-only implementation, human signatures, public transactions, service restart or deployment was performed while preparing this handoff. The current private developer pilot remains the last verified implementation baseline.
