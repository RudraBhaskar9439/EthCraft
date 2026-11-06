# Observed Arkiv integration friction

Tested SDK: 1.0.1 on Rabdi. Historical project discovery used 0.8.1 on Tiramisu; a separately pinned npm alias preserves the older route. Current typed schemas, result shapes and paging differ, so replacing only the RPC would not be a valid migration.

During the first public fixture attempt, entity creation failed before signing with `SchemaMismatchError`: a raw bigint for the `u64` revision was inferred as `u256`. The receiving fix is explicit `u64(...)` and `bytes(...)` values. Reproduction: define a schema with a `u64` column, then pass an unwrapped bigint to `createEntity`. A schema-aware example showing all typed values, including bytes, would have shortened this diagnosis. The failed report was preserved; no transaction was signed on that attempt.

The public Rabdi client reports a missing-access-key warning. The tested successful writes/reads used that public endpoint; no measured rate-limit throughput or reliability claim is made. The UI exposes network failure and a manual refresh rather than polling every few seconds or displaying a cached success as a live read.

Canonical receipt recovery is implemented locally because a lost response must not create a replacement entity. SDK event decoding and `getEntity` made that possible. A documented durable-sign-before-broadcast example would help agent developers avoid duplicate writes after timeouts.

Prototype payload revisions created during development remain in testnet history and are excluded when they do not satisfy the final payload validator. Preserved qualification reports distinguish those development attempts from the final verified build. No slow-query load test was run against the public RPC.
