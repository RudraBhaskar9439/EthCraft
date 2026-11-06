# Local Paper and Mineflayer compatibility fixture

This is a real, isolated compatibility test. It is not the calculator, a production permission system, independent participant proof or token integration.

## Requirements and execution

Use Docker with a running daemon, Python 3.11 or later, and Node 22 or later. The recorded local run used Node 26.3.1. The exact Java image is pinned in versions.json; pull it once if it is absent:

```sh
docker pull eclipse-temurin@sha256:5d90b26c0784ccf55af55f97cbcf7f3969c66a06299c93bdc72649219942a48f
python3 tests/compatibility/run.py
```

The runner installs the committed npm graph without dependency lifecycle scripts, downloads only the exact checksum-addressed official Paper artifact, and verifies its SHA-256 before execution. It bootstraps Paper, compiles the small Java fixture against the actual downloaded server libraries, and runs the Mineflayer assertions. No host Java or global npm installation is required.

Downloading/using the Minecraft server is subject to its EULA. This environment is used only for the owner-requested local development task; an EULA flag establishes no account ownership or token-platform exemption.

## What runs

The server port is published only at 127.0.0.1:25576. Remote console/query and command blocks are disabled. Two offline clients, FixtureBuilder and FixtureObserver, are both controlled by the test runner. They join without operator privileges in survival mode, spaced to respect the server connection throttle.

The fixture creates a small floor, real lever/wire/lamp circuit, two-item chest and one placement position. It asserts:

1. Both clients and Bukkit agree on lever off, wire power 0 and lamp off.
2. Actual lever activation produces wire power 15 and a lit lamp.
3. Actual deactivation returns the circuit to off.
4. The chest loses exactly one item; active and closed player inventory views retain exactly that item.
5. Placing the withdrawn item creates an actual cobblestone block and consumes the item.
6. Pathfinder moves to the bounded goal without digging or scaffolding.
7. Navigation leaves the measured world and stock state unchanged.

The plugin exposes observations only. It does not calculate lamp output from expected arithmetic. Every assertion must pass; missing observations, wrong stock or timeouts fail the run. A fresh uniquely named world prevents earlier failed tests contaminating later runs. Every attempt has a separate log/report directory. Cleanup is best-effort for this run's unique container, and cleanup failures cannot produce success.

Generated worlds, downloaded server/libraries, classes and dependencies stay ignored under .local/ or node_modules/. Selected redacted evidence is retained under evidence/runs/p0-local-compatibility/. The runner never marks a phase gate passed itself.

## Known limits

Paper 1.21.11 build 132 is historical and marked unsupported by Paper. It matches Mineflayer 4.39.0's explicit tested protocol list, but no currently maintained Paper/Mineflayer tested-version intersection was established. This fixture cannot establish supported production readiness.

The locked graph's npm audit reports six moderate affected-package findings associated with one UUID advisory; no high or critical findings were reported in that snapshot. Offline fixture operation does not resolve that advisory or validate Microsoft authentication. Do not apply npm's suggested ancient Mineflayer downgrade as a security fix. Review a compatible patched graph before authenticated/public adoption.

The two fixture clients are not independent humans or licensed-account proof. Real participant, platform and funded-chain checks remain mandatory in P4/P5. The calculator's 16/256 tests, real construction workflow and recovery invariants belong to P1/P2 and are not established by this fixture.
