# Exact-output Uniswap v4 swaps

The existing swap flow spends an exact input and protects a minimum output. The new flow requests an exact output and protects a maximum input. Both use the same fixed CITY/GEM pool, owner confirmation, durable transaction intents and canonical receipt verification.

For example, a requester can ask to receive exactly 10 CITY while spending at most 12 GEM. The quote shows the estimated input and the tighter final spending limit. A request alone never signs or broadcasts a transaction.

## Commands after deployment

Minecraft:

```text
/swap receive 10 GEM CITY 12
/swap confirm PREVIEW_ID
/swap retry PREVIEW_ID
```

The input token comes before the output token. The optional last number is the owner's maximum input. Existing commands such as `/swap 2 GEM CITY` continue to spend an exact input.

Discord:

```text
/assets action:swap amount:10 token:GEM mode:exact_output maximum:12
```

Review the exact output, maximum input and deadline, then use the existing confirmation button. Successful results display actual input spending from the verified receipt. Expired and reverted quotes do not offer another confirmation button.

## Amounts and authority

- All calculations use integer token base units; CITY and GEM each have 18 decimals.
- The default slippage allowance is 100 basis points. The input ceiling is the quoted input increased by that allowance, rounded up to whole wei, then narrowed by both the operator cap and any lower owner cap. A cap below the quoted input is refused before signing.
- Gas is additional and retains the existing native-cost limits. A maximum token input is not a total gas budget.
- Approval grants only the bounded maximum. The router transfers the actual required input directly to PoolManager and returns the exact output to the sender. It retains no swap tokens. A bounded unused approval can remain after completion.
- The two modes share the same on-chain replay domain. The stored mode, amount, maximum and quote deadline cannot be edited after preview. Retry reconciles the original signed operation.
- The hook remains authoritative for hooked pools. Exact output does not bypass stale or unavailable health data.
- Models continue to prepare proposals; only the bound owner's explicit command or button confirms spending. This addition does not register assets or complete purchases automatically.

The API accepts exactly one of `amountIn` or `amountOut`. `maxAmountIn` is optional for `amountOut` and is rejected for an exact-input request. Exact-output responses include `kind: "exact_output"` and `maxAmountInBaseUnits`; `amountIn` is the quote estimate and the receipt contains actual spending.

## Deployment boundary

Existing deployed routers are immutable and do not gain this method from a backend update. Manifests without `exactOutputEnabled: true` continue to support their original exact-input operations. Existing quote fingerprints and wallet policy templates retain their original behavior when this flag is absent.

For an existing installation, first reconcile outstanding approval/swap intents. A replacement router can target the existing PoolManager and identical pool key; this does not require replacing tokens, liquidity, asset registries or game ownership. Verify its runtime code hash, manager, pool key and `supportsExactOutput()` response before setting the capability flag. Update the managed-wallet signing policy and allowed targets through the existing operator approval process before enabling the route. Retain old receipts and do not silently rewrite pending quotes to the replacement router.

The fresh-deployment scripts verify the new router capability before writing an enabled manifest. Reusing an older local or public deployment does not silently upgrade it. No public deployment or managed-wallet policy change was performed for this implementation.

## Verification

The local checks use official pinned v4 contracts, a separate loopback Anvil chain, isolated PostgreSQL schemas and disclosed fixture signing providers. They cover both swap directions, exact received amounts, input caps, hook refusal, original exact-input behavior, requester authority, immutable terms, schema migration, interrupted-response recovery and replay without more spending.

```text
forge test --match-contract '^ExactOutputSwapTest$' --match-test '^testExactOutput' -v
node tests/playable/uniswap-market.mjs
node tests/playable/testnet-wallets.mjs
node tests/playable/onchain-game.mjs
node tests/world-assets/discord.mjs
python3 scripts/build_plugin.py
```

Run Forge from `contracts/`. The market integration test requires the owned local database and a fresh exact-output-capable fixture created by `node scripts/playable_uniswap_setup.mjs`; it never resets an older chain. Reports live under `evidence/runs/playable-uniswap/` and `evidence/runs/uniswap-exact-output/`. These checks do not qualify the canonical phase gates, independent-human acceptance or live Discord/Minecraft deployment.
