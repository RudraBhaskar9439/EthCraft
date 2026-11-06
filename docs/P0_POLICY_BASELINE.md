# Phase 0 engineering policy baseline

Status: **adopted local engineering baseline; participant approval and runtime measurements pending**.

This baseline fixes the local P0 to P2 engineering oracles under the user's implementation instruction. It is not a signed job agreement, proof of independent participants, runtime enforcement or a measured performance result. The user-approved sequencing keeps independent-human verification in P4 and token-platform/funded-chain verification in P5. Those requirements remain mandatory in their owning phases.

The authoritative policy data for this baseline is [config/p0-policy.json](../config/p0-policy.json). [Authority](../fixtures/policy/authority.json) and [transition](../fixtures/policy/transitions.json) fixtures enumerate the permitted policy surface. [The policy tests](../tests/test_policy_baseline.py) review their consistency and safety properties; production receiving-boundary enforcement must be implemented and verified separately.

## Supported scope

One server, one active protected plot/job, one requester, one paid builder and one registered bot use a single validated calculator blueprint and material bundle. The first player interface accepts one builder allocation. The contract schema supports one to eight fixed allocations so that already planned multiple-recipient contract tests remain meaningful; this does not enable a team interface or automatic contribution scoring.

The actual identities, live account sessions, signatures, deployed assets and balances are not provisioned by these fixtures. A named role or local bot identity cannot prove independent human control.

## Authority and default denial

The authority fixture declares 14 actor roles and 48 actions. Every unlisted role/action combination is denied. Public marketplace/status reads expose only intended public information; other actions require the verified named job or owned asset and receiving-side guards.

- Only the bound requester may accept a revision, fund labor or authorize a materials purchase.
- Only the issuer may issue KIT; only the publisher may publish service state; only the inspection attestor may issue passing inspection evidence.
- Builder/contributor reward claims pay their immutable accepted allocations. Neither the lead nor administrator may redirect another recipient's rights.
- Bots may execute assigned observations, navigation and bounded work. A bot/model cannot grant itself a role, issue a pass, accept work, mint, purchase without requester authority or obtain privileged service keys.
- Operator maintenance pauses, backs up and reconciles controlled infrastructure. It cannot manufacture requester consent, erase pending claims or unlock a structure carrying a usable pass through an untested shortcut.

Every mutating game command carries stable operation ID, server/job/agreement context, verified actor and authorization, expected revision, typed bounded parameters and expiry. Receivers recheck time-sensitive conditions immediately before mutation. Display names and wallet addresses in payloads are claims, not identity proof.

## Lifecycle oracle

The fixture declares 14 job states and 23 allowed transition records. Every other ordered state pair is denied. All declared transition guards and the action's permitted actor must be satisfied; a state name alone is not authority.

The main path is Draft, Open, Agreed, Funded, Procuring, DeliveryPending, Building, Inspecting, ReadyForReview, Accepted and Paid. Actual failed inspection leads to RepairRequired and authorized bounded repair. An invalid/incomplete inspection can return to Building only with explicit evidence and no usable pass or uncertain acceptance. It cannot manufacture readiness.

Before funding, the requester may withdraw Draft/Open work. An expired unfunded agreement can close only after confirming there is no funding or uncertain pending funding operation. The smallest funded contract supports acceptance or absolute-timeout refund, not early unilateral cancellation, unsupported amendments or recipient replacement.

Canonical successful acceptance permanently excludes refund. Accepted entitlements remain claimable after expiry; only actual confirmed claims can produce Paid. Paid, Cancelled and Refunded have no outgoing lifecycle transitions. Cancellation/refund does not erase separately owned materials or pending deliveries.

Reads and identical completed retries do not create new lifecycle self-transitions. A retry returns its original evidence; unknown effects reconcile; an operation ID reused with changed parameters is refused. Waiting reasons remain substates and do not skip required funding, delivery, inspection or acceptance.

## Exact clock and deadline rules

All validity intervals are half open: `authority_now < expires_at`. Equality is expired. Refund eligibility begins at `chain_timestamp >= absolute_expiry`. Chain terms use integer Unix seconds; backend identity/game expiry fields use integer Unix milliseconds. Client clocks are not authority. Monotonic time measures local elapsed waits but is not a persisted cross-process timestamp. Clock reversal or uncertain recovered authority pauses execution and requires reauthorization.

The fixed agreement start epoch and absolute deadline seconds are approved before signatures/funding. A local fixture uses:

- Work deadline: fixed approved start plus 3,600 seconds.
- Review deadline and absolute escrow expiry: work deadline plus 900 seconds.
- Pass validity: no later than that same fixed review deadline.
- Funding requires execution before the work deadline; backend receipt arrival cannot recalculate the schedule.

Construction, repair, submission and completed passing inspection must occur strictly before the work deadline. A run started earlier but completing at or after that deadline is retained as a late outcome and emits no usable pass. Failed work may be repaired and resubmitted before the fixed work deadline. Neither resubmission nor outage resets the schedule.

Requester acceptance may occur after the work deadline but only while the pass, review and absolute escrow limits are all still valid at transaction execution. A signature or submission before expiry cannot authorize a transaction mined after expiry. At exact absolute expiry, acceptance is invalid and an unaccepted timeout refund is eligible.

Identity challenges last 300 seconds and are consumed once. Quotes last 60 seconds at execution. Game commands last 10 seconds. Conflicting task leases last 30 seconds, renew at 10-second intervals and require a current fencing revision. Only one conflicting lease executes; an expired worker cannot mutate.

These durations are explicit engineering configuration. They are not claims about measured build time, network confirmation latency or guaranteed completion.

## Inspection and lock lifetime

The structural lock is durably acquired before inspection. During a run, the checker owns input controls; unrelated toggles are denied or invalidate the run. Actual lamp states determine all 16 results. Model statements and screenshots cannot substitute.

A pass binds chain/contract, application/server/job, agreement digest, blueprint/test versions, report digest, structural revision and bounded validity. The initial release has no early structural-unlock endpoint and no new repair/pass while an old pass is usable. Approved requester lever toggles remain allowed during review, but structural edits do not.

Protection remains while any pass can authorize acceptance, while acceptance is pending/uncertain and through required acceptance finality. Offchain readiness invalidation alone cannot stop someone submitting a still-valid signature directly to a contract. An exceptional early edit needs confirmed contract-recognized invalidation before unlocking.

After finalized acceptance, the requester receives declared ownership access; there is no need to hold the structure until every reward is withdrawn. For unaccepted expiration, release requires canonical evidence of no usable pass and no uncertain eligible acceptance, rather than the local clock alone. Lost/restored lock evidence disables mutation and enters quarantine.

## Ownership and fixed allocations

The requester retains unspent purchasing authorization: a spending cap is not a charge. Purchased KIT belongs to the purchase recipient. Burning it creates a fixed delivery obligation. Delivered unused stock and the commissioned structure belong to the requester under the eventual signed agreement, with limited builder/bot access for assigned work. A labor refund does not reverse the market trade, erase a claim or recreate consumed blocks.

Termination revokes builder work access and returns unused stock through an audited operation. Accepted but unclaimed labor remains the immutable recipient's entitlement indefinitely. The prototype policy offers no partial-payment or automatic arbitration mechanism; requester refusal can leave an honest builder unpaid and must be disclosed before approval.

Both proposed assets use 18 decimals. One whole KIT is `10^18` base units. Issue/redeem positive whole-KIT multiples only, while ordinary transfers may create fractions. Count all fractional supply through exact integer scaling; do not round liabilities down per holder. Pool-held KIT is already part of circulating supply and is counted once. A burned-but-undelivered whole KIT moves liability from supply to pending claims without releasing backing.

Contract allocations contain one to eight unique nonzero recipients and positive exact integer amounts, with matching lengths and a sum below `2^256`. Funding equals that sum exactly. Funded recipients and values are immutable; claims pay the immutable recipient. The one-recipient UI does not weaken multiple-allocation contract verification.

Illustrative 3 CRED materials, 6 CRED labor and 1 CRED unallocated funds remain examples, not signed purchasing authority. Initial supply candidates and fixture labels are not deployed addresses, minted balances, a CRED peg or a cash-out promise.

## Future chain finality and incident response

For the future selected chain, require at least 12 canonical confirmations and a finalized block covering the source event before irreversible delivery. No network is selected or live-finality behavior measured here. Unsupported, absent or conflicting finality evidence blocks delivery and triggers reconciliation; a latest-block guess cannot substitute.

A deeper reorganization after physical effects pauses affected issuance, purchases, delivery and acceptance preparation. Preserve every obligation and receipt, reconcile canonical chain/world observations, and route the incident to the server operator. No automatic physical replay, clawback, compensation or replacement funding is authorized. Each remediation needs explicit valid authority; fixture identities do not grant it. This is a concrete response rule, not a promise that the operator will absorb a financial loss.

## Supported workload and measurement targets

The local plot oracle uses relative bounds `[0,0,0]` to `[31,15,15]` and candidate origin `[4,1,4]`, with only identity orientation initially supported. Test translations may use negative world origins while preserving these relative bounds. During inspection/review, deny structural mutation while allowing legitimate power-state changes. Protected-region handlers must deny piston extension/retraction, block/entity explosions, ignition/burn/spread, fluids, falling blocks and entity block changes. Unvalidated administrator/plugin edit paths stay disabled for the protected plot.

The versioned fault schedule covers before intent, after intent/before mutation, after mutation/before receipt and after receipt/before acknowledgement; worker lease/interaction/checkpoint boundaries; outbox/inbox transaction boundaries; and submission, inclusion, confirmation, projection and reorganization. These are injection oracles, not a claim that crash recovery already works.

The baseline bounds one active conflicting lease, two sequential acknowledged game interactions/second, 128 placements per stage, 32 queued commands and a 65,536-byte command envelope. Proved safe retryable work has three total attempts with one- and two-second backoffs. Unknown side effects are reconciled rather than retried.

Candidate inspection timing is 40 reset ticks, 40 settle ticks and five stable observations, with 15 seconds/case and 180 seconds/run wall-clock ceilings. P1 must calibrate and freeze the actual procedure from real-world observations, including lag and burnout. A timeout is incomplete, never a fabricated zero or pass.

The supported target is normal 20 TPS, coordinated snapshots every 300 seconds, world snapshot age at most 300 seconds and reconciled recovery within 1,800 seconds. The zero-loss target concerns acknowledged obligations, not an assertion that every world mutation has been proven durable. Journals identify later effects and uncertainty remains quarantined. No network/database wait may block the game loop.

All these workload/recovery values remain targets until measured. Actual inference rate/token/currency limits are frozen from the selected P3 provider's evidence before live requests, not invented from demonstration CRED balances.

Local response targets are p95 game-command acknowledgement within 1,000 ms and backend reads within 500 ms. Mutations must stop below 1 GiB free disk; unreconciled receipts are retained rather than deleted to recover space. These targets do not assert that a backend or storage-enforcement implementation already exists.

## Verification boundary

Run only this policy suite to review these fixtures:

```sh
python3 -m unittest discover -s tests -p test_policy_baseline.py -v
```

The suite checks configuration and policy oracles: all 196 ordered state pairs, required actor/guard references, requester-only acceptance, privileged role separation, boundary semantics, one fenced lease, no early unlock, whole/fractional KIT accounting, one-person UI/eight-allocation contract bounds, ownership and fail-closed finality rules. It does not establish runtime enforcement, real accounts, participant consent, lamp observations, chain behavior, measured latency or successful recovery. Those remain required in their actual implementation phases.

Research preregistration retains failed/null/negative trials, independent users and cost/subsidy attribution. The official repositories remain in their declared runtime, reference or developer roles, with license notices and a tested compatible lock set before adoption. None of these baseline files grants a platform exemption or removes the deferred independent-human and economic prerequisites.
