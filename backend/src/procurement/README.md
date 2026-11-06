# Local procurement budget service

Migrate `schema.sql` after the canonical agreement schema. Construct `createProcurementService({ store, evm, deployment, account, confirmations: 1 })` with the trusted loopback deployment and its local requester account. This does not authorize a public deployment or establish live finality.

`prepare({ operationId, agreementHash, kits, maxCred, deadline })` accepts a canonical lowercase UUID, one whole KIT, a positive CRED base-unit cap, and a chain-time deadline at most 60 seconds ahead. It requires the requester's funded canonical agreement. Recipient, destination, chain, assets and procurement contract are derived from trusted context; request data cannot supply calldata or redirect delivery.

`destinationHash(record)` is `keccak256(abi.encode(bytes32 serverId, bytes32 jobId, string worldId, int32[3] stockChest))`. Share this exact identifier with the delivery receiver.

The service locks the agreement row and reserves `maxCred` before signing or sending. Concurrent operations cannot reserve more than the remaining aggregate material cap. The stable operation ID binds the agreement, original calldata, requester, route and chain instance. Changed retries are refused.

`broadcast(operationId)` sends only LocalEvm's original signed bytes. Unknown sends retain their full reservation. `reconcile(operationId)` freshly checks the canonical receipt and both the route's `Purchased` event and KIT's `ClaimCreated` event. Confirmed spend replaces the reservation with actual CRED spent; only a canonical reverted receipt releases a failed purchase. Missing/reorganized previously confirmed results require reconciliation and block new sends/purchases. No automatic cancellation, replacement transaction or second purchase repairs an uncertain outcome.

`get`, `prepare`, `broadcast` and `reconcile` return snake-case records including `operation_id`, `status`, `transaction_hash`, `claim_id`, `spent_cred`, `max_cred`, `destination_hash`, `requester`, `job_id`, and `kits`. Numeric values are decimal strings. `budget(hash)` returns `cap`, `spent`, `reserved`, `available` and `blocked`. Cached records are not delivery authority; use fresh canonical claim verification before applying inventory effects.

Focused tests:

```sh
node tests/procurement/local.mjs
node tests/procurement/authorization.mjs
```

The first test uses real PostgreSQL, actual wallet signatures/funding and a real v4 purchase. It injects a lost send response, verifies aggregate cap/replay and canonical revert release, then restores only its owned Anvil test window. Run it while other local-chain writers are paused. The second test uses an isolated PostgreSQL authorization fixture and makes no chain writes or snapshot changes.

Limits: one cooperative local chain, one KIT per purchase, fixture wallets and synthetic delivery. An unprepared/unknown reservation is deliberately not released merely because a timer expires. Deeper reorganizations and physical effects require the existing incident policy; this service is not a production finality or recovery certification.
