# Physical calculator candidate harness

This is an isolated electrical experiment, not a Phase 1 approval or construction
test. It seeds the reviewed upstream candidate into a fresh world, applies actual
lever input, and reads actual Paper lamp `lit` states. A separate Mineflayer client
checks the controls and lamps against its received world state.

```sh
python3 tests/world/run_candidate.py --adapter native_engine --suite normal
python3 tests/world/run_candidate.py --adapter native_engine --suite fault-repair
python3 tests/world/run_candidate.py --adapter native_engine --suite transitions --port 25579
python3 tests/world/run_candidate.py --adapter native_engine --suite orders --port 25580
python3 tests/world/run_candidate.py --adapter native_engine --suite orders --port 25580 --lag-profile candidate_75ms_per_tick
python3 tests/world/run_candidate.py --adapter native_engine --suite normal --port 25577 --lag-profile candidate_excessive_observation_delay
```

Each invocation creates a uniquely named Docker container, fresh world and
permanent evidence directory. It publishes only an allowlisted loopback game
port (25577, 25579 or 25580). It cleans only the container it created. Source
snapshots, runtime locks, hashes, complete stable observations, server output and
client observations remain in `evidence/runs/p1-candidate/<attempt>/`, including
failed attempts. The exact compiled fixture jar is retained with its hash. It
requires the pinned cached Paper artifact from Phase 0.

The native engine adapter calls the pinned server's actual `LeverBlock.pull`
method. It changes only a lever whose observed state differs from the requested
input, with at least ten server ticks and 500 milliseconds of monotonic time
between interactions. It never sets lamp
values from arithmetic. The jar declares Mojang mappings because it uses the
pinned engine API. Compatibility must be rechecked after any server change.

Every case physically establishes its source state, waits forty ticks, observes
five source samples, sets the target, waits forty ticks and reads five target
samples. The harness records game ticks and wall time, with fifteen seconds per
case and 180 seconds per sixteen-case suite. The 256-transition experiment uses
sixteen separately timed suites. Source and target lamp values must come from
real blocks; a missing lever or lamp aborts the experiment.

The carry-fault suite removes the disclosed high-output source torch while
leaving its lamp readable. The expected faulty output is `(A+B)&3`: precisely
six normal arithmetic cases fail, producing 10/16. Restoration occurs in the
same world and increments the fixture revision before a fresh 16-case run.
These fixture revisions do not substitute for production revision authority.

The `native_click` diagnostic adapter uses real Mineflayer lever interactions,
with an explicitly teleported, flight-enabled actuator. It proved the source
circuit works and exposed why generic Bukkit `setBlockData` is insufficient for
these attached levers. `bukkit_setter` remains a retained negative diagnostic.
Neither actuator proves navigation, survival building, licensed authentication
or independent human participation.

Acceptance must bind the final blueprint, production permission/stock/lock
boundary, checker implementation, timing profile and frozen coverage variants.
The optional75ms-per-tick main-thread delay is an explicit candidate calibration
experiment. A passing candidate run does not adopt it as the supported product
lag profile; the production checker must be tested under its frozen profile.
The excessive-delay experiment holds the first required target observation for
sixteen seconds. Its actual inspection must be `incomplete`, with a late failed
row and no usable pass. The outer run report records whether this expected
incomplete behavior was observed; it includes both expected and observed
inspection status explicitly.
No candidate report sets `full_phase_gate_passed` to true.
