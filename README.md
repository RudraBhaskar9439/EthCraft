# AgentCity

The [South Mumbai sightseeing world](docs/MUMBAI_WORLD.md) adds a separate,
read-only geographic recreation with `/mumbai` and `/lobby` return. Existing
gameplay, player inventory and marketplace identities remain separate.

The [laptop marketplace](docs/TESTNET_MARKETPLACE.md) exchanges test USDC and
CITY through a guarded Uniswap v4 pool, purchases deposited equipment and funds
requester-approved native agent work. Its new hook enforces time-weighted price
checks, trade limits and minimum active liquidity. Lending and borrowing were
removed from the active product; earlier bank contracts and evidence are
historical. The testnet deployment uses mock tUSDC and controlled developer
wallets. These protections do not guarantee zero LVR or qualify a public release.

The [conversational-agent and managed-wallet update](docs/PLAYABLE_MARKET.md)
adds natural multi-step requests, verified Privy identity linking and a dedicated
Uniswap v4 CITY/GEM testnet market. Managed-player end-to-end verification and
production qualification are tracked separately from developer swap evidence.
See the [managed-market checkpoint](evidence/MANAGED_MARKET_CHECKPOINT.json)
for actual results, retained failures and production blockers.

The [personal agent tools](docs/AGENT_CAPABILITIES.md) extend the playable pilot
with natural-language structure plans, custom block layouts, bounded gathering,
recipe crafting and delivery using real materials. The separate NPC lobby and
Survival world remain the starting flow. Unrestricted exploration, combat, paid
jobs and the player web dashboard remain in development.
The [autonomy checkpoint](evidence/AUTONOMY_CHECKPOINT.json) records actual native
construction/material results, retained failed attempts and model limitations.

The original calculator route builds and verifies a fixed calculator with actual
internal game materials and a controlled bot. Its separate contract demonstration
uses synthetic inventory and does not affect Minecraft gameplay. The preserved
[deployment route](docs/DEPLOYMENT_ROUTE.md) describes that checkpoint; subsequent
user-authorized playable and testnet market work is described above and does not
establish platform approval or production qualification.

The repository contains the implementation plan, 270 verification scenario families, focused local phase gates, tested phase tooling, and actual Paper/Mineflayer construction. The [Phase 1 checkpoint](docs/P1_CHECKPOINT.md) and [Phase 2 construction checkpoint](docs/P2_CHECKPOINT.md) preserve earlier milestones. Historical local fixtures alone do not establish independent human participation, token-platform permission or public-chain readiness; current public-testnet evidence is recorded separately below.

## Local implementation through Phase 8

The user-approved local track includes inference controls, PostgreSQL identities and agreements, official-SDK local Arkiv discovery, actual local Uniswap v4 contracts, bounded procurement, synthetic delivery and one-time settlement. New demonstration runs use actual local Ollama inference. The separate contract flow is now verified on Unichain Sepolia and Arkiv Tiramisu, including same-job recovery without another purchase or payment. Final human acceptance and production release checks remain pending. See the [current phase-by-phase status and proof references](evidence/REVISED_PHASE8_CHECKPOINT.json); the original integrated-spec gates remain preserved separately.

- [Open the local console](http://127.0.0.1:8789)
- [Implementation, verification and setup](docs/LOCAL_P3_P8_IMPLEMENTATION.md)
- [Live testnet deployment and operator commands](docs/PUBLIC_TESTNET.md)
- [Host startup, backup and recovery](docs/HOST_OPERATIONS.md)
- [Inputs and final acceptance requirements](docs/INTEGRATION_REQUIREMENTS.md)

The console uses Ollama and developer-controlled test wallets. The blockchain demonstration uses synthetic inventory and inspection. Minecraft construction uses actual internal game materials; blockchain balances and payouts do not affect the game. Historical evidence that says scripted inference describes the earlier implementation.

Two people sharing this computer can open the console in Brave and select **Prepare approval pages** when ready. The separate Microsoft-authenticated Java probe on `127.0.0.1:25598` provides a real, player-initiated identity-link path; [human-verification preparation](evidence/HUMAN_VERIFICATION_PREPARATION.json) records its checks and the remaining human actions. Empty-server health and fixture signatures do not establish human participation.

## Start here

- [Teammate handoff and remaining implementation](docs/TEAMMATE_HANDOFF.md)
- [Complete phase implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Official upstream repositories and reuse](docs/UPSTREAM_REUSE.md)
- [Verification matrix](docs/VERIFICATION_MATRIX.md)
- [Testing and phase approval](docs/TESTING.md)
- [Decisions required before implementation](docs/DECISIONS.md)
- [Version 3 research protocol](docs/RESEARCH_PROTOCOL.md)

## Access and local inference preparation

- [What is needed through Phase8, including the updated economics document](docs/INTEGRATION_REQUIREMENTS.md)
- [Five-check local inference preparation without0G access](tests/inference/README.md)

## Build sequence

| Phase | Deliverable | Planned scenarios |
| --- | --- | ---: |
| P0 | Confirm scope policies and test foundations | 15 |
| P1 | Protected calculator local MVP | 10 |
| P2 | Make the bot construct and resume safely | 6 |
| P3 | Connect real AI decisions behind tool policy | 26 |
| P4 | Add verified identities agreements and discovery | 29 |
| P5 | Establish custody and backed token issuance | 25 |
| P6 | Deploy the state registry hook and final pool | 25 |
| P7 | Connect bounded purchase redemption and delivery | 24 |
| P8 | Enforce inspection acceptance and one time settlement | 26 |
| P9 | Complete experience, recovery and retained qualification | 72 |
| P10 | Evaluate mechanisms against controlled baselines | 12 |

## Initial scope

One server/version, one protected plot, one calculator blueprint, one material KIT definition, one requester, one paid builder and bot, one CRED/KIT pool and one settlement chain. The calculator adds A and B, each 0 to 3, with all 16 combinations checked against real lamp block states. A disclosed missing high carry output produces 10/16; repair restores 16/16.

## Repository checks

```sh
python3 -m unittest discover -s tests -v
python3 scripts/check_plan.py
python3 scripts/check_phase.py P0
```

The first two commands validate planning infrastructure. The last command reports the actual P0 local technical gate from its retained evidence and review. A green planning workflow is not a working product or a passing phase.

## Source and policy

- [Version 3 mechanism and research design](docs/references/agentcity-research-design-v3.md)
- [Version 2 detailed functional specification](docs/references/agentcity-system-specification-v2.pdf)

V3 adds comparative evaluation E1 to E8, explicit 0G trust/accounting distinctions, market-depth and LP-risk analysis, and honest negative/null findings. It does not expand the first build to an autonomous city or arbitrary commissions.

Token-linked Minecraft compatibility, honest server custody/inspection and requester-refusal risk remain explicit design constraints. The private repository does not establish public deployment permission. No CRED peg, guaranteed yield or sustainable economy is assumed.

## Local technical scope approval

The user approved local Phases 0 to 2 first. Actual independent participants remain required at P4-029, and the original token-platform and funded-chain requirements remain preserved at P5-024/P5-025. The revised route keeps blockchain separate from Minecraft and records its own public-testnet results. On 30 October 2026 the user revoked the pause-after-push rule: continue implementing and verifying through Phase 8 after checkpoint pushes.

## Phase1 local MVP scope

The user approved finishing the working local Phase1 without the expanded edge-case sweep. See [the exact scope](docs/P1_MVP_SCOPE.md). Real protected reports show16/10/16, actual item-consuming placement, permission guards, replay and bounded restart recovery. Phase2 survival construction is separate; no token or production readiness is claimed.

## Phase 2 construction

The worker has completed all 144 native Survival placements and passed the protected real 16-case calculator inspection. Verification used a preserved world: 137 placements, a reviewed source correction, then seven remaining placements and a separate inspection restart. The [construction checkpoint](docs/P2_CHECKPOINT.md) records the exact composition and limits; the [focused scope](docs/P2_MVP_SCOPE.md) retains broader release qualification.

- `backend/src/bot/construction-worker.cjs` plans work, reconciles observations and records progress.
- `backend/src/bot/minecraft-adapter.cjs` handles navigation, controlled stock retrieval and native Survival placement.
- `backend/src/bot/checkpoint-store.cjs` persists checkpoints and excludes concurrent cooperating workers on one host.

The local world contains fixed, hash-bound access infrastructure: 198 glass blocks and nine bottom stone slabs. The bot must retrieve and consume the entire 144-item circuit bill; operator access is disclosed infrastructure, not circuit stock. A completion receipt never substitutes for the real lamp checker.

```sh
node tests/bot/worker-self-check.cjs
node tests/bot/adapter-self-check.cjs
python3 tests/construction/run.py --scenario build
python3 tests/construction/run.py --scenario shortage
python3 tests/construction/run.py --scenario occupied
python3 tests/construction/run.py --scenario blocked
```

The Node commands use scripted domain and adapter fixtures. The Minecraft commands require the existing pinned local Docker/Paper runtime and retained dependencies; they create fresh worlds, retain observations and remove only their own containers. They spend no API credits or tokens. Full phase readiness is reported separately by `python3 scripts/check_phase.py P2`.

Exact-output Uniswap v4 swaps are implemented and verified locally. See [usage, bounds and rollout requirements](docs/UNISWAP_EXACT_OUTPUT.md); existing deployed routers require an explicit upgrade before this feature is enabled.
