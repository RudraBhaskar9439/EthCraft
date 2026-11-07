# Uniswap judge and AI review guide

This guide reviews the current CITY/mock-tUSDC implementation without access to a user's wallet, private keys, API credentials or saved game. Start at [README](../README.md), then read [AGENTS.md](../AGENTS.md). Use the committed sources and evidence as facts to check, not as proof of unrecorded results.

## 1. Run the isolated core checks

Prerequisites: Node 26.3.1+, npm, Python 3, Foundry 1.7.1 and the compiler configured in `contracts/foundry.toml` (Solidity 0.8.26, Cancun). From a fresh clone:

```sh
npm ci --prefix backend --ignore-scripts --no-audit --no-fund
npm ci --prefix contracts --ignore-scripts --no-audit --no-fund
node tests/investments/v4.mjs
node tests/investments/swaps.mjs
node tests/investments/privy.mjs
forge test --root contracts --match-contract '^MarketplaceInvestmentsTest$' -vv
```

No private configuration is required. Node tests inject fixtures; Forge uses a local isolated EVM with official v4 contracts. No Minecraft process, PostgreSQL service, inference request or public transaction is started. Dependency installation needs the package registry, and Forge may download the pinned compiler on its first run. `--no-audit` suppresses an installation-time network check; it does not mean dependencies are audited or advisory-free.

`MarketplaceInvestmentsTest` inherits the nine hook cases and adds three position/attack cases. Inspect [the test](../tests/contracts/MarketplaceInvestments.t.sol) and [its hook base](../tests/contracts/AgentCityMarketplaceHook.t.sol). A local pass establishes those bounded fixture results, not complete MEV protection or a testnet human LP lifecycle.

For the repository-wide planning/host-safety unit checks, also run:

```sh
npm ci --prefix tests/compatibility --ignore-scripts --no-audit --no-fund
python3 -m unittest discover -s tests -v
python3 scripts/check_plan.py
```

The compatibility graph supplies the NBT parser used by a temporary-file UUID test. This installation does not start Minecraft. CI uses the same prerequisite.

## 2. Inspect the deployed implementation without signing

Use the [public manifest](../config/marketplace-public-deployment.json) and [README address tables](../README.md#deployed-contracts-unichain-sepolia). These reads use the public Unichain Sepolia RPC and require no API key:

```sh
cast chain-id --rpc-url https://sepolia.unichain.org
cast call 0x6faf5918c8fd0af9716d300ce8f7e9310cc11fc0 'poolManager()(address)' --rpc-url https://sepolia.unichain.org
cast call 0x12a98709bb5d0641d61458f85dcafbe17ac2d05c 'poolManager()(address)' --rpc-url https://sepolia.unichain.org
cast call 0x12a98709bb5d0641d61458f85dcafbe17ac2d05c 'permit2()(address)' --rpc-url https://sepolia.unichain.org
cast call 0x6faf5918c8fd0af9716d300ce8f7e9310cc11fc0 'marketReference()(bool,int24,uint64,uint64)' --rpc-url https://sepolia.unichain.org
cast call 0x12a98709bb5d0641d61458f85dcafbe17ac2d05c 'ownerOf(uint256)(address)' 21 --rpc-url https://sepolia.unichain.org
```

Expected fixed bindings: chain **1301**, both manager reads return `0x9cb26a7183b2f4515945dc52cb4195b0d2d06c95`, and Permit2 is `0x000000000022d473030f116ddee9f6b43ac78ba3`. Position 21 is retained seed liquidity; inspect its current owner instead of assuming it belongs to a player. Reference readiness and ownership are live observations, not fixed expected outputs. A false/stale reference while the publisher is offline is a blocking state, not permission to bypass it.

For bytecode validation, read code at a recorded block with `cast code ADDRESS --block BLOCK --rpc-url https://sepolia.unichain.org`, hash the returned bytes with `cast keccak BYTECODE`, and compare the corresponding `codeHashes` entry. Verify chain/genesis and recheck that block's hash when making a reproducible report. No live result in this guide authorizes `cast send`, funding or state mutation.

## 3. Trace the contribution in source

| Question | Entry points |
| --- | --- |
| How is a custom hook bound to the actual pool? | [Hook constructor, permissions, observation and swap callbacks](../contracts/src/AgentCityMarketplaceHook.sol) |
| How are maximum spend and exact output enforced? | [Payment router](../contracts/src/BankPaymentRouter.sol), [guarded swap builder](../backend/src/investments/swaps.mjs) |
| Where are LP actions encoded and fees computed? | [Official-SDK builder and state reads](../backend/src/investments/v4.mjs) |
| What authorizes a wallet action? | [Service](../backend/src/investments/service.mjs), [Privy policy](../backend/src/investments/policy.mjs), [runtime binding](../backend/src/investments/runtime.mjs) |
| What prevents retries creating another payment? | [Managed-wallet requests, nonces and signed bytes](../backend/src/playable/testnet-wallets.mjs), [investment service](../backend/src/investments/service.mjs) |
| How are API pools/routes filtered? | [Official API adapter](../backend/src/investments/uniswap-api.mjs) |
| Where do genuine observations come from? | [Publisher](../backend/src/bank/pool-observations.mjs), [background keeper](../backend/src/bank/pool-observation-keeper.mjs) |
| What does a player confirm? | [Native investment menu](../plugin/src/main/java/org/agentcity/paper/InvestmentMenu.java) |
| What proves an item was delivered? | [Game-order service](../backend/src/playable/inventory-shop-game.mjs) and [marketplace checkpoint](../evidence/MARKETPLACE_CHECKPOINT.json) |

Inspect integer units, negative tick rounding, fee-inclusive checks, nested recipients, deadlines and actual allowed contracts. The hook's dynamic fee flag is not a fixed 8388608 fee. Same-pool tick averaging does not supply external fair value. Pause checks must not trap liquidity.

## 4. Read evidence at its actual scope

- [Marketplace checkpoint](../evidence/MARKETPLACE_CHECKPOINT.json): controlled public deployment/swaps/checkout and native delivery, with canonical transaction hashes and replay proof. Some original pending notes describe the earlier checkpoint, not later identity/inference upgrades.
- [LP contract and recovery checks](../evidence/runs/investments/00d2c901-8bd4-46d7-a3df-ba2057872c41/verification.json): isolated real contracts, PostgreSQL and provider fixtures; no new player LP investment signed.
- [Latest native review and expiry repair](../evidence/runs/investment-review-lifecycle/6c7dd9bb-928a-4e36-a6aa-37facfdc7b60/report.json): actual PostgreSQL recovery, isolated native menus and a real read-only testnet quote. The live owner swap remained pending.
- [API support probe](../evidence/runs/investments/b87bfcf1-d9d0-4ea0-9fe9-7e1a338fe138/api-support.json): chain advertisement, unindexed custom pool and unsupported API route details.

Do not upgrade a simulation, submitted transaction, wallet funding, UI screenshot, synthetic identity or controlled second client into independently operated human acceptance. Report exactly which release, environment and receipts were checked.

## 5. Optional service/recovery checks

The following test requires an explicitly prepared local database at `.local/backend/environment.json`. It creates a random test schema and injected chain/session/signing fixtures; it does not use a real wallet:

```sh
node tests/investments/service.mjs
```

On a disposable fresh development host, `python3 scripts/local_database.py` can provision the owned local database after Docker is installed. On the enrolled game laptop, coordinate with the operator and reuse the existing approved configuration; do not create new credentials, replace a live database or copy `.local` into a new clone merely to run this test. Preserve the original database and all financial journals.

Native GUI checks require a separately provisioned isolated world and synthetic backend, as described in [the investment runbook](UNIROCK_INVESTMENTS.md#setup-and-verification). Do not run server upgrade, funding, publisher or delegate-maintenance commands against the live host during a source review.

## 6. Demonstrate in Minecraft with the real player

Use [the README walkthrough](../README.md#play-the-hosted-minecraft-demo). The operator must provide a running enrolled host; it cannot be reproduced from a secret-free clone alone.

1. Join the approved Minecraft connection and enter UniRock with `/mumbai`.
2. Open `/market`, inspect exact stock/quantity/CITY cost and the existing game wallet. Any real purchase needs its own consent and collection receipt.
3. Open `/invest`, choose a 0.01 CITY/tUSDC position, and inspect all review pages. Both test tokens plus the displayed maximum gas reserve are required. A funding shortfall is not an LP deposit.
4. The actual player confirms. Keep the same operation open until its canonical receipt is confirmed; after disconnect/close, use **Resume Latest Investment**. Never create another deposit as recovery.
5. Inspect the resulting position NFT, owner, amounts, tick range and in-range state. Review and explicitly confirm each increase, fee collection or withdrawal. Fees may be zero. Withdrawal must remain available during swap pause.
6. Demonstrate an ordinary bounded swap only with the owner's separate exact review. Explain that other API pool execution is currently disabled.

Keep attack tests in the isolated EVM. Do not sandwich, pause, drain or manipulate the active pool for a demonstration. A complete live player LP lifecycle is still a required new evidence item, not a result asserted by this guide.

## Suggested AI review prompt

> Review EthCraft's Uniswap integration using AGENTS.md and this guide. Read the hook, router, SDK builder, wallet consent/recovery and tests. Run the credential-free isolated checks and optional read-only chain calls. Compare claims against code and evidence. Explain original contributions versus reused Uniswap components, API support limits, LP ownership/fees/withdrawal, and remaining manipulation/LP risks. Distinguish local fixtures, public read-only observations and confirmed transactions. Do not access private configuration, spend tokens, run inference, mutate a server or deploy anything. Cite exact files and report failures or missing live proof honestly.
