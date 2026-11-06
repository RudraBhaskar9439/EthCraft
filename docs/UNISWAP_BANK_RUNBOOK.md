# Laptop testnet bank

**Historical route:** the user removed lending and borrowing. Do not start this
older interface for the current product. Use [the marketplace runbook](TESTNET_MARKETPLACE.md).
The commands and results below document the preserved earlier deployment.

This is the November 5 laptop deployment of the AgentCity bank. It uses actual
Unichain Sepolia contracts and the local Minecraft world. All demonstration
wallets and players are controlled test actors. tUSDC is a six-decimal mock;
it is not Circle USDC, dollar-backed money or a promise of redemption.

See [the adopted bounds and trust model](TESTNET_BANK.md),
[the public deployment manifest](../contracts/bank-public-testnet-deployment.json)
and [the verification checkpoint](../evidence/TESTNET_BANK_CHECKPOINT.json).
Earlier phase evidence and deployments remain separate.

## Start on this laptop

Run from the `agentcity-minecraft` checkout. Keep Docker Desktop running.
The existing private `.local` configuration, encrypted wallet files and database
must be retained. The public manifest alone cannot recover a signer or the world.

```sh
python3 scripts/laptop_host.py start
python3 scripts/laptop_host.py actors
node scripts/bank_server.mjs
```

Open <http://127.0.0.1:8794/> yourself. The Minecraft address is
`127.0.0.1:25596`, version 1.21.11. The three controlled clients are started by
`actors`; do not also log in with their names. Native control on port 25597 and
PostgreSQL on port 55432 are private loopback services.

The operator page can select and authorize every configured developer wallet.
It is deliberately a local demonstration, not a public player login. Do not
expose port 8794 through a tunnel, public bind or reverse proxy. Discord/Privy
player activation requires its own real configuration and owner verification.

## Use the demonstration

1. Select the borrower, seller, bidder, lender or worker test wallet. Refresh
   balances and inspect existing activity before initiating another operation.
2. Refresh verified world health before buying CITY. Reports expire after five
   minutes. CITY-to-tUSDC exits and direct debt repayment remain possible during
   a world-health pause.
3. Exchange only CITY, GEM and tUSDC. Choose the exact output and maximum input.
   Review the quote, expiry and gas cap; then confirm. A route may use two pools
   through tUSDC. There is no arbitrary-token or cross-chain conversion.
4. Deposit the exact equipment held by an approved player. This removes it from
   usable inventory. List it for CITY, or cancel its listing before redemption.
   A buyer can pay with GEM or tUSDC: conversion, seller payment and final NFT
   ownership settle atomically. Physical delivery is a separate durable step.
5. As the lender, reserve an offer against the borrower's exact deposited item.
   The lender supplies tUSDC upfront. As the borrower, review total repayment,
   duration, grace and auction terms before accepting. The contract holds the
   item NFT until repayment or default resolution permits a separate claim.
6. Repay before the deadline to record a timely result. Two qualifying loans
   outstanding at least 60 seconds earn a 0.25% CITY-pool fee instead of 0.30%,
   provided there are no defaults. This is wallet history, not a human credit
   score. Related-party fixtures do not prove creditworthiness.
7. After term plus grace, start the funded default auction. Bids escrow actual
   tUSDC. Settle after the auction ends; outbid refunds and lender proceeds use
   the withdrawal action. The winner claims and redeems the original equipment.
   An auction can leave a loss. Unpaid contractual debt includes the fee;
   unrecovered principal is reported separately. Use the three-minute test
   auction or normal one-hour auction when demonstrating multiple bidders.
8. Fund the supported 2-by-2 oak platform for the approved worker. Run the funded
   task, inspect the actual result, then explicitly accept payment release.
   The worker consumes four real oak planks. The protected work area stays
   locked until canonical payment or an eligible refund is settled. This path
   does not call an AI model or support arbitrary work plans. A new quote checks
   the approved player's usable connection, the empty supported footprint and
   available oak stock before funding. The demonstration uses one registered
   origin; an occupied origin cannot be quoted again.

Each financial action requires a preview and a separate confirmation of those
exact terms. Gas is additional test ETH. An AI proposal cannot authorize funds.
Lender capital, LP liquidity and work escrow are different balances.

## Reconcile instead of repeating

If a request times out, use **Review retained operation** and reconcile its
original identifier. Restarting the process does not cancel a signed transaction.
Do not prepare another loan, purchase, redemption or work task to repair a lost
reply. Expired quotes require a new preview only after the old operation is
reconciled. Pending physical delivery retains the original protected mailbox.
Pending work resumes its original task and receipts rather than building twice.

Stop the bank process with Control-C. Stop the owned world gracefully with:

```sh
python3 scripts/laptop_host.py stop
```

Restart using the original commands and original private configuration. The
launcher checks its container labels, ports, mount and plugin hash. A mismatch
requires investigation; do not delete `.local`, reset a chain, regenerate actors
or copy another world's custody journal to make it start.

Preserve the database, native world and custody journals, wallet encryption
material, `.local/bank`, and `.local/playable-world` together. The source-world
backup is recorded in `active.json`; it predates this bank's transactions and
cannot alone restore the bank. Automated full-host restore qualification remains
pending. Never roll a live chain back to match an old local backup.

## Verification and limits

The checkpoint distinguishes contract tests, PostgreSQL/local-chain integration,
actual public testnet transactions, native inventory and work receipts, and
controlled transport fixtures. Failed attempts remain recorded.

The optional Discord command transport and Privy policy templates are tested
without contacting Discord or applying a live Privy policy. They are not an
activated player rollout on this Mac. Independent human acceptance, public
platform permission, 0G inference and production release qualification remain
pending. Automated browser verification of port 8794 was denied, so visual
browser checks remain unperformed. No alternative browser route was used.
