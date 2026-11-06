# Phase 1 — protected calculator local MVP

The user approved this focused milestone on 29 October 2026 and declined the oversized edge-case sweep. The ten-case local MVP gate is complete and approved by a separate AI QA peer against source release `14f0cd9bef36b7b2f69a765af6e46ac5b1ccab37`. It does not claim full production qualification.

## Implemented and demonstrated

- Real protected Minecraft calculator: correct 16/16, disclosed carry fault 10/16 with exactly six expected failures, actual repair back to16/16. Structural revisions advance1/2/3.
- Actual Survival placement and inventory accounting: chest redstone19→18; bot inventory0→1→0. No creative material creation is used for the placement.
- Receiving-side UUID/session/context permissions, actual native denial events, inspection input/structure ownership, protected review levers and bucket/early-unlock refusal.
- Original operation receipts survive identical serial/concurrent retries and a same-world restart without another stock charge.
- Four real isolated JVM recovery cuts: before durable intent, after intent, after native effect before receipt, and after durable receipt before workflow acknowledgement. All recover without a duplicate effect.
- Three immutable full reports bind job/agreement/blueprint/test context, all16 inputs, five actual stable samples per row and timed native lever transitions.

The lifecycle contains82 passing assertion groups and48 real truth-table rows. Existing Java checks pass376 core assertions,15 strict parser checks and51 mapping assertions. The54 Python checks and planning consistency checks pass. These layers prove different properties and are not summed into a claim of exhaustive coverage.

## Evidence and historical failures

The lifecycle is retained under `evidence/runs/p1-boundary/agentcity-boundary-130eaeb3/`. Its original wrapper remains FAIL for a manifest whitespace drift. The peer `integrity-resolution.json` confirms the executed sources were restored, and `evidence/runs/p1-mvp/executable-binding.json` verifies all37 main class entries are byte-identical between the lifecycle, current build and all four recovery JARs. This preserves the failure and adopts the actual observations without rewriting history.

The four recovery runs and bounded negative tests are retained under `evidence/runs/p1-faults/`. A chunk-unload test produced the correct incomplete inspection but could not establish a numeric stock value after restart; that auxiliary wrapper stays failed and is not claimed passed.

Historical candidate qualification additionally retains256 physical transitions and four input orders, including measured lag, but is not used to claim that the archived expanded matrix is complete.

## Run or review

`python3 tests/inspection/run.py --suite lifecycle` reproduces the focused live demonstration using the pinned local runtime. `python3 tests/inspection/run_checks.py` runs the Java checks. `python3 scripts/check_phase.py P1` reports the approved local gate after evidence binding.

## Limits and next phase

Paper1.21.11 is an unsupported historical fixture, published only on host loopback. Clients are offline agent-controlled fixtures; initial circuit/stock and external access infrastructure are explicitly seeded. There is no licensed-account, independent-human, token, AI-provider or settlement proof. Native Paper saving can block and is not atomic with the journal; restart reconciliation remains mandatory.

Phase2 is the full material-consuming survival construction worker, staged checkpoints and bounded resumption. It is not implemented or claimed complete here. The expanded Phase1 sweep is archived and broader original qualification requirements remain retained for later release work.
