# Phase 2 local construction checkpoint

Physical construction and the real 16-case calculator inspection are verified. Exact release approval is recorded in `evidence/P2.json` and checked by `python3 scripts/check_phase.py P2`.

The worker retrieves controlled stock, performs native Survival placement and persists operation intent and receipts. On restart it reconciles actual blocks, carried items and original receipts before continuing. Only the protected Paper checker creates local review readiness.

## Code boundaries

| File | Responsibility |
| --- | --- |
| `backend/src/bot/construction-worker.cjs` | Pinned blueprint work, material reconciliation, progress and receipt-based resumption |
| `backend/src/bot/minecraft-adapter.cjs` | Authenticated commands, actual inventory, bounded navigation and native placement |
| `backend/src/bot/checkpoint-store.cjs` | Atomic durable checkpoints and cooperative worker exclusion on one host |
| `plugin/src/main/java/org/agentcity/paper/ConstructionAccessPlan.java` | Hash, coordinate and exact-state validation for operator access structures |

The plugin permits a repeater or wire placement reference only with an exact valid arm, a sneaking Survival actor and the correct held material. Final native placement still checks the approved target, state, revision, lock and material effect. Existing solid references retain priority.

## Actual construction evidence

The world began with zero final circuit placements and exactly 144 circuit items: 65 stone bricks, four levers, 16 repeaters, 37 redstone torches, 19 redstone dust and three lamps.

1. `agentcity-construction-5b3f8a44` placed 12 blocks, exited its client process and reconnected with 132 carried items. It reached 137 actual placements, then waited on seven remaining placements whose required references were excluded. Its wrapper remains **failed**.
2. After a reviewed source correction, `agentcity-continuation-88033ad1` verified the same world, job, deployment, original deadline, blocks, receipts and inventories. It consumed the seven remaining items in seven unique native placements. The stock chest and builder inventory became empty; all 144 positions and orientations matched. Its wrapper remains **failed** because an immediate inspection request hit HTTP 429.
3. `agentcity-continuation-53847de4` restarted that completed world, verified all 144 structural states, input settings, empty inventories and revision 144, and placed zero new blocks. The protected checker then passed all 16 real input/output rows. Report: `retained/reports/1d764720-4f55-4a69-bb64-acb8c3c6b3c2.json`.

These runs are under `evidence/runs/p2-construction/`. No continuation restores blocks, injects items, resets the checkpoint or extends the original deadline. Failed diagnostic segments and their exact source snapshots remain retained. This is a composed 137 + 7 build across a source upgrade; a clean 144-placement run of the final code was not performed.

## Focused verification

- Nine scripted worker checks and nine adapter checks pass. They are separate from physical evidence.
- Current plugin permission, native material and replay regressions pass 41 initial groups plus one same-world restart group in `evidence/runs/p1-boundary/agentcity-boundary-bad12f21/`.
- Unchanged access, core, parser and control-mapping components retain nine access checks, 376 core assertions, 15 parser checks and 51 mapping checks. These are component evidence, not new tests of every final plugin branch.
- Live access traversal passes in `agentcity-construction-40ed141a`: both lanes, both end bridges, ascent and descent, with fresh server positions and unchanged stock/structure.
- Shortage and occupied-target waits pass in `agentcity-construction-1b755aff` and `agentcity-construction-ef6dfdc3`. The declared blocked crossing passes in `agentcity-construction-4d581bae` with 144 stock items preserved, zero placements and revision zero.
- Actual guards cover actor session, role, revision, expiry and inspection lock. An unsneaked thin-reference click is refused and its original operation reconciles before valid construction resumes.

The six current P2 cases retain the original broader requirements under Phase 9. Planning checks are separate: 56 Python tests and integrity checks for 11 phases, 270 scenario families and 18 upstreams do not establish product behavior.

`evidence/runs/p2-mvp/defects.json` records development failures and their actual verification. Older results are not relabelled as passing runs.

## Infrastructure and limits

The base floor, stock chest, 198 glass blocks and nine bottom slabs are disclosed operator infrastructure, bound to an exact manifest hash. They remain outside bot mutation authority and the circuit material bill. Navigation uses calibrated lanes and landings, grounded arrival and an 18-second deadline per leg.

Only the pinned identity orientation and one cooperative worker host are supported. The local exclusion mechanism does not establish distributed task leasing. The historical Paper release is unsupported for production; another server/version needs its own verification.

This is an isolated, non-token fixture with agent-controlled identities and operator stock. It establishes no independent human participation, live 0G inference, token backing, purchases or settlement. No paid API or token expenditure was used.
