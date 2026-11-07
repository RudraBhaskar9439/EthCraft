# Building EthCraft with Uniswap

This is our engineering retrospective, based on the implementation and retained tests in this repository. AI assisted the research, code, tests and documentation. It is not an independent security review or a claim that every player flow has received human acceptance.

## What we used Uniswap for

EthCraft is a Minecraft city with an in-game marketplace called UniRock. We use a Uniswap v4 CITY/mock-tUSDC pool on Unichain Sepolia so players can exchange test tokens for the CITY used by the marketplace. Our router supports bounded exact-output swaps and atomic swap-and-equipment checkout. A physical item is delivered only after a canonical payment receipt; interrupted delivery resumes from its original mailbox.

We also built an optional LP interface inside Minecraft. Players review token maxima, range, gas and expiry before using their existing Privy-managed game wallet to create or increase a PositionManager NFT, collect fees, or withdraw. Investment consent is separate from agent material-shopping permission. These investments are optional and do not promise yield.

We reused official PoolManager, PositionManager, V4Quoter, Permit2 and the v4 SDK. Our own contributions are the marketplace hook, bounded application router, native consent interface and transaction/delivery recovery. The [README](README.md#deployed-contracts-unichain-sepolia) distinguishes our contracts from reused Uniswap components and lists every active address.

## What worked well

**Hooks fit the application.** Pool-level checks let us express bounded execution, a sustained-liquidity requirement, market-health gating and dynamic fees where real swaps occur. UI validation alone could not provide that guarantee. LP withdrawal remains available during a swap pause.

**Exact output matches a purchase.** A player needs a known CITY amount, while a maximum tUSDC input makes the spending ceiling explicit. The atomic equipment-checkout path composes conversion and ownership transfer in one transaction. We still reconcile native delivery separately instead of claiming the chain proves a block or item reached a player.

**Official position NFTs make LP ownership concrete.** We can display a real token ID, range, liquidity and accrued fee growth. Official SDK math avoids writing an unrelated AMM simulator. The isolated lifecycle test exercises mint, increase, fee generation/collection and exit through the actual PositionManager implementation.

**Official core/periphery are reproducible test dependencies.** Pinned versions and Foundry made it practical to test hook callbacks, execution failures and withdrawal during a pause against real v4 code rather than a mock constant-product pool.

## Friction and lessons

1. **v4 pool state is not a historical oracle.** We implemented a bounded observation ring that accrues actual pool ticks across elapsed chain time. Callers can checkpoint genuine PoolManager state; they cannot submit arbitrary prices. Our anchor is 300–600 seconds old, not an exact five-minute arithmetic average. Negative mean ticks require floor rounding, and same-block activity cannot manufacture elapsed history.
2. **Price history is an operational dependency.** A short manual warm-up did not keep an idle pool ready indefinitely. The backend now maintains genuine checkpoints through the existing durable publisher and finite gas allowance. Stale prices still fail closed. World-health freshness is a separate check; a fresh price does not imply a healthy game server.
3. **Hooks are immutable pool identity.** Callback permissions are encoded in the hook address, and the hook is part of the PoolKey. Adding protections required a new hook and pool. We preserved earlier LP NFTs and receipts instead of silently migrating assets.
4. **Token decimals and ordering matter throughout.** CITY has 18 decimals, mock tUSDC has 6, and the pool sorts addresses. Raw square-root price is not a human-readable dollar price. Our execution checks use TickMath/FullMath, and the UI states token amounts explicitly.
5. **Quoting must use the same execution constraints.** V4Quoter's extreme square-root-price limits cannot be confused with an executed bad price. We authenticate supported callers and check actual post-swap price, impact and fee-inclusive execution. Quoter simulation reverts its effects; confirmed swaps persist the counters and observations.
6. **API chain support is not custom-pool support.** The official API advertises Unichain Sepolia, but our pinned custom pool was not indexed and CITY/tUSDC route quotes returned no route. Its advertised deployment also differs from our existing one. We use the existing PositionManager directly for LPs, and keep unsupported multi-pool execution disabled. An API response is never a blanket authorization to sign calldata.
7. **Recoverable UX matters as much as a quote.** Approval stages could outlive an unsigned quote. We now omit unnecessary approvals, refresh expired unsigned terms with new consent, and poll the same confirmed operation automatically. Unknown signed transactions retain their exact ID, nonce and bytes; retries do not create another payment. PostgreSQL JSON key order also required semantic comparison of deployment pins.
8. **Packaging has practical details.** The pinned SDK is loaded through Node's `createRequire` because its ESM packaging uses extensionless directory imports. This is documented reuse of the official SDK, not a replacement implementation.

## Protection claims we can support

The hook enforces matured/stale-reference checks, sustained minimum liquidity, pre/post deviation limits, 50-tick impact bounds, per-trade/per-block output limits, bounded 0.30%–1.00% fees and swap circuit breakers. Tests include a large sandwich front-leg rejected by the impact bound and withdrawal during a pause.

These checks do not supply independent fair value, eliminate smaller sandwiches or sustained manipulation, prevent every MEV strategy, remove impermanent loss or guarantee zero LVR. Same-pool averaging can itself follow manipulated conditions. Fees and slippage bounds reduce specific risks; they do not insure LP principal.

## What we verified, and what remains

- Real Unichain Sepolia deployment, controlled CITY purchase, atomic equipment checkout, native collection and same-operation replay: [marketplace evidence](evidence/MARKETPLACE_CHECKPOINT.json).
- Official PositionManager deposit/increase/fee/withdraw lifecycle and hook attacks: [isolated EVM verification](evidence/runs/investments/00d2c901-8bd4-46d7-a3df-ba2057872c41/verification.json), with a disclosed Permit2 fixture.
- Owner/session consent, unknown-signature recovery and immutable terms: [backend checks](tests/investments/service.mjs). Native expiry/progress fixes and live read-only quotes: [latest report](evidence/runs/investment-review-lifecycle/6c7dd9bb-928a-4e36-a6aa-37facfdc7b60/report.json).
- Still pending: a newly confirmed player Privy LP lifecycle on testnet, protected multi-pool execution and independent-human acceptance. These are not passed by funding wallets or by isolated fixtures. The project is not audited or qualified for real funds.

## Feedback for the Uniswap developer experience

A hook-aware support matrix would help distinguish chain availability, deployment version, custom-hook quote support and executable liquidity routes. More end-to-end examples for custom-hook exact-output quoting, PositionManager/Permit2 calldata and observation freshness would shorten integration work. A documented public-RPC/protected-submission capability matrix would also help developers avoid treating slippage limits as private ordering.

The strongest part of v4 for this project is composability: a real AMM, application-specific execution policy and position NFTs can be combined without inventing an exchange. The hard part is proving the complete path from exact consent to chain execution and native delivery. Keeping those boundaries explicit made the integration more credible and easier to recover.

This feedback is stored for review in this repository; it has not been submitted to an external form.
