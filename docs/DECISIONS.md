# Decisions before implementation

P0 resolves local technical scope, authority and compatibility before dependent local implementation. Integration decisions remain mandatory before the integrations that need them. Record each adopted choice with date, owner, rationale, exact rule/version and redacted evidence in the P0 execution record. An undecided safety rule cannot be replaced by a hidden default.

| Decision | Proposed starting point | Required evidence and blocking phase |
| --- | --- | --- |
| Platform suitability | Calculator-first Minecraft prototype; integrated token mechanics require review | Current applicable rules and explicit intended scope; private/testnet is no automatic exemption. Resolve before the integrated path proceeds. |
| Game compatibility | A disclosed historical isolated fixture for local P0; maintained production adoption remains unproved | The real local 1.21.11/Paper132/Mineflayer4.39.0 smoke passes, but Paper marks that version unsupported. Keep it loopback-only and non-token. A maintained release/runtime choice must be reviewed before production adoption; latest upstream branches are not assumed compatible. |
| Blueprint and timing | One candidate fixed calculator | P0 reviews completeness; P1 measures and freezes material bill, coordinate/orientation manifest, reset and settling procedure. No KIT before validated bill. |
| Persistence | PostgreSQL 17 adopted for the local backend | Atomic workflow intents, outbox receipts, one-use challenges and fixed funded terms are tested locally. Production backup/restore and operating measurements remain pending. |
| 0G access | Router first | Actual environment, funded Router credentials, selected model/provider, capability benchmark and trust policy. Adopt Direct only for a concrete need; separate accounts and billing. |
| Settlement environment | One verified v4-supported test environment | Actual PoolManager, router, registry/hook and later asset bytecode/addresses; RPC/gas and liquidity access. No assumed Sepolia deployment or balances. |
| Asset definitions | Demonstration CRED and one immutable KIT promise | Decimals/base units, issuance roles, whole-unit scaling, fractional treatment, server/world/destination terms and distribution/subsidy disclosure. Addresses verified after P5 deployment. |
| Market setup | Disclosed initial price and active ranges | Supported exact-output route, seeded amounts, actual quote tests, cost/price-impact/cap boundaries. No promised price peg or organic liquidity. |
| Report freshness | Bounded validity and increasing sequence | Predeclare tolerated delay, pilot detection/publication latency and cost; select TTL/heartbeat from measurements and test false pauses. |
| Deadlines | Explicit half-open validity proposed | Define nonce, lease, quote, work, review, pass and absolute escrow expiry, including equality, late work and resubmission. No overlap allowing both acceptance and refund. |
| Signature and lock lifecycle | Domain-bound canonical terms and pass | Adopt encoding, signers, validity, revocation/rotation and pending acceptance/finality protection. Direct-contract tests must reject invalid or expired evidence. |
| Ownership and cancellation | Requester owns purchased goods; immutable labor allocations | Adopt every resource class, timeout/refund and any supported funded cancellation. Preserve undelivered claims and late accepted rewards; disclose refusal risk. |
| Identity recovery | One-time live-game challenge | UUID/session and wallet/domain binding, nonce consumption, relinking/recovery; no account edit changes already funded recipients. |
| Finality and loss | Declared canonical confirmation threshold | N-1/N/N+1 tests, conflicting RPC views and deep-reorganization incident/loss response after physical effects. |
| Operating limits | Single plot/job supported initially | Numeric queue/payload/action limits, tick/response targets, backup recovery time and tolerable data loss; measured before acceptance. |
| Upstream adoption | Official sources and minimal supporting libraries | License/notice review, exact compatible installed release set and package integrity; reviewed HEAD is not an implementation lock. |
| Research protocol | E1 to E8 comparisons | Freeze conditions, held-out cases, metrics, pilot-informed sample procedure, privacy/consent and interpretation before favorable results. Null/negative outcomes remain valid. |

Do not add team UI, arbitrary-build promises, dynamic fee logic, new material assets or a public real-value economy while these initial decisions remain unresolved. Feature changes require their own scope, cases and reopened dependencies.

## User approved gate ownership

Local technical Phases 0 to 2 may proceed first. P4-029 verifies real independent participants. P5-024 resolves actual token-linked platform suitability, and P5-025 verifies real selected-chain access, roles, gas and liquidity funding. These checks remain blocked until evidence exists. An offline loopback fixture proves neither account ownership nor a public/private token exemption. The [local engineering baseline](P0_POLICY_BASELINE.md) fixes implementation targets and boundary oracles; actual participant consent, deployments and later measured performance remain separate.
