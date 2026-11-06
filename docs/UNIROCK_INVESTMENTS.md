# Optional UniRock testnet investments

This extension uses Unichain Sepolia (1301), existing test CITY/mock tUSDC and the player's existing AgentCity-managed Privy game wallet. No mainnet, lending, leverage, portfolio rebalancing or agent investment permission is enabled. Investment deposits and records are separate from material purchases. Every investment needs its own native Minecraft review and confirmation.

## Current capabilities

| Feature | Route / limitation |
| --- | --- |
| New CITY/tUSDC position | Existing deployed official v4 PositionManager; official SDK liquidity/slippage math |
| Add liquidity | Same NFT, wallet ownership checked; two exact token caps |
| Withdraw | Partial fraction in the backend, full withdrawal in the menu; minimum outputs; NFT preserved |
| Collect fees | Zero-liquidity decrease and take-pair; actual collected ERC20 transfers recorded |
| Portfolio | Owned positions created here, plus `/invest position <NFT id>` for an existing position; principal, current range status and accrued fee growth |
| Investment swap | Current guarded CITY/tUSDC pool, official V4Quoter, fixed 0.5% slippage, exact output and bounded maximum input |
| Other pools | Official API V3/V4 route comparisons with token/pool allowlists; execution unavailable until a protected allowlisted route is verified |

The API advertises Unichain Sepolia SWAP/LP with V2/V3/V4, but its pool lookup returned no entry for our existing CITY/tUSDC custom hooked pool. The API currently references a different v4 deployment from this pool's existing PoolManager/PositionManager. We do not migrate old positions or send their transactions to the new addresses. Existing seed NFTs 19, 20 and marketplace NFT 21 remain intact.

No official liquidity API transaction is signed for an unindexed pool. Current CITY liquidity uses the deployed PositionManager directly. API quote responses are proposals and never become signable arbitrary calldata. The existing GEM pool is not guarded like CITY; its protections cannot be inferred from the CITY hook. No external API pool is enabled by default.

## In Minecraft

1. Join the local Java server at `127.0.0.1:25596` using the existing Micro profile. Keep the game connected, run `/join` in Discord and approve the new connection after a server restart.
2. Go to `/mumbai`. In UniRock, open the economy NPC's **Optional LP investments** button, or run `/invest`.
3. **New CITY / tUSDC Position** offers two-sided maximum deposits of 0.01, 0.1, 1 or 5 tokens and a default range of +/-600 ticks around the current tick-spacing-aligned center. Custom review: `/invest deposit 0.1 0.1`; optionally append lower and upper ticks, both multiples of 60. Maximum is 10 CITY and 10 tUSDC per operation, including slippage.
4. Read every review page. It shows the recipient wallet, maximum deposits or minimum withdrawal outputs, range and units, fee snapshot, gas ceiling, slippage and expiry. **Confirm This Investment** appears only on the final page of a funded review. **Test Funds Needed** shows the shortfall without authorizing anything.
5. Check the same operation until its canonical receipts confirm. There are multiple bounded approval and execution transactions. **Resume Latest Investment** prioritizes an unfinished consented operation over a newer unconfirmed preview; never create another deposit to recover a delayed one.
6. Open the resulting position: **Preview Add**, **Preview Collect Fees** or **Preview Withdraw All**. Each produces another independent review and confirmation. Fees can be zero. Full withdrawal preserves the empty NFT.

Existing position: `/invest position 42` (replace 42 with your NFT ID; foreign positions are refused).

Swap example, receiving exactly 1 tUSDC and spending at most 2 CITY:

```text
/invest swap 1000000 CITY tUSDC 2000000000000000000
```

Amounts in the swap and route commands are **base units**: CITY has 18 decimals; tUSDC has 6. The review displays human-readable amounts. The actual maximum is the lower effective ceiling implied by the fixed slippage and your specified maximum; the system never widens slippage.

Compare API routes without spending:

```text
/invest routes CITY tUSDC 1000000
```

Unsupported quotes and blocked pools show specific status codes. A quote is not a payment, simulated settlement or executable promise. No unprotected API fallback is used. The current custom-pool swap explicitly uses public RPC with on-chain guards; no private ordering guarantee is claimed.

The wallet needs both deposit assets and test ETH for the **displayed maximum gas reserve**. A CITY shop grant does not provide tUSDC. This feature never mints, auto-funds or automatically swaps assets to unblock an investment. Existing cumulative wallet gas reservations, including unknown previous outcomes, remain counted.

## Guards and custody

The existing immutable marketplace hook has a 300-second matured time-weighted tick reference, rejects anchors older than 600 seconds, requires sustained active liquidity, and checks deviation before and after swaps. It limits trade impact to 50 ticks, spot/reference deviation to 200 ticks, effective execution deviation to 2%, and output to 10 tokens per trade / 20 per block in each direction. Dynamic LP fees stay between 0.3% and 1%. Pause/health gates stop applicable swaps without stopping LP withdrawals. Existing deployed hook sources and pool identities are unchanged.

The local backend keeps writing real on-chain checkpoints while the enrolled investment feature is enabled. A single lease prevents overlap with a manual warm-up. It runs every 30 seconds after the previous result, resumes the same retained checkpoint after an uncertain reply, and stops on gas-budget exhaustion, changed deployment bindings or expired investment enrollment. It never resets the existing shared publisher gas allowance. Status is private in `.local/investments/observation-keeper.json`. After a long offline period, allow at least five minutes of genuine observations before making a fresh review; `INVEST_REFERENCE_NOT_READY` remains a blocking error until the hook itself reports readiness. A twelve-sample manual warm-up alone does not keep the reference fresh indefinitely.

Same-pool averaging is **not an independent fair-value oracle**. A sustained manipulation, adverse selection or a smaller sandwich can still fit within limits. Slippage caps bound execution loss; they do not eliminate MEV, impermanent loss or LVR. Dynamic fees do not guarantee profitability or protect principal. There is no zero-LVR or guaranteed-yield claim.

The separate investment delegate uses a pinned 24-hour Privy policy for the enrolled Micro wallet. The original wallet address, owner quorum and shop delegate/policy remain unchanged. Other wallets are not silently opted in. No runtime loads the offline owner private key. The investment runtime signs only immutable, internally constructed calls after native consent; models and automatic shop delegation cannot enter this path.

The Privy policy restricts chain, value, contracts, ERC20 spenders/caps, Permit2 token/spender/caps/expiry, and method deadlines. Nested v4 action/recipient validation is enforced by the receiving service's own builder and immutable operation terms, rather than claiming Privy can independently decode every inner bytes payload. PositionManager enforces ownership, exact liquidity, input maxima/output minima and expiry on-chain. Never approve unlimited token/NFT allowances.

All investment transactions reuse the existing managed-wallet request, nonce, signed-byte and cumulative gas journals. On an uncertain signature or send, retry the same operation; do not reset budgets or discard retained requests. Canonical receipts are rechecked, including after an earlier success. Reorganizations stop advancement. Expired unsigned stages require fresh reviewed terms; original prepared requests remain recoverable.

## Setup and verification

Private configuration remains ignored under `.local/investments/`: API key, separate contract pins, Privy delegation and setup progress. Existing marketplace manifests and wallet transaction records are not replaced. No secret belongs in this document or a commit.

```sh
node scripts/investments_preflight.mjs       # read-only chain/API support and contract relationship checks
node scripts/investments_privy_setup.mjs    # read-only owner-wallet/delegate preflight
node scripts/investments_observe.mjs --warm # twelve real checkpoints, 5.5 minutes, existing capped publisher test gas
node tests/bank/pool-observation-keeper.mjs
node tests/investments/v4.mjs
node tests/investments/service.mjs
node tests/investments/privy.mjs
cd contracts && forge test --match-contract MarketplaceInvestmentsTest -vv
```

`investments_privy_setup.mjs --apply` is an explicit operator maintenance command. It preserves the shop policy, enrolls only the existing Micro wallet, and refuses unresolved signed requests before attaching the separate delegate. It does not confer investment consent or send blockchain transactions. Do not casually rerun old one-delegate migration scripts after this enrollment. Policy expiry requires reviewed maintenance; it is not silently extended by an agent.

Native UI tests use `scripts/investments_native_fixture.py start`, `node tests/investments/native.mjs`, then `scripts/investments_native_fixture.py stop`. They use a separate owned server copy and synthetic backend replies. They do not exercise a real Privy payment. The complete existing Mumbai native qualification also runs before a live plugin upgrade.

Actually verified: official SDK math and encoded recipients/caps; isolated PostgreSQL consent, immutability, signing-reply-loss/restart recovery, canonicality and session checks; official PositionManager deposit/add/fee/withdraw lifecycle in Foundry with a disclosed Permit2 allowance fixture; stale history, thin liquidity, price/volume limits, fee bounds, unauthorized spending, oversized sandwich front-leg rejection and withdrawal during pause; real isolated Paper/Mineflayer menus and continued shop operation; real testnet code/pool/position reads; real Privy policy/delegate readback without wallet signing.

Not established by those tests: an independently operated human investment, a new testnet Privy LP deposit/withdrawal lifecycle, full sandwich immunity, independent price correctness, or protected multi-pool API execution. Those must not be presented as passed. API execution remains blocked until each route's support and protection are verified. No original project phase is certified by these component checks.

The pinned official SDK currently brings transitive npm audit advisories, including high-severity findings. Their presence is recorded in the local audit report; no force-upgrade or claim of a production security audit was made. This local test-token extension is not qualified for real funds.

Official references: [Liquidity API integration](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide), [supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains), [v4 SDK](https://github.com/Uniswap/sdks/tree/main/sdks/v4-sdk), [v4 core StateLibrary](https://github.com/Uniswap/v4-core/blob/v1.0.2/src/libraries/StateLibrary.sol). Existing upstream licenses and notices remain intact.
