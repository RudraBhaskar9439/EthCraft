# Historical bank extension

The user superseded this product scope on November 5. Lending, borrowing,
auctions and borrower-based swap fees are excluded from the active marketplace.
Keep this document, its contracts and evidence for deployment history. Use
[the current marketplace runbook](TESTNET_MARKETPLACE.md) for active operation.

# AgentCity laptop testnet bank

The user approved this extension on 5 November 2026 and selected this laptop as
the host. The implementation uses Unichain Sepolia (1301) and explicitly
identified local fixtures. It cannot spend mainnet funds. Mock USDC is a capped,
six-decimal test token called `AgentCity Mock USDC` (`tUSDC`), not Circle USDC or
a promise of dollars. CITY and GEM in this new namespace are separate from the
existing remote market; old ownership, balances and journals remain unchanged.

## Agreed implementation policy

| Area | Policy |
| --- | --- |
| Payment routes | CITY, tUSDC and GEM on one chain; a dynamic CITY/tUSDC pool and a plain GEM/tUSDC pool. Exact-output routes enforce a maximum input and a quote deadline of at most 120 seconds. |
| Checkout | One exact registered item, accepted seller/listing nonce/price/asset revision. Swap, CITY payment and final NFT transfer execute together. Actual Minecraft redemption remains a separate durable operation. |
| First collateral | An exactly recorded deposited equipment NFT. Native custody removes the original item from usable inventory. Gold and diamond resource lots require qualification before use. |
| Lender funding | An identified lender reserves actual tUSDC for each offer before a borrower can accept it. No use of LP reserves or other borrowers' collateral. |
| Loan limit | At most 30 tUSDC, at most 30 percent of the lender's disclosed reference valuation, and one active loan per borrower wallet. A reference valuation is not an oracle or liquidation guarantee. |
| Charge | Immutable repayment amount, capped at principal plus 1 percent. Normal offers use a 24-hour term, one-hour grace and one-hour auction; short test offers are explicitly labelled. |
| Deadlines | Test-only contracts allow terms, grace and auctions from 60 seconds within their maximum bounds. Repayment is allowed during grace and before an active auction's end, with bidder refunds and late/default history retained. |
| Default | A funded auction bid supplies cash recovery. Prior bids and proceeds use pull withdrawals. Return surplus to the borrower. Contract `badDebt` is unpaid contractual repayment including the fee; report unrecovered principal separately. An unsold foreclosure returns a claim to the lender and records unpaid debt without inventing cash recovery. |
| Collateral release | Debt settlement and NFT claim are separate so a rejecting receiver cannot block payment. No arbitrary approval, redemption or rescue passthrough exists in the vault. |
| Reputation | Only bank-recorded outcomes. A discount requires two qualifying timely loans, each at least 1 tUSDC and outstanding at least 60 seconds, with no defaults. This can still be farmed and is not a real credit score. |
| Swap fees | Base 0.30 percent and qualifying discount 0.25 percent. These are LP fees, separate from loan charges. The hook authenticates the immutable router's original caller; the official quoter has an explicit simulation-only hint path. |
| Market health | A separate publisher reports short-lived native health. The hook trusts that publisher; it does not independently inspect inventory. An expired/unhealthy report pauses buying CITY. Authenticated CITY-to-USDC exits remain available so a world outage does not prevent obtaining repayment funds. |
| Work | Immutable accepted quote, fixed CITY funding, inspector-confirmed actual execution, and requester acceptance. A timely completion preserves its disclosed review window before refund eligibility. |
| Authority | Models propose. The accepted payer confirms financial terms. Registrar, issuer, publisher, inspector, lender and LP authorities remain separate. |

## Laptop operator scope

The local interface is an operator-controlled test environment with explicitly
labelled developer wallets. It binds to loopback, checks the exact origin/Host,
uses a private session capability and limits each signing target and operation.
It is not a public banking login or proof of multiple independently controlled
people. Never port-forward it as a shared player application.

Fresh native controlled actors and the preserved source world are recorded under
`.local/playable-world`. New bank manifests, private settings and durable
deployment progress belong under `.local/bank`. Secrets stay outside Git.
Native namespace, chain genesis, deployed code and operation identities must be
verified before replaying an operation. Never reset a live chain to retry.

## Verification and release limits

Verify exact balances and physical item fingerprints, owner/terms refusal,
collateral use/redemption locks, maximum input, stale listing rollback, one-time
settlement, outbid refunds, surplus/shortfall, authenticated fee selection and
restart recovery. Use focused tests, not a deep edge-case sweep. Retain failures
and distinguish official-contract local tests, public testnet results, actual
native receipts and independent-human acceptance.

The original canonical phase gates remain unchanged. Missing 0G, platform
permission and independent-human evidence do not become passed through this
extension. Minecraft real-value restrictions remain a public-launch constraint.
New Discord and Privy live activation needs their actual configuration; a local
operator signing adapter must never be described as Privy user approval.
