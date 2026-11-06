# Uniswap v4 integration feedback

AgentCity's current product is a testnet marketplace. Users exchange test USDC
for CITY, buy deposited Minecraft equipment, and reserve CITY to pay for verified
agent work. The integration uses Uniswap v4 exact-output swaps and an atomic
swap-and-purchase router. Test USDC is a six-decimal mock, not Circle USDC or
dollar-backed money; CITY has 18 decimals. Demonstration wallets and clients are
controlled developer actors.

The earlier bank experiment remains historical; its contracts and LP positions
are preserved, while its financial features are excluded from the marketplace.

## What the integration taught us

- **v4 pool state is not a historical oracle.** The installed official core
  exposes the current tick and active liquidity, but does not provide v3's
  built-in observation history. Our new hook accumulates actual pool ticks
  multiplied by elapsed time across swaps and liquidity changes. Permissionless
  checkpoints read PoolManager state; callers cannot submit a price.
- **A different hook requires a different pool.** The hook belongs to the
  immutable PoolKey, and callback permissions are encoded in its address.
  Adding observation and execution checks required a new hook address and pool,
  rather than changing the existing deployed pool's behavior.
- **The averaging window needs an exact description.** A 64-slot ring records
  at most one observation per 30 seconds. The selected anchor is 300–600 seconds
  old, so this is a variable-duration geometric tick reference, not an
  arithmetic price average or an exact five-minute rolling window. Negative
  average ticks must round down. Same-block activity cannot create elapsed
  history. AMM swaps require at least 300 continuous seconds at or above the
  configured raw active-liquidity threshold; old idle references need
  checkpoints or a new warmup period.
- **Token decimals and ordering matter.** Pool prices describe raw token units
  in sorted currency order. CITY's 18 decimals and test USDC's six decimals must
  be handled explicitly when displaying whole-token prices. Execution checks
  use TickMath and FullMath; a near-one initial whole-token price is not a peg.
- **Official quotes must exercise the same execution checks.** V4Quoter uses
  extreme square-root price limits. Rejecting those parameters in beforeSwap
  would break official quoting. Our afterSwap checks validate the actual
  resulting price, trade impact and input including fees. Quoter simulations
  revert their effects; real trades retain the output counters and observations.
  The router still requires complete exact output, a bounded maximum input and
  an expiry. The hook authenticates the configured router or official quoter.
- **Atomic checkout needs final-owner verification.** During checkout the
  router temporarily owns the equipment NFT before transferring it to the
  buyer. We check the final buyer, checkout event and both ownership-nonce
  changes, rather than treating the intermediate marketplace transfer as final
  ownership. Physical Minecraft delivery is a separate recoverable operation
  using the original custody receipt and mailbox.

## Risk boundaries and verification

The hook combines reference and execution bounds, trade and per-block output
caps, minimum-liquidity qualification, a world-health pause for CITY purchases,
and a 0.30%–1.00% fee based on deviation from the reference. Liquidity withdrawal
remains available during an administrator pause. These measures reduce specific
risks; they do not create independent fair value, guarantee liquidity, eliminate
LVR, or prevent every manipulation, arbitrage or MEV strategy. The liquidity
threshold is a raw Uniswap quantity, not a promise of dollar depth.

Nine focused local Foundry tests pass against the actual PoolManager and
official V4Quoter, with disclosed token and payer fixtures. They cover bootstrap,
elapsed-time averaging, decimal directions, atomic size and execution failures,
liquidity loss, stale references, authority, pauses and the observation ring.
The [test report and source hashes](evidence/runs/marketplace-hook/1ceba5e7-2f78-4f51-8cb5-0a72922a6f64/report.json)
and [actual Forge log](evidence/runs/marketplace-hook/1ceba5e7-2f78-4f51-8cb5-0a72922a6f64/forge.log)
record that scope.

The new public deployment, CITY purchase, atomic equipment checkout, original
item delivery and fresh-runtime replay now pass on Unichain Sepolia. An oversized
quote was rejected without spending. See the [current verification checkpoint](evidence/MARKETPLACE_CHECKPOINT.json)
for exact receipts and the independent saved-inventory proof. The earlier paid
native-work proof uses the same CITY token and escrow, but was a separate run;
the new conversion did not fund that earlier task. Independent human acceptance
and production qualification remain separate.
This feedback has not been submitted to an external form.
