# Testing and phase approval

P0 to P9 must earn technical approval through actual execution evidence. P10 completes controlled research comparisons and honest reporting. Current scenario status is recorded separately in evidence/Pn.json; a checked expected-value table is not a physical result. No finite list proves every possible bug absent; the matrix expands with exhaustive finite domains, generated boundaries, fuzzing, fault injection and each newly observed failure.

## Test layers

| Layer | Tool and environment | What it can establish |
| --- | --- | --- |
| Planning infrastructure | Python standard library and GitHub Actions | Consistent phase graph, source hashes, case IDs/digests, evidence schemas and gate behavior |
| Rule and parser tests | TypeScript test runner selected with the backend | Domain transitions, canonical encoding, strict schemas, quotas, permissions and accounting |
| Contract tests | Pinned Foundry, Anvil, official compatible dependencies | Authorization, replay domains, caps, deadlines, reentrancy, conserved balances and terminal races |
| Game tests | Real pinned Paper server and plugin | Actual block/lamp state, game timing, stock consumption, plot isolation and locks |
| Bot tests | Real Mineflayer execution against that world | Visible construction, correct orientation, bounded navigation and observation-based resumption |
| External integration | Real selected 0G, Arkiv and settlement test route | Actual inference/cost evidence, independent ownership/publication, real hook callback, purchase and canonical receipts |
| System and recovery | Real component composition with controlled faults | Cross-system journals, partial/unknown effects, confirmations/reorgs, backup restore and full player flow |
| Research | Registered experiments and intended users | Comparative decision value, market exposure, cost attribution and uncoached comprehension under stated limits |

Mocks can inject faults and isolate rules. They cannot substitute for live-world lamp readings, real model/provider access, independent Arkiv writes or the final v4 route. Screenshots explain a result but do not establish circuit truth.

## Generated edge cases

- Run every A/B input pair on correct, disclosed carry-fault and repaired builds. Run all 256 ordered input-state transitions and seeded input orders under declared timing conditions.
- Enumerate every supported lifecycle state/action/actor with guards true and false, forbidden pairs, self-retries, waiting substates and terminal outcomes.
- Check every action with assigned, revoked, unauthenticated and cross-job actors at receiving boundaries, including direct plugin and contract calls.
- For every numeric/time/length bound test one unit below, exactly at and above, plus missing/null/wrong-type/zero/negative/overflow/oversized input where applicable.
- Test all supported transforms, plot faces, negative coordinates, chunk edges, missing/unloaded observations and explicitly supported physical mutation hazards.
- Inject crashes before intent, after intent before send, after target mutation before receipt, and after receipt before acknowledgement. Replay, reorder and race both transport and semantic IDs.
- Exercise transaction rejection, submission, inclusion, confirmation, revert, drop, replacement and reorganization around the adopted threshold and after physical effects.
- Test both v4 currency sort orders, both zeroForOne directions and exact input/output modes under healthy, stale, unavailable and missing state, including direct route clients.
- Generate conservation sequences across custody/supply/claims/material use and escrow/rewards/refunds. Use independent integer calculations as the oracle.
- Fail dependencies individually and in interacting pairs; restore mismatched snapshots with claims and usable pass signatures outstanding. Unknown effects require reconciliation.

Freeze a subcase manifest before each generated run. Record its seed, exact required cases and all actual results. The case minimum in planning/verification.json is a lower bound; it does not permit omitting parameter variants. For complex matrices, P0 adopts the exact enumeration before the owning phase runs.

## Recording evidence

The canonical scenario is in planning/verification.json. Its SHA-256 digest binds the exact scenario, expected result, source and coverage rule. evidence/Pn.json stores execution results separately. A passing result requires status pass, matching case digest, complete subcase counts and at least one nonempty retained evidence artifact with its SHA-256. Keep artifacts below this repository, redact secrets and refer large raw results through a committed redacted manifest when appropriate.

Each phase record also identifies the exact Git release, environment, no relevant open defects, and approved review with reviewer, matching release and its own hashed review artifact. Review must inspect observed outcomes, unresolved policies, complete parameter coverage and live evidence; a file hash proves identity, not truth.

The gate script verifies an approved release in the current Git history, predecessor gate, exact case set/digests, statuses, counts and artifact paths/hashes. Earlier evidence remains eligible only while its declared implementation paths and the common dependency/build/shared scope in planning/scope.json have no committed or uncommitted changes. Phase ownership paths and dependency reviews must track actual shared interfaces so that affected evidence reopens; path matching alone is not a complete transitive dependency analysis. The checker rejects missing evidence, path escapes, changed cases, stale approval and open defects. It does not inspect arbitrary game logs or prove reviewers honest. Record actual run details inside the artifacts; do not type pass merely to clear a gate.

```sh
python3 scripts/check_plan.py
python3 -m unittest discover -s tests -v
python3 scripts/check_phase.py P0
```

The planning workflow runs the first two commands. They may pass while every product phase remains blocked. Actual component suites will be added in their owning implementation phase; a green planning workflow is not application completion.

## Approval procedure

1. Confirm predecessor and entry criteria, adopted decisions and exact environment/release.
2. Implement the phase and execute all mapped cases and generated variants. Preserve failing evidence and record a defect before fixing it.
3. Fix root causes, rerun affected cases and nearby boundaries, and run affected earlier/dependent regressions.
4. Record redacted immutable results, case digests, subcase counts and artifact hashes. Changed relevant implementation/dependency scope or case semantics require affected evidence and review to be renewed. Unchanged approved ancestor evidence can remain eligible.
5. Reviewer confirms the complete deliverable, no relevant open defects and actual evidence. Run the gate; only success allows the next phase.

Safety defects reopen their owning phase. Null or negative AI/economic findings do not fail honest research reporting; missing trials, unsafe behavior, invented results or unresolved comprehension defects do. Public release requires the separate platform and exposure-appropriate security decisions.

## Approved local milestone scheduling

The user approved local technical Phases 0 to 2 first on 29 October 2026. All 257 requirements remain mandatory: participant proof is P4-029 and token-platform/funded-chain preflight is P5-024/P5-025. The migration inventory retains original IDs and semantic hashes; CI checks preservation. Offline fixtures never satisfy those integration cases.

The real local compatibility fixture is run separately with `python3 tests/compatibility/run.py`; see [its instructions](../tests/compatibility/README.md). Static CI checks do not rerun that live server automatically. Its candidate is historical/unsupported by Paper and cannot establish maintained production support.

## User-approved local Phase1 gate

The current local MVP uses the ten focused scenarios documented in [P1_MVP_SCOPE.md](P1_MVP_SCOPE.md). The user declined the expanded edge-case sweep. Do not treat the historical1041/35 grids as this local gate or call their unrun variants passed. Original requirement families remain preserved for later release qualification.

## Focused local Phase 2 verification

The user's subsequent global no-deep-edge-cases instruction applies to Phase2. Its six local cases are defined in [P2_MVP_SCOPE.md](P2_MVP_SCOPE.md); original14 construction families remain under P9-059 through P9-072 with unchanged semantics. Execute an actual complete144-placement Survival build and16-row protected inspection, one interrupted resume with item conservation, occupied-target and shortage waits, one blocked route, pinned-manifest refusals and the focused receiving-boundary actor/session/revision/lock/expiry checks. Do not introduce exhaustive failure grids for this milestone.

Use one cooperative worker on one host. Local checkpoint exclusion and operation/session expiry do not prove a distributed task lease. P9-068 retains that requirement. Disclose the fixed 198 glass blocks and nine bottom stone slabs separately from circuit stock; no circuit item may be supplied through unmetered scaffolding. Any plugin change requires renewed affected P1 regression evidence before P2 can pass. Physical P2 artifacts include a disclosed 137 + 7 same-world construction, a separate real 16/16 inspection, material conservation and focused waiting/refusal checks. Preserve source-segment provenance and all failed wrappers. Exact phase approval remains recorded in evidence/P2.json and checked by the phase gate; runtime observations alone do not create approval.
