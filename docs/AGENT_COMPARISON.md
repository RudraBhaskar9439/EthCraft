# 0G and Claude comparison

`scripts/compare_agents.mjs` runs three identical owner requests through the real personal-agent planner and native Minecraft tools: deliver six cobblestone, build a seven-block arch, and construct a constrained custom bench. The model must generate each plan; the runner never supplies executable geometry. An independent scorer checks observed blocks, inventory changes and receiving receipts. Planning time and actual API cost are reported separately.

The two owners, `Compare0G` and `CompareClaude`, are explicit operator-controlled fixtures. They do not establish independent human participation, live Discord authentication or Privy identity. The registered agents use `CityAgent2` and `CityAgent3`. Existing `CityAgent1`, bank actors, wallets, journals and Mumbai scenery are preserved.

Before a live run:

1. Obtain explicit model-spending authorization and initialize separate provider ledgers. Current comparison allowances are $5 for 0G and a new $0.25 for Claude, separate from the older Claude allowance.
2. Put complete per-slot provider settings in ignored `.local/comparison/providers.json`. Both settings must use `maxTokens: 1536`; credentials stay in ignored environment files. The 0G model is `glm-4.7`; Claude uses the verified configured Sonnet model.
3. Stop the normal personal-agent worker and any other clients using these bot names. The runner acquires its canonical runtime lease and refuses occupied comparison slots. Do not run two managers for the same world; the human-session endpoint does not establish personal-bot presence.
4. Both comparison source chests must contain their original disclosed one-time fixture stock: 128 oak planks and 64 cobblestone, with empty carried inventories and destination chests. Both new footprints must be clear. The runner inspects these facts and never replenishes stock, clears existing blocks or deletes failed work.

Run from the repository:

```sh
node tests/playable/agent-comparison.mjs
node scripts/compare_agents.mjs --run --serve
```

`--serve` keeps both agents connected after the comparison, including a partial result, without making further model requests. Stop it before restarting the normal worker. Reports, exact generated plans, native receipts, observations, timings and actual ledger changes are written under `.local/comparison/runs/<run-id>/report.json`. Session proofs are private files alongside that report; do not publish them.

Each usage checkpoint also saves the latest sanitized provider receipt, including available token counts, cost, request/response IDs and 0G catalog pricing. Trial totals cover every charged call, but only the latest receipt survives when geometry or repair adds multiple calls within a trial; this is not a complete per-request billing export.

An uncertain API charge blocks another request. Failed work and receipts remain for explicit reconciliation; the script does not automatically retry, cancel or erase them. A rerun requires reviewing the occupied slots and existing work first. Three bounded trials qualify these exact models and tools on those requests, not universal creative superiority or a production phase gate.

## Verified laptop run — 6 November 2026

See [the checkpoint](../evidence/AGENT_COMPARISON_CHECKPOINT.json). Both models passed delivery and arch. 0G geometry timed out; Claude produced the bench plan, but its native worker initially stalled at a block corner. The separate inference-disabled recovery completed the unchanged 14-block design after cardinal task navigation was enabled. Original failures, pending API reservation and material receipts remain preserved. Do not relabel the original comparison as six passes.

The recovery command requires the exact original private report hash and existing scoped sessions. It reconnects existing slots and resumes only the original task; it cannot create a new blueprint, reset inventory or spend API credit. `scripts/recover_agent_comparison.mjs` without `--run` prints its required arguments. The two agents remain connected under this inference-disabled worker; stop it before the normal worker starts.
