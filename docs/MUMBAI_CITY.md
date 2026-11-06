# Mumbai city and UniRock

The 6 November 2026 city extension makes the existing Mumbai world the main
AgentCity destination. It preserves the original world UUIDs, calculator museum,
three legacy agent owners, inventories, contracts, budgets and operation history.
The generated city remains protected scenery. A new owned waterfront district
contains UniRock, its service desks and two bounded agent work plots.

This is a laptop testnet pilot. The original phase gates and public deployment
qualification do not pass because the city or its user interface works.

## Player flow

Connect to `127.0.0.1:25596` using the existing Java 1.21.11 profile. Keep the
existing Discord/Privy registration. Each fresh connection still needs AgentCity
`/join` approval in Discord. Approved arrivals and respawns use UniRock. The
arrival is to the right of the two agent concierge positions.

- `/mumbai`, `/lobby` and `/play` return to the city bank.
- `/museum` visits the preserved calculator world.
- The five bank NPCs retain Guide, Agent Desk, Job Board, Wallet & Market and
  travel functions. They have distinct profession outfits and seated avatars.
- `/agent 0g create` and `/agent claude create` create or reconnect your two
  agents. Replace `create` with `status`, `inspect`, `capabilities`, `come`,
  `follow`, `wait`, or a bounded natural-language request.
- Open the Marketplace compass in your inventory, or use `/market`. Choose a
  stocked resource, choose a quantity, then review its total CITY price. Each
  screen shows the current step and one green button to continue. Presets offer
  1, 8, 16 or the available maximum; the count stays within current stock.
  Reviews allow ten minutes for wallet onboarding and confirmation. An expired
  quote refreshes the review and requires another explicit click.

Vanilla Java cannot add an arbitrary button to its built-in inventory screen.
The tagged compass provides that entry point without a client mod. It does not
overwrite existing items; `/market` remains available with a full inventory.

## Worlds and authority

The bank occupies an air/water site near the original Mumbai arrival. Its
versioned blueprint refuses occupied targets and records a durable installation
marker. It does not demolish generated buildings or rebuild player structures
on every startup. Existing monuments and old arrival access remain intact.

The earlier CityAgent1–3 plots and their controlled owners remain in
`agentcity_play`. New CityAgent4 (0G) and CityAgent5 (Claude) use separate local
manager directories but the same actual authenticated player principal. Each
manager retains one owner. No fixture owner or wallet is assigned to the player.
The new orchestrator holds the legacy manager lease, so the earlier recovery or
normal worker cannot run concurrently. Already-owned slots reconnect at startup
and when the native service recovers, after verifying their real stored owner
bindings. Idle restoration creates no new slot and grants no task or payment
authority; physical work still requires the actual approved owner.

Idle agents appear at the bank. A validated physical task lock moves its agent
to its own Mumbai work plot; unlocking returns it to the concierge. World and
plot checks still constrain effects. The two new plots receive a disclosed,
one-time local demo grant of 128 oak planks and 64 cobblestone each. These grants
are not token backing or purchased stock.

Approved players use Survival mode so real inventory custody can operate.
Scenery extraction, bank damage, arbitrary generated-container access and
unapproved movement remain blocked. An authenticated owner may use the fixed
source/destination chests and build in the unlocked interior of their own work
plots. Foundations and access strips remain protected. An inventory screen does
not grant custody, wallet or agent authority.

## Marketplace and wallets

The catalog contains actual plain resources held by the existing controlled
BankSeller merchant. Its explicit bootstrap is finite: 64 each of the eight
supported resource types, once, with original items retained. Native observations
provide the current stack quantities, slots and fingerprints. Generated Mumbai
blocks never supply the shop.

Prices are disclosed testnet prices, currently 0.01 CITY per item. A quantity
quote moves no funds or materials. New purchases use a separately enrolled
Privy-hosted, AgentCity-managed game wallet linked to the actual approved
Discord/Privy principal. This is managed testnet custody. It does not give the
server control of the player's existing external wallet.

The player creates the game wallet with an explicit native button. An optional,
separately confirmed one-time starter subsidy provides 1 test CITY and 0.0001
test ETH from existing controlled Seller funds. Its two purpose-bound transfers
use the Seller's original nonce journal and cumulative budget. The earlier
fixed 100 CITY external-wallet grant is retained separately. The existing
controlled developer provided a one-time 0.0012 test ETH operations top-up to
the Seller, using the original deployment nonce journal and unchanged budget.
This operations top-up is separate from a player grant or purchase consent. No tokens are
minted or withdrawn from pool liquidity for either subsidy.

After checking the exact item, quantity, CITY total and wallet gas allowance,
the player clicks Pay in Minecraft. That recorded consent permits only the
original exact approval, purchase and item release. The buyer policy permits
only those three methods on the current contracts, with a 1 CITY purchase
ceiling and chain 1301. Each buyer call has a 0.00003 test ETH gas allowance;
the order reserves at most three such calls. The existing 0.008 test ETH
cumulative managed-wallet gas budget is never reset. Funding never
authorizes a purchase.

Confirmed canonical payment and release receipts precede inventory delivery.
Collect closes the shop menu before the native inventory claim, leaving its
normal custody checks intact. Interrupted purchases are available through
Resume My Purchase in the catalog. Status recovers only the original recorded
consent and transaction IDs. It never creates another purchase or replaces
an uncertain payment. A fresh connection needs Discord approval.

Historical browser checkout orders retain their original external-wallet
capabilities, signatures, receipts and funding rules. They are not silently
converted into game-wallet orders. New game-wallet orders remain on their
original route if the feature is temporarily disabled.

The native GUI uses the existing durable plugin request queue. The backend polls
only shop events and returns private, connection-bound replies. It does not
expose the Mac's onboarding server to the network or call host localhost from
inside the Minecraft container.

## Operation and verification

Build the companion with `npm run build` in `companion`, then compile the plugin
with `python3 scripts/build_plugin.py`. Qualify it on an isolated copy first:

```sh
python3 scripts/mumbai_city_host.py isolate
node tests/maps/mumbai-city-visit.mjs
python3 scripts/mumbai_city_host.py upgrade
```

The isolated proof binds the actual report, candidate JAR, server namespace and
all seven world UUIDs. Upgrade takes complete private native and database
backups. An unsuccessful upgrade restores the previous plugin and descriptor only if
the bank installation marker is unchanged. If a bank migration has started, it
stops the server, retains the qualified new plugin and marks forward recovery
as required. Worlds, database records, chain obligations and failed history
are never automatically rolled back.

Run one onboarding server, one identity-only Discord coordinator, the Mumbai
agent orchestrator and the controlled merchant connector. The backend enables
its shop worker only when private `.local/mumbai-city/shop-settings.json` has
`enabled:true`. The native Privy route also requires `privyInGameEnabled:true`
after running the scoped policy setup and qualifying the matching plugin.
Do not start a second legacy manager or Discord gateway.

`node scripts/inventory_shop_privy_setup.mjs` checks the existing owner/delegate
and buyer-policy configuration; `--apply` installs the current three-method
policy after verification. `node scripts/inventory_game_seed_merchant.mjs`
preflights the fixed operations top-up in this laptop's original deployment
journal; `--apply` creates or reconciles that same bounded intent. These are
operator setup steps. They do not enroll or spend from a customer wallet.

Provider keys stay in their existing private files. The 0G and Claude ledgers
retain their caps and all earlier reservations, including the unresolved 0G
charge. Agent creation and read-only status use no paid inference. Only explicit
model requests can spend the remaining recorded allowance.

Actual deployment, human movement, provider requests and owner-signed purchases
must be recorded separately. Fixture tests do not establish those live results.
The new agents' estate/sales/delegated-finance paths remain unavailable until
their registry and signing policies are explicitly adapted and verified.

## Verified local update

UniRock v2 corrects the outside-facing gold sign, widens the front entrance and
removes the five desk fronts and side partitions. The installed v1 marker is
archived byte-for-byte. A bound migration journal precedes the 446 changed
decoration cells; unknown blocks and inventories are refused. An isolated restart
confirmed the completed markers remain unchanged.

The combined native migration/menu check passed 12 cases in
`evidence/runs/mumbai-city/18559714-fc77-4f51-b497-52811e8e0690/report.json`.
Live upgrade health and preserved world/stock checks are recorded in
`evidence/runs/mumbai-city/f5a67463-a935-46d9-831f-489e41b63a7a/`.
The actual user subsequently confirmed the agents are reachable and the menu is
clear. This confirmation does not establish a paid wallet purchase.

A real earlier Claude request built nine oak blocks with native receipts. The
earlier owner-live 0G request returned HTTP 401. Later provider-ledger entries
do not by themselves prove a completed Minecraft task. A connected agent also
does not establish inference quality. Original budgets and unresolved
reservations remain retained.
Real-user native game-wallet enrollment and its Privy/identity binding are
verified. Explicit native payment and confirmed delivery still need their own
live verification. These results do not pass the original release gates.

The native Privy checkout update passed 13 isolated Minecraft checks plus an
actual restart in
`evidence/runs/mumbai-city/a6b190a9-0795-4e22-82b1-6c7606232bea/`.
Its collection check establishes the real inventory-close and native custody
guards with a non-effectful preview. A paid physical claim is deliberately
reserved for the actual user's end-to-end test. Policy and operations funding
verification are in `evidence/runs/inventory-game-privy/`; no customer purchase
is claimed by those setup records.

The first native enrollment exposed an absent starter-grant field serialized
as JSON null, which Minecraft's immutable order map refused. The backend now
omits that absent optional field. A wire-contract regression failed before the
fix and passed afterward; the checkout backend was updated without restarting
Minecraft. The actual user then created the Privy game wallet successfully.

On **Add CITY to Game Wallet**, the paper icon is balance information. The
solid gold block on the right explicitly requests **1 test CITY + 0.0001 test
ETH**; funding does not buy the items. A request rejected before entering the
native queue can be confirmed again after checking status. An uncertain Fund
or Pay result remains status-only to prevent duplicate submission.

A purchase with confirmed redemption now takes priority over newer processing
orders. Opening `/market` goes directly to **Collect Materials** for that paid
mailbox. Collection freshly checks the original redemption proofs, then uses
the same native claim ID; it does not replay completed mint/list/buy checks or
create another payment. Unverified or reorganized redemption still blocks
delivery. An interrupted second order keeps its own original receipts.
Completed starter grants are not reprocessed during purchase status checks.
Current balances and fresh redemption proofs still guard payment and delivery.

On 6 November 2026, the actual approved owner confirmed collecting one oak
plank purchased for 0.01 test CITY. The retained order records confirmed buy
and redemption plus the exact native inventory claim receipt. Evidence:
`evidence/runs/inventory-game-privy/22ed3783-77a1-4c1f-838b-b65e4885200d/native-delivery.json`.
The bank and generated scenery remain protected. Owned, unlocked work-plot
interiors accept building: CityAgent4 uses X 1732–1741 / Z 2812–2821, and
CityAgent5 uses X 1748–1757 / Z 2812–2821, both Y 69–76. This single-owner
purchase check does not qualify the original independent-human release gates.
