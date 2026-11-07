# Laptop host operations

> **Historical environment.** For the current Mumbai/UniRock host, start with the [current documentation index](README.md) and [Mumbai operator qualification](MUMBAI_CITY.md#operation-and-verification). The loopback split-demonstration setup below is retained for its original checkpoint; do not use it to restart or reconfigure the current player host.

The laptop hosts the current preparation environment on loopback only. Minecraft uses internal game materials. The blockchain demonstration uses separate synthetic stock and inspection. Starting services or restoring a database never grants Minecraft items or access.

The console is a trusted local operator interface, not a shared application with per-user authentication and roles. Host checks and its same-origin/CSRF token do not change that boundary. A person given access to a forwarded console can obtain its token and run buttons that invoke the configured testnet developer-role wallets. Do not port-forward, tunnel or expose this console as a shared UI. Public/shared access remains blocked until real user authentication and role authorization are implemented and verified. Human wallet-approval links collect offchain approvals only and do not provide that console authorization or complete human-controlled contract acceptance.

Use these commands from the repository. Docker, Node, the pinned dependencies, Foundry and the installed Ollama `qwen3:1.7b` model must already be available.

```sh
python3 scripts/local_host.py status
python3 scripts/local_host.py start
```

`status` checks owned PostgreSQL, both local RPC chain IDs, the installed Ollama model, the backend console and the owner-validated access world. A listening game port proves reachability, not authenticated multiplayer or correct game behavior. `start` reuses the existing database, Anvil and Arkiv helpers, starts a missing loopback Ollama/backend process, and starts the saved access-world container only after checking its exact owner and loopback port. It never stops services, replaces worlds or resets jobs. An occupied port is reused only if the corresponding health check succeeds; an unhealthy service remains an error. No public port or tunnel is created. Main-service startup during deployment work must be coordinated with the active implementer.

The backend remains at `http://127.0.0.1:8789/`, Minecraft at `127.0.0.1:25588`, Ollama at `127.0.0.1:11434`, PostgreSQL at `127.0.0.1:55432`, local Anvil at `127.0.0.1:8547` and local Arkiv at `127.0.0.1:8557`. Host process logs and PID records stay under ignored `.local/ops/`; application credentials remain outside Git. Keep the laptop awake and connected during a demonstration. This temporary host has no uptime guarantee.

## Online database backup and genuine restore check

```sh
python3 scripts/local_host.py backup
python3 scripts/local_host.py restore-check /absolute/path/to/.local/ops/backups/BACKUP_DIRECTORY
python3 tests/recovery/smoke.py
```

The backup command prints its exact directory. It holds a read-only PostgreSQL snapshot, fingerprints all application tables, and passes that same exported snapshot to the PostgreSQL 17 `pg_dump` tool. Current jobs may continue writing. The archive uses PostgreSQL's custom format; the archive and manifest have mode `0600`, inside a `0700` directory under ignored `.local/ops/backups/`. Treat every backup as private application data. No credentials, table rows or signer passwords belong in committed recovery evidence.

`restore-check` verifies the archive SHA-256, creates a new `agentcity_restore_<random-id>` database with `template0`, runs the actual `pg_restore`, and compares every restored table's row count and deterministic content fingerprint with the original snapshot. It never targets the live `agentcity` database, starts restored workers, signs transactions or repeats game mutations. The isolated database is retained for inspection; its generated name appears in the result. Remove only that named verification database when finished with it. The focused smoke script also checks container ownership, archive corruption refusal and unchanged live-container identity/start time. Pass an existing backup directory to the smoke script to verify it without taking another backup.

This is a database recovery proof. Sequence state is restored by `pg_dump`; the table comparison does not independently certify concurrent sequence history. A database archive alone is **not** a coordinated backup of the world, plugin journal, local blockchains, signing secrets and local pointers. The same laptop copy also provides no protection against losing the laptop; copy the private archive to a user-controlled separate disk before relying on it for disaster recovery.

The isolated restore intentionally uses `--no-owner --no-acl`. It does not recreate production role/grant configuration. The [actual focused database check](../tests/recovery/runs/128a4e332e234fe388e63c25add5bca0/report.json) restored and compared 162 tables and 345 rows without replacing the live database.

## Coordinated database and console restart

```sh
python3 ops/restart_recovery.py
```

Use this only in a coordinated idle window. It requires `/api/status` to show no running job, no active application database transaction, the exact PostgreSQL owner/loopback binding, and a console listener that matches its saved host PID, operating-system user, workspace and command. It stops only that console PID and restarts only `agentcity-postgres-local`, then runs the existing `local_host.py start` and `status` commands. It does not stop Anvil, Minecraft or unrelated containers and never invokes a demo purchase or signer action. Reload the browser after a console restart to obtain its new request/session state.

The [actual restart proof](../tests/recovery/runs/restart-9b086d7733af4c7893eaff04b515916f/report.json) preserved every row fingerprint across **229 tables and 569 rows**, including the current Unichain and Arkiv ledgers. The same PostgreSQL container restarted and a new owner-verified console PID started. Both completed UI job identities remained unchanged. A fresh post-restart online archive was restored into a new isolated database and all 229 tables/569 rows matched again. The Anvil head, the user's access-world container, and every other running-container start time stayed unchanged. Signing keystores were not modified.

The public-testnet ledger snapshot includes three jobs and three delivery receipts, with six outbox rows and 42 Unichain chain intents; the separate Arkiv ledger contains 14 intents. Counts and before/after fingerprints are retained in the report. The backup itself stays private under `.local/ops/backups/`; it supersedes the earlier smaller snapshot for current-ledger recovery. Resuming a completed public job to prove zero extra transactions is a separate application-level check after the host is ready.

## Isolated local-chain recovery

```sh
python3 ops/chain_recovery.py
```

This command reads the idle local Anvil instance, keeps its dump private under `.local/ops/chain-backups/`, and loads the snapshot into a temporary Anvil process on loopback port `18547`. It refuses an occupied verification port and stops only the process it created. It compares all captured accounts, including balances, nonces, bytecode and storage, plus a known transaction/receipt/block and the genesis identity. It leaves the main `8547` instance unchanged.

The actual Anvil 1.7.1 check preserved all 32 accounts and the known receipt, transaction, block and genesis identity. Historical account state did **not** survive the default dump/load. Its report therefore sets `requiresReconciliation: true`. Do not present this as complete historical recovery or enable old pending workers just because current balances match. Preserve canonical receipts separately and reconcile unknown operations before resuming them. The command repeats this inspection and records the actual result for the current snapshot rather than assuming every Anvil version has the same behavior.

The [actual isolated chain check](../tests/recovery/runs/anvil-cb425fa40ea640c08301d1a0b20e709f/report.json) records these state and history results. Only its temporary process was stopped; the main chain head remained unchanged.

## Isolated saved-world recovery

```sh
python3 ops/world_recovery.py COMPLETED_INTERNAL_RUN_ID
```

Run this only after the fixture owner supplies a successful internal run and confirms that its server has saved and stopped. The tool checks that ownership record, the executed plugin hashes, and the absence of any running container mounted on the source. It archives the stopped directory privately, extracts a new copy, and compares every saved-file fingerprint before boot.

The copy runs on loopback ports `25594`/`25595` in observe-only continuation mode. The fixture cannot bootstrap a new circuit or replenish stock. The check observes all 144 restored structural block states, empty stock and durable revision 144. It reconnects the saved builder and requester so the receiving boundary can reconcile their actual inventories, then authenticates a new fixture-inspector session. An old local review lock is released only after its recorded pass validity expires; the checker requests a new real 16-case lamp inspection. It checks that no new block placement occurred and retains the passing inspection and review lock. Cleanup checks the exact clone owner before stopping/removing only that clone. The original fixture files and the user's access world on `25588` remain untouched.

The [actual cold-world check](../tests/recovery/runs/minecraft-a582a9b5748447088f4a938d0752676e/report.json) verified all 217 archived/extracted files and obtained a new real 16/16 report `e041f584-4991-4105-b88d-5a3b841887a1` at revision 144. The source remained unchanged and the user's access-container identity/start time stayed unchanged. Earlier observer-wrapper and missing-role-session failures remain retained beside the passing attempt. They led to corrections in the recovery observer, not changes to the saved world or plugin.

This verifies a completed saved fixture. It does not establish authenticated human access or recovery of a partially built job, and it does not connect Minecraft to a contract, wallet, purchase or payout. Immutable job deadlines are preserved; the tool cannot extend an expired job to obtain another pass. The actual result is recorded under `tests/recovery/runs/minecraft-.../`; failed attempts remain retained.

## Coordinated service recovery

Each service needs a planned quiet period for its own consistent cold snapshot. The revised route has no economic bridge between Minecraft and the blockchain demonstration, so it does not require one global atomic world/chain snapshot. Do not stop or restart active services while deployment work is running. Isolated recovery copies can be tested without replacing those services.

1. Stop accepting new jobs and wait for active workers and transactions to finish or become explicitly pending. Retain each original operation ID, intent and receipt.
2. Coordinate a flushed Minecraft save and a matching plugin journal/checkpoint capture. Capture the local chain and its demonstration journal separately from Minecraft. Capture owned Arkiv data at its own quiet point, with deployment identities and the exact Git release. Do not copy a running database's raw data directory as a logical backup.
3. Preserve private configuration and signer material separately with private permissions on a user-controlled disk. Keep them out of reports and Git. Record the hashes and time of each component without publishing its contents.
4. Restore into isolated services first. Keep workers disabled. Compare the database journals with actual world observations and canonical chain receipts. A public testnet cannot be rolled back by restoring a local file; an old database may lag already-confirmed transactions.
5. Reconcile every pending/unknown effect before enabling writers. Reuse original signed transaction bytes and semantic operation IDs where appropriate. Never create another purchase, payment or material delivery merely because an acknowledgement is missing.
6. Run health checks and a bounded end-to-end check, then reopen the host. A switch to a restored database or a production-service restart requires explicit coordination and verification.

The online database test does not establish world or chain recovery. The isolated chain report records its state/history limits separately. Authenticated shared access and the independent human's final acceptance remain separate release checks.

## Local Discord availability

Run `python3 scripts/local_discord_supervisor.py` to keep the identity-only bot available after a Discord WebSocket crash. A private filesystem lease prevents duplicate supervisors; child failure restarts after at least 15 seconds. A clean exit or supervisor SIGTERM stops it. The current child and supervisor PIDs are in ignored `.local/mumbai/local_discord-process.json`; private logs remain in `.local/mumbai/local_discord.log`. Credentials and approvals are unchanged. Do not start `scripts/local_discord.mjs` separately while the supervisor runs. This is a local session service; it does not install a system boot service.

For the shop merchant, run `python3 scripts/local_discord_supervisor.py merchant`.
It reconnects the existing controlled BankSeller after normal disconnects or
crashes, waiting 15 seconds between attempts. It never passes `--bootstrap`,
grants materials or signs payments. Its distinct lease and
`.local/mumbai/mumbai_merchant-process.json` retain the child/supervisor PIDs.
Do not start a second BankSeller process. Stop the recorded supervisor PID to
stop recovery deliberately. A merchant that is offline makes the catalog
unavailable; reopening `/market` after it reconnects reads its actual remaining
stock. A successful stock read does not authorize a purchase.
