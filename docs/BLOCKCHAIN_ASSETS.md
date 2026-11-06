# Integrated testnet assets

The active economy is on-chain only as of 1 November 2026. CITY prices all new item and estate sales; GEM is a swap token and test ETH pays gas. The internal coin ledger is archived, without automatic conversion. Older escrowed stock is owner-withdrawal/claim only. See [the current route](DEPLOYMENT_ROUTE.md).

## Scope and authority

On 31 October 2026 the user requested blockchain ownership and settlement for equipment, land and houses and explicitly overrode the earlier platform-guideline constraint after it was explained. This is a user-authorized testnet engineering exception, not platform approval or production qualification. The original platform-suitability case and other canonical phase history remain unchanged. Current Minecraft terms prohibit checking external ownership to unlock game functions: https://www.minecraft.net/en-us/usage-guidelines (Extended functionality and modifications), checked 31 October 2026.

Use only Unichain Sepolia, disposable faucet funds and the existing $0 spending limit. Preserve existing identities, wallets, native inventories, Game Coin balances, deeds and operation history. No automatic conversion of Game Coins into tokens is authorized. The wallet provider remains Privy; backend software is responsible for explicit human consent and constrained signing even when no wallet popup is required.

## Sources of truth

- The asset contract owns the authoritative wallet-to-asset relation. An item asset binds a unique native custody receipt and an immutable exact item snapshot hash. A parcel deed binds the server/world namespace and a fixed grid cell. Houses and their land form one deed; construction does not create independent ownership over someone else's parcel.
- The marketplace contract lists an asset for a fixed CITY amount. Exact seller, asset revision, listing nonce, price and expiry bind a buyer's consent. Token payment and asset transfer execute atomically; a swap alone never proves an asset purchase.
- Uniswap v4 exchanges supported payment tokens. The pool hook gates swaps against fresh published availability. It is not the asset ownership registry. A newly hooked pool is needed: the existing playable CITY/GEM pool has a zero hook, while the separate research demonstration has an availability hook. Hooks are selected at pool initialization: https://developers.uniswap.org/docs/protocols/v4/concepts/hooks.
- The Minecraft adapter enforces a verified projection of confirmed chain state. PostgreSQL stores identity bindings and operation recovery; the plugin stores real item custody and native access protection. Neither a Discord message nor an LLM response changes ownership.

## Exact crafted items

The owner selects an actual carried item. The plugin returns a preview of its serialized native snapshot, material, count, enchantments, custom name and durability. The owner confirms that fingerprint. The receiving boundary refuses any substituted or changed item before removing inventory. Minting follows the exact durable native custody receipt; a submitted transaction or synthetic snapshot cannot establish backing.

The registry cannot issue another asset for the same custody receipt. Trading transfers the asset's wallet ownership while native stock remains reserved. Redemption locks that specific asset to one recipient and claim ID. Native delivery is retried by its original operation ID; unknown delivery never remints the token or releases replacement stock. Only an exact retained delivery receipt finalizes redemption. Metadata is presented as player data and never becomes instructions or executable content.

## Land and houses

Parcels use a fixed grid with exclusive cells in a dedicated supported area of the play world. Public paths, the lobby, museum, calculator, existing task areas and another owner's parcel are not freely claimable. Initial assignment verifies entitlement and records actual bounds before issuing a deed; users cannot mint deeds for arbitrary coordinates.

The owner and explicitly bound owned agents may enter, build and use containers. Other users and agents are denied by default. Entry checks include movement and teleport/join/respawn paths; world changes and container access remain protected independently of entry checks. Ownership transfer removes the former owner's rights and gives them to the confirmed buyer. House changes update the deed's verified snapshot/revision; a listed house cannot be altered without invalidating or cancelling its old listing. Existing structural work locks and uncertain operations prevent transfer until reconciled.

## Translation and recovery

Authenticate the Discord identity, resolve its canonical principal, verified Minecraft UUID and existing Privy wallet, then bind the exact operation to those identities. Never accept a client-supplied inventory owner or wallet address as proof. Contract network, genesis, address and deployed code hash are pinned.

Apply only canonical receipt/block evidence with the configured confirmations. Ownership is read at the same confirmed block as the retained proof; sequence, asset revision, namespace and exact parcel/snapshot binding are verified before projection. Unconfirmed transfers confer no rights. Stale RPC data or a reorganization pauses new ownership actions and admission rather than creating another owner. Previously applied effects require reconciliation, not blind reversal of the database while native items or structures remain changed.

Each listing, trade, registration, projection and claim has a stable operation ID. Preserve signed transaction bytes and original native intents on timeout. Back up the blockchain intent database, native custody journal, property projection and world together.

## Player flow

Discord handles account setup, wallet identity and confirmations. A seller previews an exact item or their deed, sets CITY terms and confirms the listing. The buyer reviews the item/parcel, price, swap slippage if needed and capped testnet gas before confirming. A verified purchase changes chain ownership. The plugin applies confirmed rights: an item becomes redeemable to its owner, or land/house access changes to the new owner and their bound agent. Discord reports transaction hashes and pending, confirmed, applied or reconciliation-required states separately.

## Use the installed pilot

1. Finish Discord `/start` and `/profile`, join Minecraft and approve that connection with Discord `/join`. Existing linked players keep their account and wallet.
2. In Discord, choose `/assets action:fund`, review the destination and confirm. The finite test faucet grants each verified principal 100 CITY and 0.0001 test ETH once, for at most ten principals. It is onboarding test stock, not a reward for playing. Existing Game Coins are unchanged.
3. Hold supported equipment or a plain resource and choose `/assets action:register_item source:player count:1`. Plain resource lots support 1–64 items; equipment requires one. An optional `slot` selects a precise slot: 0–8 hotbar, 9–35 inventory. `source:agent` selects the registered connected agent's item instead; unfinished physical tasks must finish first. Review the exact quantity, name, damage, enchantments and fingerprint, then confirm. Registration reserves the selected quantity and preserves any remaining source items. A changed source stack requires a new preview. Containers, bundles and nested inventory components are excluded.
4. For land, use `/assets action:parcels`, then `/assets action:claim_land parcel:1` with an available numeric ID. Confirm the registration and wait for the verified ownership projection. Minecraft `/estate visit` reaches the public estate road; `/estate visit 1` enters your confirmed parcel. `/estate ownership` reports your deeds. The initial four 16×16 parcels are in the new `agentcity_estates` world, separated by roads; existing play-world builds and museum/task plots are preserved without automatic conversion into deeds.
5. Build your house on your owned parcel with actual materials. Before selling a changed house, choose `/assets action:snapshot asset:<token-id> parcel:1` and confirm its observed structure revision. The deed includes the land and house together. Storage contents are not priced as snapshot metadata; container access is frozen while the sale is protected. Existing personal-agent construction tools keep their registered work-area restrictions; parcel ownership does not make arbitrary agent construction available.
6. Use `/assets action:list asset:<token-id> price:10`, review the full CITY price and confirm. House listing freezes the observed structure; a changed snapshot is refused. Browse **#marketplace**, or `/assets action:browse`, and preview then confirm a purchase. A buyer may use Discord while their Minecraft client is closed.
7. For an item purchase, use `/assets action:redeem asset:<token-id>` and confirm. The token locks during redemption and is burned only against the backed native mailbox receipt. Join with the approved game connection and use `/bazaar claim` to collect that mailbox entry. Land purchases apply access to the buyer; they do not move the house's blocks.
8. `/assets action:swap amount:0.01 token:GEM` previews GEM → CITY through the new hooked pool. Choosing CITY reverses the direction. Confirm the quoted minimum output and gas allocation. Swapping and buying are separately approved transactions; a successful swap does not automatically buy a deed or item.

Use `/assets action:owned` for your assets, `action:status operation:<id>` for a retained operation, `action:retry operation:<id>` to reconcile it, or `action:cancel asset:<id>` to preview cancellation. Do not create a replacement trade for an unknown result. Minting and snapshot updates use the separate registrar; player approvals, listings, purchases and redemption requests use the existing restricted managed wallet. The offline owner key remains outside the runtime.

## Deployed contracts and verified payment route

The 31 October deployment is on Unichain Sepolia, chain 1301:

| Component | Address |
| --- | --- |
| World asset registry | `0x8cf4192b9846990f5fef4576d5b0a76f520023a8` |
| Asset marketplace | `0x98bb35196507528a3855e4980d4e845a970ed289` |
| Availability hook | `0x3c98b8b484a303decc9321ee0e944742dfdbc080` |
| Hooked payment router | `0x3378ee4a7930797865370140ce24517651e37069` |
| Availability publisher registry | `0x5db0cf0721c4b2f98de3f079d13a956dc922a3e4` |

An actual operator-owned 0.01 CITY → 0.009969801202164028 GEM swap passed with exact router/official-manager events, token deltas and same-operation retry checks: https://sepolia.uniscan.xyz/tx/0x7110d727afdad88f045e445b73234f0e0f500e57fa9098004fa774e48c351c7a. This test used developer faucet funds and did not register a player asset or claim human approval.

WorldGuard 7.0.20 and WorldEdit 7.4.6 provide native region protection, with additional owner/session, entry, projection-expiry and listing-lock checks in the AgentCity plugin. Exact release hashes, upstream license links and native fixture qualifications are in [the dependency pins](../config/property-dependencies.json). Ownership snapshots refresh every ten seconds and expire closed if chain evidence stops being fresh. The hook's availability report has its own bounded on-chain expiry and a dedicated publisher budget.

The contract enforces wallet ownership, revisions, nonces and atomic CITY/NFT settlement. Physical house state is attested by the native adapter; the qualified Discord purchase route refuses externally created parcel listings without a matching native freeze and canonical listing proof. A direct external contract listing does not itself prove the current house state. Unknown external wallet owners receive no native access until their identity is verified and mapped.

## Verification

Use focused ownership, exact-material/funds conservation and retry checks. Isolated contract/native fixtures are labelled as fixtures. Public deployment, an actual managed-wallet purchase, canonical event projection into the same world, denied foreign entry, exact equipment delivery and independent-human acceptance require their own observed evidence. No testnet submission, mock projection, screenshot or policy override passes a canonical phase by itself.

The combined isolated Paper/Anvil/PostgreSQL run [1524576e](../evidence/runs/world-assets-minecraft/1524576e-61c0-4862-b0e7-989b5e225d14/report.json) passed real equipment escrow, NFT mint/binding, an atomic 3 CITY purchase, redemption, burn and actual recipient claim. The full native sword fingerprint, damage, enchantments, name, lore and persistent data survived unchanged; repeating the operation created no additional items or transactions. Its identity, consent and unlocked local wallet accounts are explicit fixtures. This proves the native/contract translation for that equipment flow, not a public Privy purchase or independent-human acceptance. The earlier stale local RPC refusal is retained beside it.

Operator deployment, seed and swap scripts run inside the pinned WSL environment. Their durable checkpoint writer requires directory synchronization supported there; the Windows preflight synchronization failure is retained as a failed host attempt with zero transactions. The public deployment and actual hooked swap were subsequently verified from WSL. Extended coordinated crash/restore testing, a real player-managed-wallet asset trade and independent-human acceptance remain pending.
