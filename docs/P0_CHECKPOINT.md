# Phase 0 local technical checkpoint

The user approved local technical Phases 0 to 2 before integration prerequisites on 29 October 2026. This checkpoint prepares the real game environment, candidate blueprint and implementation policy oracles. It does not establish the working calculator, a bot-built commission, independent participants or blockchain integration.

## Physical execution evidence

The [retained compatibility attempts](../evidence/runs/p0-local-compatibility/attempts.json) preserve failed development attempts and the subsequent passing run. The final probe used actual Paper game state, not an arithmetic model or screenshots.

| Component | Observed or locked value |
| --- | --- |
| Minecraft/Paper | 1.21.11 build 132; exact official SHA-256 recorded in versions.json and run report |
| Vendor support | Paper marks this historical release UNSUPPORTED; isolated local fixture only |
| Java | Temurin 21.0.12.1 in a SHA-256-pinned Docker image |
| Node | 26.3.1 on the development host |
| Bot | Mineflayer 4.39.0, pathfinder 2.4.5, exact transitive npm graph committed |
| Network | Server published only on 127.0.0.1:25576; no remote console/query |
| Actors | Two offline agent-controlled fixture clients in survival, without operator permission |

Seven live assertion groups pass: initial off, real lever on, real lever off, exact withdrawal, real material-consuming placement, bounded navigation, and unchanged world after navigation. Both client views and plugin observations agree. Chest stock moves 2 to 1, player inventory moves 0 to 1 to 0, and the actual placement becomes cobblestone.

Development failures exposed a premature probe launch, connection throttling, a wire-power representation difference, the active-window inventory API, and post-close observation/fixture isolation. The runner now validates prerequisites, respects throttle spacing, compares the protocol representation correctly, reads the active inventory then the closed inventory, allows bounded observation settling and starts each run in a fresh fixture world. Failed reports were retained rather than rewritten as passes.

## Candidate calculator data

The [candidate manifest](../fixtures/candidates/redstone-compiler/calculator-candidate-v1.json) records all 141 MIT-licensed upstream placements and three proposed output lamps, with source hashes and original license. The proposed bill is 65 stone bricks, 4 levers, 16 repeaters, 37 redstone torches, 19 redstone dust and 3 lamps. It is not a KIT promise.

The upstream source is a simulator-tested candidate. Its added lamps, accessible inputs, initialization, torch burnout, actual 16-case truth table and 256 transitions remain unvalidated. Phase 1 must adapt, validate or reject it. The static candidate tests check provenance, bounds, ports, material accounting and complete expected inputs; they do not prove redstone behavior.

## Local policy and verification scope

The [engineering baseline](P0_POLICY_BASELINE.md) and versioned policy fixtures define default-deny authority, lifecycle transitions, units and boundary comparisons, immutable funded terms, ownership, lock lifetime, retry/load targets and research rules. Targets are acceptance criteria, not measured performance or participant approval. Actual receiving-side enforcement is verified in its owning implementation phase.

The [requirement-preserving migration](../planning/gate-migration-2026-10-29.json) moves only the first required execution phase: independent participant proof is P4-029; token-platform suitability and funded-chain preflight are P5-024/P5-025. All 257 semantic requirements remain present and those three integration cases remain blocked. The migration does not create accounts, signatures, funds or a private/testnet exemption.

## What remains before the requested Phase 2 endpoint

Phase 1 still needs the protected job plot, actual calculator/checker, structural revisions/locks, permission and hazard controls, and complete correct/fault/repaired/transition evidence. Phase 2 still needs material-accounted staged construction, interruption recovery and bounded repair. The small compatibility fixture does not pass either phase.

After the P0 local gate and review pass, the next work batch is Phase 1. The repository requires a full report and pause after every push, including this checkpoint.

## Navigation evidence renewal

The initial navigation assertion checked client position. A later boundary test exposed that evidence gap. The renewed smoke probe now requires Paper to report the actual builder at `[-2,81,0]`; both clients read the same server observation. Attempt 07 retains a test-variable error, and attempt 08 passes all seven physical groups. The earlier attempts remain unchanged. See `evidence/runs/p0-local-compatibility/renewal-20261029/` for the renewed assessment and review.
