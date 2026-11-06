# AgentCity architecture and authority

AgentCity coordinates a supported commission across a real game world, durable workflow storage and external records/contracts. The first service is a fixed redstone calculator. Each input accepts 0 to 3; three weighted output lamps display the sum. Actual game-state inspection runs all 16 input combinations.

## Components and reuse

| Component | Implementation | Responsibility |
| --- | --- | --- |
| World authority | Java Paper plugin | Plot permissions, inventory custody, structural revisions, inspection locks, deterministic checker and durable game receipts |
| Coordinator | TypeScript backend and one relational store | Agreements, task leases, command journal, outbox/inbox, adapters and readable projections |
| Physical executor | Mineflayer with bounded pathfinder | Movement, inventory retrieval, staged blueprint placement, observations and resumable checkpoints |
| Decision adapter | Documented 0G Router HTTP path first | Bounded context, actual selected model/provider capabilities, validated proposals and measured billing |
| Discovery | Arkiv SDK with viem | Independently owned profiles, services, jobs, offers, progress and evidence references |
| Economy | Compatible v4 contracts/router and custom contracts using reviewed OpenZeppelin primitives | CRED/KIT, unique issuance, claims, registry/hook, capped swaps and labor escrow |
| Player companion | Small web interface using wallet signing and viem | Account linking, identical terms, approvals, bounded transaction review, receipts and claims |
| Operations | Same backend workers plus operator-only views | Reconciliation, role management, health reporting, backups and recoverable incidents |

Use platform APIs and installed libraries. Keep business rules in their owning component; backend approval never bypasses plugin or contract validation. One backend process can run logical workers until measured requirements justify separation. The exact framework and database version are P0 decisions, not a reason to add multiple app scaffolds.

## Sources of truth

The plugin/world own blocks, protected stock and structural revisions. The relational database owns workflow state, leased work and operational intents. Contracts own canonical token balances, redemption claims and payment entitlements. Arkiv owns attributable discovery records; its projections do not authorize a purchase, delivery or acceptance. The checker owns functional findings over a locked revision. The model only proposes actions from observations that may be stale.

Every process-boundary command carries stable operation ID, server/job, agreement version, actor and authorization, expected revision, action parameters and expiry. Receivers validate the envelope and recheck time-sensitive conditions at mutation. Reusing an ID with changed parameters is an error. Equivalent retries return proved prior evidence or reconciliation-required, rather than a new effect.

## Runtime job flow

1. A verified requester publishes a supported job; an independently controlled builder publishes an offer.
2. Both parties approve the same canonical agreement, including scope, manifests, materials cap, fixed labor allocations, ownership and deadlines.
3. The requester funds exact labor through escrow before procurement.
4. A supplier locks complete bundles; one deposit authorization issues KIT once. The requester signs an exact-output KIT purchase under a maximum CRED spend and expiry through the final hooked pool.
5. Redemption burns whole KIT and creates a fixed job-bound claim atomically. After canonical confirmations, a durable plugin delivery transfers actual materials and reconciliation releases the fulfilled obligation.
6. A leased task supplies bounded observations to 0G. Deterministic policy authorizes a proposal; the bot places actual stocked items and checkpoints observed progress.
7. Submission locks one structural revision. The checker records all cases. Failed work returns for authorized repair and a new complete inspection.
8. A valid passing revision remains protected while the requester operates approved input levers and reviews. Explicit requester acceptance enables immutable pull claims.
9. Retained reports and confirmed receipts support completion references and recovery even after discovery records expire.

Purchases, redemption and delivery are distinct. A passing test is readiness, not acceptance. Acceptance creates claimable rights; actual reward claim is a later event. Submitted, included, confirmed, applied and reconciled states remain distinguishable.

## Inventory and economic invariants

For each ingredient i, locked inventory must cover its bundle quantity multiplied by circulating KIT plus burned-but-undelivered kit-equivalent claims. Use integer token base units. Pool-held KIT already belongs to total supply; do not count it again. Fractions remain liabilities even though redemption requires whole kits.

Warehouse stock, outstanding vouchers and active pool liquidity are separate quantities. A deposit does not automatically change pool price or depth. Use a real v4 quote accounting for active ranges, ticks, fees and rounding; explanatory x*y math is not the quote engine. CRED has no assumed external peg. KIT promises specified materials, not a fixed CRED refund.

The hook reads a separately authorized, sequenced, time-bounded registry report. It gates CRED-to-KIT purchases through one configured pool. It does not query Minecraft, mint, deliver, prove backing or govern all markets. Report delay creates a measurable exposure window. Purchase-only pauses can leave LPs receiving more risky KIT through permitted sales; disclose and evaluate that asymmetry.

## Inspection and settlement boundary

Bind inspection evidence to chain, contract, server/job, agreement digest, blueprint/test versions, report digest, revision and validity. An old server signature can remain usable through direct contract calls even when the UI rejects it. The initial lock protocol must keep the structure protected while any outstanding pass is usable and during acceptance/finality. Exceptional early release needs confirmed contract-level invalidation before editing; loss of protection is an incident.

Only the bound requester accepts. Fixed allocations do not change after funding. Acceptance and refund are mutually exclusive; accepted unclaimed allocations remain the recipient's entitlement. The prototype timeout rule can leave an honest builder unpaid if the requester refuses acceptance. It provides no automatic arbitration or guaranteed earned payment.

## Recovery and trust

There is no atomic transaction spanning a blockchain, database and Minecraft world. Persist intent before dispatch, inspect target receipts after uncertainty, and advance only on authoritative evidence. A crash after item mutation but before receipt can require quarantine; an ID alone does not establish exactly-once fulfillment. Track transaction lineage and semantic claim/deposit IDs, confirmation and reorganizations. Deep reorganization after physical delivery needs the adopted loss/incident policy, not blind replay.

Separate issuer, publisher, inspection attestor and administrator roles. Keep private keys in controlled service storage and out of bot credentials, model context, public records and commits. The server operator remains trusted for custody, observations and inspection. TeeML, TeeTLS or chain receipts do not establish honest operator-supplied world facts. Public token-linked platform suitability remains a P0 gate.
