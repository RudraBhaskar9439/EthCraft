# AgentCity laptop marketplace

The active product is a marketplace: exchange test USDC for CITY, buy deposited
equipment, and reserve CITY to pay for verified agent work. Lending, borrowing,
auctions and borrower credit tiers are excluded. Older bank contracts and LP
positions remain intact as historical deployments; the active pool uses a new
marketplace hook and a new router binding.

This deployment is Unichain Sepolia, chain 1301. tUSDC is a six-decimal mock,
not Circle USDC or dollar-backed money. CITY has 18 decimals. The active
interface supports CITY and test USDC only. GEM and the old bank are not active
marketplace actions. Developers control the demonstration wallets and clients.

The [verification checkpoint](../evidence/MARKETPLACE_CHECKPOINT.json) separates
actual testnet/native results from local fixtures and pending release checks.
The [public manifest](../config/marketplace-public-deployment.json) records the
exact contracts, new pool, official LP position and source pins without secrets.

## What the price protection does

Uniswap v4 does not include v3's built-in observation oracle. The new hook records
the exact pool's tick multiplied by elapsed seconds, then compares execution
against a geometric time-weighted reference. Callers cannot supply a price.
Same-block swaps do not create elapsed history. The 64-slot ring stores at most
one observation per 30 seconds; its reference anchor must be 300–600 seconds old.
This is a variable-duration geometric reference, not an arithmetic average or an
exact five-minute rolling window.

The testnet policy is enforced inside the hook:

- At least 300 continuous seconds at or above the configured minimum active liquidity
  before AMM swaps. Falling below it restarts the qualification period. The
  threshold is raw Uniswap liquidity, not a promise of dollar depth.
- Maximum output of 10 CITY or 10 tUSDC per trade; total per-block output at most
  20 CITY and 20 tUSDC respectively.
- Pre- and post-trade spot deviation at most 200 ticks from the reference
  (about 2.02%); individual trade impact at most 50 ticks (about 0.50%).
- Actual input, including fees, at most 2% above the reference-derived input for
  the exact output. The owner's maximum input and 120-second deadline also apply.
- LP fees start at 0.30%, rise by 0.01 percentage point per tick of deviation,
  and cap at 1%. The fee depends on pool conditions, never borrower reputation.
- The administrator can pause swaps. Liquidity removal remains available.
  A stale/unhealthy world report also pauses buying CITY; selling CITY must
  still satisfy the pool's independent price, liquidity and size checks.

These are conservative demonstration parameters, not production calibration.
A same-pool reference does not establish fair value. Sustained manipulation,
arbitrage, MEV, liquidity withdrawal, adverse selection and LP losses remain
possible. **No AMM integration can honestly promise zero LVR or immunity to every
attack.** Dynamic fees and circuit breakers reduce specific risks; they do not
eliminate those risks.

## Start on this laptop

Keep Docker Desktop running and preserve the existing private `.local` files.
Keep this laptop awake while hosting; sleep pauses its services.
From the project checkout:

```sh
python3 scripts/laptop_host.py start
python3 scripts/laptop_host.py actors
node scripts/marketplace_server.mjs
```

Open <http://127.0.0.1:8794/> yourself. Minecraft is `127.0.0.1:25596`, version
1.21.11. The controlled clients already occupy their three test names; do not
join using those names. The interface can authorize all configured operator
wallets. It binds to loopback and is not a shared player login. Do not publish
port 8794 through a tunnel or public reverse proxy.

The active private manifest is `.local/marketplace/public-deployment.json`.
Wallet encryption material remains under `.local/bank`; the new deployment
reuses the existing finite test-ETH budget and durable chain journal. Do not
edit either manifest to repair an operation. Manifest digests bind confirmations.

## Use the marketplace

1. Select an operator test player. Refresh balances, receipts and price readiness.
2. Refresh verified world health before buying CITY. If the price reference is
   unavailable, record pool observations and allow at least five minutes of
   sufficient liquidity. A pool idle longer than its retained reference age
   needs warming again. Observations use the publisher's bounded test-ETH budget.
3. Review an exact CITY output and maximum test-USDC spend, then confirm. The
   hook rejects trades that fail its checks; a UI quote cannot override it.
4. Deposit the exact held equipment, list a CITY price, and buy from another
   controlled player. Paying in test USDC composes conversion, seller payment and
   final NFT ownership atomically. Redeem afterward to deliver the original
   equipment. Cancel an active listing before redeeming your own item.
5. Reserve a fixed CITY payment for the supported native agent task. Run it,
   inspect the actual result, and explicitly accept payment release. The current
   paid-work example is a 2-by-2 oak platform with four real consumed planks.
   The source's general AI planning tools are separate from this bounded paid
   example. An occupied work origin or missing materials blocks a new quote.

The retained paid-work proof has already built at the current fixed origin, so
another quote there is refused before funding. Repeating the demonstration needs
an intentionally prepared fresh work area or separately quoted signed offsets.
The paid-work proof is a separate run using the same CITY/escrow; the new pool's
verified conversion did not fund that earlier task.

Each financial action needs a preview and separate confirmation of its exact
terms. AI output does not authorize money. Equipment custody is backed by the
actual native item. LP funds, seller proceeds and work escrow are separate.
Gold/diamond resource lots and arbitrary paid AI plans are not qualified by the
equipment/platform demonstration.

## Recovery

A lost reply does not mean a transaction failed. Select **Review retained
operation** and reconcile its original identifier. Do not create a replacement
purchase or funded work task. Physical deliveries retain their original mailbox;
native work retains its original task, receipts and material accounting.

The reference-observation button likewise reconciles its original pending
transaction. It cannot invent time or reset the pool's price history. Keep both
PostgreSQL and native journals along with the encrypted wallets and manifests.
A chain must never be reset to match an old database backup.

Stop the interface with Control-C. Stop the owned world gracefully with
`python3 scripts/laptop_host.py stop`; restart with the original commands. The
launcher validates its exact container, mounts, ports and plugin hash.
Full-host backup restore qualification remains separate and pending.

## Verification and release boundary

The verification checkpoint records local official-PoolManager tests, guarded
testnet swaps and checkout, exact native custody, paid-work/restart receipts and
fixture-only transport tests separately. Old lending results remain historical.
Canonical phase gates are not relabelled passed by this extension.

Live Discord/Privy activation, independent human acceptance, 0G inference and
public Minecraft/token platform permission remain pending. Automated browser
access to port 8794 was denied; no alternate browser route was used. The local
HTTP handler is tested independently, which is not visual browser verification.
