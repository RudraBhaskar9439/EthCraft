# Local P5–P8 contracts

This is an isolated synthetic-inventory demonstration on chain **31337**. It uses real EVM transactions and the official Uniswap v4 PoolManager, not a constant-product simulator. It does not deploy to a public network, spend real funds, establish physical custody, connect tokens to Minecraft, or pass the pending live integration gates.

## Run

```sh
cd contracts
npm ci --ignore-scripts --no-audit --no-fund
forge test -vv
```

Dependencies are exact npm versions with integrity locks: OpenZeppelin Contracts **5.4.0**, Uniswap v4-core **1.0.2**, and v4-periphery **1.0.3**. Foundry **1.7.1**, Solidity **0.8.26**, and Cancun EVM are used. Preserve upstream per-file licenses: OpenZeppelin and the imported periphery helpers are MIT; v4-core has BUSL-1.1/MIT components; official core test routers are local fixtures, including files marked UNLICENSED. No blanket project license overrides them.

The current loopback deployment is recorded in [local-deployment.json](local-deployment.json). It contains public local fixture addresses and unlocked Anvil accounts, never a user wallet or API key. Keep that node local. To recreate it, start a fresh `anvil --host 127.0.0.1 --port 8547 --chain-id 31337 --silent`, assign the first seven distinct returned `eth_accounts` to `LOCAL_ADMIN`, `LOCAL_WAREHOUSE`, `LOCAL_PUBLISHER`, `LOCAL_ATTESTOR`, `LOCAL_REQUESTER`, `LOCAL_BUILDER`, and `LOCAL_ISSUER`, then run:

```sh
forge script script/LocalDeploy.s.sol:LocalDeploy --rpc-url http://127.0.0.1:8547 --unlocked --broadcast --slow --sender "$LOCAL_ADMIN"
```

The script refuses other chain IDs and duplicate roles. `contracts/abi/*.json` exposes the concrete integration ABIs. Current role-separated deployment receipts and source hashes are retained under `evidence/runs/local-p5-p8-v2/`; the active pointer names its `verificationFile`. The original deployment and its proofs remain under `evidence/runs/local-p5-p8/` and its contracts remain deployed on the same chain. The read-only `scripts/local_verify_contract_deployment.mjs` verifies a freshly seeded deployment before any demo burns KIT; it writes new evidence rather than replacing existing proof.

## Explicit local defaults

- Bill order: stone bricks **65**, lever **4**, repeater **16**, redstone torch **37**, redstone **19**, redstone lamp **3**. The fixed contract bill and bundle hash cannot change.
- CRED and KIT have **18 decimals**. Every `kits` argument to issuance, redemption and procurement is a **positive whole integer**, not ERC20 base units. Transfers may split KIT fractions; total supply, including pool balances, remains a single counted liability.
- Local seed: 1,000 synthetic backed KIT; 10,000 CRED for the admin and 1,000 CRED for the requester. These are fixture subsidies, not prices or market demand.
- Official v4 pool: initial square-root price `2^96`, static fee **3,000** (0.3%), tick spacing **60**, active range **[-600,600]**, liquidity **100e18**. Exact-output price and fees come from v4 execution.
- Registry TTL is at most **300 seconds**, using chain time. Missing, stale or unhealthy state blocks **both swap directions**. Ordinary LP withdrawal remains available because the hook implements only `beforeSwap`.
- Purchase quotes expire at equality and last at most **60 seconds**. `maxCred` is a per-transaction base-unit spending cap; the application must also enforce its signed agreement's aggregate material budget. Procurement can debit only its caller, and cannot reach labor escrow.
- Work, review and pass deadlines are fixed approved integer seconds. The local agreement example uses work +3,600 seconds and review/pass/absolute expiry +4,500 seconds. Funding requires `now < workDeadline`; acceptance requires an unexpired valid report; unaccepted refund begins at `now >= absoluteExpiry`.

## Authority and accounting

`CreditToken` has an immutable issuer distinct from its administrator. Only the issuer can mint; the administrator cannot transfer ownership to that issuer. Public local account 6 issues CRED and KIT, separate from administrator 0, warehouse 1, publisher 2 and inspection attestor 3. `KitCustody` has separate immutable issuer and warehouse roles. The issuer supplies a unique deposit receipt and exact six-item bundle quantities; reusing a receipt cannot issue again. This synthetic counter is an issuer attestation, not proof that physical items exist.

Redeeming burns whole KIT and atomically creates a recipient/job/destination-bound pending claim. Burning does **not** release stock: each item's controlled quantity still covers circulating supply plus burned-undelivered obligations. Only the warehouse may mark a claim delivered with a unique delivery receipt, reducing pending obligation and controlled stock together. `claims(claimId)` returns `(jobId, recipient, destinationHash, kits, delivered)`. Read `ClaimCreated` for the canonical claim ID; use immutable `bundleHash()` as its manifest identifier.

`AgentCityHook` inherits official `BaseHook`, validates the actual PoolManager caller and exact pool key, and is deployed using CREATE2 to an address with the correct beforeSwap-only permission bits. `Procurement` inherits official periphery `SafeCallback`, executes an actual v4 exact-output swap, enforces the CRED cap, then burns the received KIT into its claim in the **same transaction**. A failed claim rolls back the swap and payment.

`JobEscrow` requires exact EIP-712 approvals from requester and builder before exact allocation funding. It binds chain/contract, job/server, assets, immutable allocation hash, blueprint/tests/access/scope hashes and deadlines. Only requester may accept a valid separately signed attestor report. The local attestation and lock are synthetic fixtures; signatures do not prove Minecraft observations or lock correctness. Attestor-only report invalidation also blocks direct contract submission of invalidated evidence.

Accepted fixed allocations use recipient-only pull claims and remain claimable after expiry. Unaccepted timeout refunds and acceptance are mutually exclusive. Requester refusal can leave the builder unpaid; there is no automatic arbitration, partial payment or funded early cancellation.

## Verification and limits

The focused Forge suite uses actual v4 initialization, CREATE2 hook deployment, official liquidity/swap utilities, exact-output purchase, atomic claim creation, symmetric halts, and LP withdrawal while halted. It also checks issuer/publisher/requester authority, receipt replay, partial-stock refusal, pending backing, exact signatures, invalidated/failed report rejection, immutable pull claims and exact-time refund exclusivity.

This is not a contract audit or an exhaustive adversarial suite. There is no fee-on-transfer token support, permissionless issuer, governance token, dynamic fee, bridge, real-value settlement or live-finality proof. Public deployment, genuine independent users, service credentials, actual backing and Minecraft platform suitability remain separate gates.
