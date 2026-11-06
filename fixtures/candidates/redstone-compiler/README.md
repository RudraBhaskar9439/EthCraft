# Two bit adder candidate

These small data fixtures come from [Redstone-Compiler/redstone-compiler](https://github.com/Redstone-Compiler/redstone-compiler), commit `f39ecf2d528598eff8866a1392fa7ee15eff1bbf`. The included MIT license and attribution apply. No upstream compiler code was executed or incorporated into AgentCity.

The RCELL text supplies a complete compact layout; the matching NBT stores 141 blocks and initial states. Its input/output metadata names a0, a1, b0, b1, s0, s1 and c1. Source coordinates use z as height; Minecraft coordinates are source `(y,z,x)`. Preserve that transform when reading the data.

The candidate manifest at `fixtures/candidates/redstone-compiler/calculator-candidate-v1.json` records every source placement and proposes three adjacent output lamps. Source material counts are 65 stone bricks, 4 levers, 16 repeaters, 37 redstone torches and 19 redstone dust. Three proposed lamps bring the candidate to 144 placements. This is not the final KIT bill.

Upstream verification uses its own simulator, not actual Minecraft equivalence. The NBT has no established DataVersion, embeds settled dynamic states, and does not provide the required accessible three-lamp player interface. Added lamps may affect circuit behavior. Input accessibility, physical initialization, settling, torch burnout, correct/fault/repaired outcomes and all 256 input-state transitions remain untested.

The files are a reviewable Phase 0 candidate, not a functional build, accepted blueprint or funded material promise. Phase 1 must validate/adapt or reject it using actual Paper observations. Dynamic power, lit and connectivity values must not be confused with structural changes.
