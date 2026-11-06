# Local implementation through Phase 8

This historical local-track report is retained. The revised separate contract flow now also has [actual public-testnet deployment and recovery](PUBLIC_TESTNET.md); that does not pass the original integrated Minecraft/0G gates.

Current route: [Minecraft internal mechanics and a separate contract demonstration](DEPLOYMENT_ROUTE.md). New runs use actual local Ollama inference; the retained original local-component evidence used scripted responses. Neither establishes the original 0G live gate. Canonical P3–P8 history is unchanged.

The user approved this local track on 30 October 2026, keeping live checks pending and real spending at $0. It implements the working components through Phase 8 without substituting fixtures for the canonical integration gates.

Open the running local console at **http://127.0.0.1:8789**. It displays the most recent retained flow and clearly identifies its synthetic parts. The console binds only to loopback and requires a local request token for running the fixture.

## What is implemented

| Phase | Working local implementation | Verification |
| --- | --- | --- |
| P3 | Strict proposal schema, duplicate-key refusal, provider boundary, durable inference/action budgets, fresh actor/revision/lease checks and separate proposal/operation IDs | Scripted HTTP transport, six PostgreSQL workflow checks and a proposal that schedules the synthetic build |
| P4 | Domain-bound one-use wallet challenges, canonical EIP-712 agreements, required approvals, funded-term freezing and signed discovery | Six identity checks, six agreement checks including actual contract hash agreement, and six official-SDK checks against a real local Arkiv node |
| P5 | Separate administrator/issuer roles, controlled CRED, whole-KIT issuance, unique deposit protection and per-material circulating/pending backing | Real local EVM issuance; pending obligations survive burn; focused Forge accounting/replay tests |
| P6 | Increasing/fresh state reports, CREATE2 hook permission bits and an actual v4 PoolManager pool | Real exact-output swaps; stale or unhealthy state halts both directions; ordinary LP removal remains available |
| P7 | Per-purchase and aggregate agreement caps, retained signed transaction bytes, atomic swap/burn/claim and durable delivery receipts | Five PostgreSQL/Anvil purchase checks, three requester/chain authorization checks and actual local-chain claims consumed by the synthetic inventory receiver |
| P8 | Exact signed labor allocations, typed inspection binding, protected pass lifetime, requester-only acceptance, pull claims and timeout refunds | Twelve combined Forge contract checks, real local funding/acceptance/payout, no-extra-purchase recovery and three focused pass-lock recovery checks |

The combined flow uses real local transactions and signatures. Inference responses, game sessions, construction, inventory and inspection are explicit fixtures. Actual Minecraft construction and its real 16-row checker remain separately verified by Phase 2; the token demonstration does not reuse those observations as proof for a different synthetic job.

## Code layout

- `backend/src/inference/` validates proposals and coordinates bounded decisions.
- `backend/src/storage/` and `backend/src/workflow/` own PostgreSQL transactions, budgets, outbox intents and fenced leases.
- `backend/src/identity/`, `agreements/` and `discovery/` own challenges, signed terms and attributable discovery.
- `backend/src/chain/` persists signed bytes and their hash before broadcasting. Retry resolves the same transaction; disappeared confirmed receipts require reconciliation.
- `backend/src/procurement/` reserves the job's remaining cap before sending, keeps uncertain reservations, and settles actual canonical spending.
- `backend/src/delivery/` verifies canonical claims and atomically updates the synthetic warehouse, destination and unique receipt. A lost acknowledgement cannot deliver another bundle.
- `backend/src/inspection/` owns the synthetic protected revision and acceptance recovery. Unknown acceptance stays locked; a confirmed revert can be reconciled without releasing a still-usable pass.
- `contracts/src/` contains six readable contracts using official OpenZeppelin and Uniswap v4 interfaces.

PostgreSQL is the single backend workflow store. Contract state remains the authority for token balances and settlement. Discovery and model responses do not grant custody, spending or acceptance authority.

## Run and inspect

Install the exact backend and contract packages first (`npm ci --ignore-scripts` in both folders), then run the owned local services and console:

```sh
python3 scripts/local_database.py
python3 scripts/local_arkiv.py
python3 scripts/local_anvil.py
node scripts/local_seed_liquidity.mjs
cd backend
npm ci --ignore-scripts
npm run demo
npm start
```

`npm run demo` creates an isolated PostgreSQL schema and a new local job. It performs the signed agreement/funding, bounded v4 purchase, claim delivery, scripted decision, synthetic construction/inspection, requester acceptance and fixed builder claim. Its report is retained under `evidence/runs/local-e2e/`; the local console reads the latest report.

`node scripts/resume_local_settlement.mjs` resumes the latest job's retained acceptance and payment state. It does not purchase materials again. Repeating a completed settlement returns the prior claim and pays zero additional tokens.

The official local Arkiv and Anvil setup and role addresses are recorded in their owned local environment files and `contracts/local-deployment.json`. Contract setup and exact units are documented in [contracts/README.md](../contracts/README.md). The initial thin test pool has limited executable depth. The explicit `local_seed_liquidity.mjs` helper adds and records a supplementary 1000e18 test LP position once; replay returns its original transaction. Existing token balances fund it and supplies stay unchanged. There is no automatic treasury subsidy in the purchase path.

Focused checks:

```sh
node tests/inference/local-smoke.mjs
node tests/workflow/local-checks.mjs
node tests/identity/local.mjs
node tests/agreements/local.mjs
node tests/discovery/local.mjs
node tests/procurement/local.mjs
node tests/procurement/authorization.mjs
node tests/settlement/local-locks.mjs
node tests/workflow/console-checks.mjs
cd contracts && forge test -vv
```

The procurement integration test owns a bounded Anvil snapshot window. Run it without other transactions on that node. It restores only that test window and drops its isolated SQL schema. Ordinary demo jobs are retained. Existing unrelated containers and services are not stopped.

## Defaults and remaining live work

The bill is the pinned 144-item calculator bundle. CRED and KIT use 18 decimals; issuance/redemption arguments use positive whole KIT counts. Labor and materials remain separate. The example funds six CRED of fixed builder labor and caps material spending at three CRED. The pool uses a static 0.3% fee and disclosed LP ranges. Its quotes are actual v4 execution results, not a promised price.

The updated economic document's symmetric halt is adopted for this local route: stale/unhealthy state halts both swap directions while ordinary LP withdrawal remains available. The older purchase-only live plan is retained; live deployment requires an explicit policy adoption and current deployment review.

These checks remain pending:

1. Actual 0G Router credentials, usable credits, selected-model capability and billing/provenance evidence. The current local tests make no paid provider calls.
2. Independently controlled requester/builder participants and genuine game sessions. Two agent-controlled wallets are fixtures.
3. Actual token-platform suitability before any Minecraft token economy. Local contracts use synthetic inventory and do not connect to Minecraft delivery.
4. Public-chain deployment, finality, role keys, liquidity funding and actual requester signatures/funding/acceptance. Unichain/Arkiv test faucets alone do not prove these integrations.
5. Broader release qualification, independent security review and the Phase 9 experience/recovery work.

Canonical `evidence/P3.json` through `P8.json` remain unpassed. Local component verification is recorded separately; it does not remove, migrate away or fabricate their live requirements. The prior game runtime remains a disclosed historical unsupported release.
