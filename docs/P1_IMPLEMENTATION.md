# Historical expanded verification design

The user superseded this expanded sweep for local Phase1. The current gate is the ten-case functional MVP in [P1_MVP_SCOPE.md](P1_MVP_SCOPE.md); this document and its variant IDs remain an archived engineering reference, not local completion criteria.

# Phase 1 implementation and acceptance contract

Phase 1 delivers a real protected calculator and a deterministic inspection service. It does not complete the bot builder, AI integration, marketplace or payments. Enter P1 only while `python3 scripts/check_phase.py P0` returns ready for the unchanged approved scope.

The [canonical requirements](../planning/verification.json) retain all 24 P1 scenario families. The [frozen variant enumeration](../tests/inspection/coverage.json) expands them into **1,041 mandatory variants**. This document and that enumeration contain no passing product results or gate approval. A finite matrix cannot prove that every possible defect is absent; newly observed failures become retained regression variants.

## Implement the smallest complete boundary

Use the Paper plugin as the receiving authority for world and job-stock changes. Decode a strict typed envelope containing the stable operation ID, server, job, agreement version, authenticated actor, expected structural revision, current authorization reference, expiry, action and typed parameters. Recheck live authority inside the serialized game-thread mutation boundary. Reject unknown fields, duplicate JSON keys, stale context and unsupported transforms before any effect.

Persist intent before physical changes and a durable receipt before acknowledgement. Bind an operation ID to the complete canonical payload. Repeating a completed request returns its original result. An ID reused with different semantics is an audited refusal. A crash with uncertain world or inventory effects creates a persistent quarantine until real observations establish what happened; it never triggers blind replay. Store enough context to relate stock in the container, stock carried by the actor and placed/broken blocks.

Maintain a monotonic structural revision and a durable inspection lock. Natural power, lamp `lit` and wire connectivity changes do not create structural revisions. Authorized structural edits do, including restoring a block to its earlier state. Persist the lock before the checker touches controls. Keep structure protected while any issued pass remains usable or acceptance is unknown. Early unlock is disabled in the adopted policy.

Protect the full plot and job stock from direct player/bot interactions and the declared indirect world hazards. Default-deny unvalidated administrator/plugin edit paths. A cancelled synthetic event proves only the event guard rule. Physical attempts and final real world observations establish prevention on the tested Paper release.

## Freeze the physical calculator

The Redstone-Compiler source is a candidate. Its simulator, NBT parse and material list do not establish real Minecraft behavior. Validate or adapt the circuit, preserve its license/provenance, then freeze the exact blueprint, support/orientation properties, material bill, four weighted levers and three weighted lamps. Identity is the only supported orientation in the initial policy. Refuse all other rotations/mirrors explicitly.

Bind the approved control names, weights, coordinates, support blocks and block types to the blueprint and test manifest. A numerically convenient remapping cannot replace an approved interface. A missing lamp or unreadable chunk is an incomplete observation, never an unlit lamp.

Calibrate reset ticks, settling ticks, stable-observation count and monotonic wall ceilings on the real pinned server. The P0 values of 40 reset ticks, 40 settle ticks, five stable observations, 15 seconds per case and 180 seconds per run are candidates until measured. Record both the supported normal and induced-lag profiles. If a candidate ceiling cannot accommodate the declared procedure, resolve and freeze the measured policy before acceptance; do not silently ignore the ceiling or relabel exploration as a passing run.

The checker owns all four inputs during inspection. For each row it resets, sets the declared A/B bits, waits the frozen tick interval, reads the three actual lamp states and retains stable observations plus elapsed time. Arithmetic determines the expected value only. Actual `lit` states determine the observed value. During Review the requester may toggle the four approved levers while structural protection remains active.

Prepare the disclosed carry fault by disconnecting the high-output feed while leaving a real readable high-output lamp in place. Its expected observed value is `(A+B) & 3`: exactly six sums requiring weight four fail. Removing the lamp itself is a missing-observation fault. Repair the declared connection through an authorized structural mutation and rerun all 16 inputs at the new revision. Keep the failed report unchanged.

## Bind acceptance before execution

The coverage file freezes the variant enumeration. Each acceptance run manifest must additionally freeze:

- Exact source release, plugin/engine/build/dependency hashes, Paper/Java/Node/Mineflayer environment and world identity.
- Actual local actor UUIDs, authenticated sessions, assignments, stock ownership and plot origins. Fixture actors do not establish independent human control or licensed-account ownership.
- Validated blueprint, material bill, control mapping and test-manifest versions/hashes, plus the exact carry fault and repair positions.
- Measured timing and lag profiles, all units/equality rules, wall deadlines, authority-clock anchors, delay values, fault barriers and seeds.
- The complete coverage file hash and every variant ID selected for that run.

Candidate exploration can calibrate these values and reveal failures. Acceptance results must be executed under the frozen bindings. A changed circuit, timing rule, implementation dependency or case oracle requires a new binding and affected reruns, with the prior history retained. If the final material bill changes, update the stock-item variants to cover every final material before acceptance.

## Case-by-case implementation and genuine verification

The counts below refer to explicit parent variants. Some contain complete nested runs. Do not count an unexecuted nested row as passed.

| Case | Variants | Implementation and least sufficient verification |
| --- | ---: | --- |
| P1-001 | 16 | Read actual Paper lamp states for every A/B pair on the correct circuit. Retain all 16 distinct rows, lever states, timing, revision and context. Aggregate must be 16/16. |
| P1-002 | 16 | Apply the disclosed high-output feed fault and read all 16 real cases. Assert exact observed values and the six declared failing pairs; no usable pass. |
| P1-003 | 16 | Repair through an authorized command, prove a newer revision and run all 16 cases. Retrieve the unchanged older failed report and new 16/16 report. |
| P1-004 | 38 | Try every pairwise input/output label and coordinate swap, missing/wrong-type interface block, manifest mismatch and an extra unapproved electrical block. Validate the complete approved structure/interface before readiness. Use real block mutations for block variants and exact altered manifest bytes for manifest variants. |
| P1-005 | 12 | Run four explicit 16-input orders under normal, supported-lag and excessive-lag profiles. Physically precondition high/low signals. Supported runs complete correctly; excessive lag explicitly times out or becomes incomplete. Retain real tick and wall measurements. |
| P1-006 | 30 | Unload the chunk containing each required input/output, remove each lamp/input support, or make the adapter unavailable during setting/measurement. Retain actual availability and explicit incomplete reasons; never infer zero. |
| P1-007 | 24 | Exercise six mutation/inspection actions with four unauthorized actor classes directly at the plugin. Compare actual blocks, stock, revision and lock before/after every typed refusal. |
| P1-008 | 124 | Prepare real permitted boundary targets and exercise both placement and repair on six inclusive faces and six outside points for positive, negative and chunk-edge origins. Refuse unsupported transforms, coordinate overflow and outside world height without charging stock. |
| P1-009 | 64 | Attempt the declared hazards inside and across the plot boundary during inspection/review, plus disabled admin/plugin edits. For water and lava, distinguish natural flow, sneaking bucket use against allowed controls/stock and adjacent dispensers. Record physical sources/events and final structure; cancelling only later flow cannot establish prevention of initial fluid placement. |
| P1-010 | 36 | For each of six candidate materials, test exact stock, one short, wrong item, inaccessible stock, forged client count and creative mode. Observe real job/actor inventories and target blocks. Success consumes once; refusal consumes nothing. Unsupported creative placement must be refused before it creates an unconsumed block. |
| P1-011 | 14 | Exercise four stock mutations with strangers, another job and an unassigned bot. Verify permitted withdraw/return with durable receipts and real inventory conservation. Unsupported container movement stays denied. |
| P1-012 | 177 | Test every envelope field missing/null/wrong-type, raw duplicate keys, cross-context/stale/revoked requests, expiry equality, numeric/length/byte bounds and action parameters. Parser-valid controls still require live receiving-boundary authorization; parser tests cannot stand in for actual plugin effects. |
| P1-013 | 13 | Complete a real consequential operation, then retry serially, concurrently, after restart and after command expiry. Compare original receipt identity and one total effect. Change each semantic field while reusing the ID and prove collision refusal. |
| P1-014 | 26 | Terminate the real process at four durable boundaries for place/break/repair/withdraw/return, plus partial stock/world windows for structural commands. Restart, observe actual state and retry the same ID. Retain proved-not-applied, completed or quarantined outcomes. |
| P1-015 | 4 | Race two same-revision edits at same/different targets, and execute edit-versus-lock in both controlled orders. Retain actual serialized execution order, revisions and receipts. |
| P1-016 | 4 | Race two inspections and overlap inspection with building in both orders. Attempt inspector unlock during an active checker, then an edit. Refuse unlock or stop/invalidate the checker before releasing protection. Verify one durable owner and one coherent revision in every row. |
| P1-017 | 16 | A real external player and bot each attempt every lever during setting and measurement. Observe denied/serialized interaction or explicit invalidation, with no accidental usable pass. |
| P1-018 | 17 | After a genuine pass, toggle each requester lever off/on and observe unchanged revision/protection. Refuse breaking controls/circuit/support/lamps, repair and early unlock while the pass remains usable. |
| P1-019 | 3 | After all prior passes become unusable, use the authorized Building state to edit/restore a lever, circuit block and support. Each edit advances revision. Validate old-report revision mismatch independently and obtain a new full 16-case report for each target. Never add an early-unlock API for this test. |
| P1-020 | 25 | Restart gracefully/forcibly during inspection/review, interrupt the checker, corrupt/lose lock records, and test pass/review/work deadlines at minus one/exact/plus one millisecond. Reverse authority time during prepared work/inspection, after pass expiry and across restart. Expired readiness never revives. Attempt an edit immediately after recovery; protection survives or fails closed before commands resume. |
| P1-021 | 79 | For every input row try omission, duplicate replacement, expected-value tamper and observed-value tamper. Alter report context/hash/status and try unauthorized pass issuance. Retain exact validator refusals and unchanged originals. |
| P1-022 | 12 | For passed/failed/incomplete reports delete projections, restart storage/backend, disable publication and combine deletion/restart. Retrieve original full bytes/context by stable ID/digest. Local publication faults do not prove Arkiv integration. |
| P1-023 | 19 | Delay disclosed model/database/chain I/O fixtures individually and in pairs, plus all three, within/beyond declared timeouts. Try 31/32/33 queued commands and 1/2/3 acknowledged interactions per second against the adopted limits. Observe actual Paper ticks and real client acknowledgements. Bound admission before expensive game tasks; latency/failure never fabricates changes. |
| P1-024 | 256 | Establish and physically observe each from-state, then reset/set/settle/read each target state. Exhaust all 16 by 16 ordered transitions, including 16 unchanged states. Under the frozen supported profile all target observations must be correct. Missing/late observations explicitly fail that acceptance run. |

For P1-005 every supported parent variant contains all 16 rows. An excessive-lag variant may stop at its required explicit incomplete/timeout outcome. Each P1-019 parent variant also requires a new complete 16-row inspection after restoration. These nested obligations supplement the 1,041 named parent variants.

## Evidence and recovery requirements

For every variant retain its canonical case digest, coverage hash, exact run bindings, variant ID, expected and observed outcome, timestamps, final status and immutable evidence paths/hashes. Deliberately expected refusal, faulty 10/16 report or quarantine is a successful verification only when that behavior is observed and no unauthorized readiness exists.

For consequential commands retain the canonical payload digest, actor/context/expiry, current authorization, before/after blocks, actual job/actor item counts, structural revisions, lock state and durable intent/receipt/quarantine. For concurrency and crashes retain the dispatch, boundary and recovery ordering. Never erase failed attempts or overwrite a failed report with repaired data.

For physical runs retain complete lever/lamp observations and real timing for every required row or transition. Diagnostic screenshots may help review but cannot replace these observations. Missing files, unexplained signals, unavailable blocks, invalid mappings, unmeasured timing, lost lock evidence or ambiguous mutations block readiness.

Store full reports durably before adding a searchable/public projection. Restart and projection deletion must not destroy passed, failed or incomplete reports. An unavailable external publisher cannot invent readiness or erase obligations. P1 can use local storage/publication-delay fixtures; the real external integration is verified in its owning phase.

Use the same inventory authority, operation IDs, revision checks and lock boundary that P2 Mineflayer construction will call. Validate actual material placement compatibility now, including required supports and orientation. An operator-populated test stock chest is an explicitly disclosed fixture; it proves no token backing, purchase or redemption. A stage completion receipt remains progress evidence, never a functional calculator pass.

## Exit and scope

Run focused strict-parser/engine tests, the real Paper permissions/stock/hazard/recovery suites, and all frozen physical acceptance variants. Preserve failed attempts, fix root causes, rerun affected boundaries and review scope/dependency coverage. Record actual results in `evidence/P1.json` with complete immutable artifacts, exact release/environment and a genuine review. Only `python3 scripts/check_phase.py P1` success permits P2.

Static manifest consistency checks and planning tests prove only the test plan's internal consistency. Pure arithmetic, simulated inventories, source/simulator tests, screenshots and a model claim cannot establish physical P1 completion. The independent participants, actual token-platform suitability and funded-chain prerequisites remain preserved and unproved in P4-029, P5-024 and P5-025. Nothing in this phase authorizes token-linked production deployment.

After any successful push, provide the required changes/tests/risks/gate/next-step handoff and pause until the user resumes. A checkpoint push does not make P1 ready.
