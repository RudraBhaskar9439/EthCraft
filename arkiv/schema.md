# Entity schema

Named schema: `ethcraft.task-progress.v1`, Rabdi 7794095. `backend/src/arkiv/tasks.mjs` exports its SDK definition and receiving validator.

| Field | Type | Indexed | Purpose |
| --- | --- | --- | --- |
| server | str | yes | SHA-256 deployment namespace; prevents cross-world discovery |
| task | str | yes | Random root task UUID; connects provider stages |
| job | str | yes | Random local objective UUID; revision grouping and owner-requested handoff reference |
| provider | str | yes | `claude` or `0g` worker slot, not a promise about every adaptive inference call |
| status | str | yes | running, paused, blocked, ready_for_review, handed_off |
| revision | u64 | yes | Monotonically increasing publication-journal sequence |
| facts | bytes | no | Bounded UTF-8 JSON with typed observed action facts |

Facts include version, controlled-fixture disclosure, successful/failed step counts, pending-effect flag, at most 12 recent successful tool summaries, local effect-receipt count and a SHA-256 commitment to those private receipts. Handoffs include the predecessor entity key. A commitment is not independent proof: the runtime remains the attester, and the receipt contents are not published. Action summaries allow only known tool names, Minecraft material names, bounded counts and integer positions. Requested counts are distinguished from observed produced/collected/moved counts. Purchase facts explicitly say whether delivery occurred.

Each entity is owned by the dedicated publisher wallet in `deployment.json`; players do not individually own these entities. Readers require the configured owner and namespace even when the schema tag matches. The writer requests read-only attributes and a seven-day lifetime. Read-only does not mean permanent or undeletable: Arkiv still permits owner-controlled deletion/ownership/expiry operations. The app does not automatically renew records. Stopping publication is not deletion of existing public data.

Historical snapshots are append-only in this application. SDK filtering uses owner, server and optionally provider, ordered by revision; status is filtered after selecting the latest job revision in the returned page. Each page covers at most 100 rows, including schema mismatches reported by the SDK. An explicit next offset exposes older history rather than silently claiming an exhaustive current snapshot.

Local objectives, native journals, signed transaction intents, identities, financial permissions, prompts and working plans remain private. Entity deletion or expiry never removes local receipts, grants a wallet capability or reverses item delivery.
# Work-order schema

`ethcraft.work-orders.v1` indexes `server`, `orderId`, `kind`, `item`, `status`,
`stage`, `deadline` and `revision`. `orderId` avoids Arkiv's reserved keyword
`order`; decoded application records expose it as `order`.
`data` holds a strictly validated versioned specification, canonical spec digest,
zero to two server verifications, advisory public claim metadata and fixture flag.
Every publication is an immutable seven-day snapshot. The owner-approved private
spec digest cannot be replaced by an external record. Public claims carry no fence,
owner identity or financial authority. Each verification includes worker, job,
item/count, world UUID, observation time, source/destination counts and evidence/
receipt digests. Raw inventories and receipts remain private.
