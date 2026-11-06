# On-chain Minecraft marketplace

All new item and estate sales use CITY on Unichain Sepolia (1301). GEM can be exchanged for CITY through the hooked Uniswap v4 pool; disposable test ETH pays gas. Discord handles account setup and explicit confirmations. Privy-managed wallets sign the approved bounded transactions without a separate wallet popup. AI can propose a registration or swap; it cannot approve spending.

## Sell a stick or another item

1. Finish `/start` and `/profile` in Discord. Connect with the linked Minecraft name and approve the current connection using `/join`.
2. If needed, use `/assets action:fund`, review the destination and confirm the one-time 100 CITY + 0.0001 test ETH grant.
3. Hold the actual item in Minecraft. In Discord use `/assets action:register_item source:player count:1`. An optional `slot` selects hotbar 0–8 or inventory 9–35. For an owned connected agent, use `source:agent`; its physical task must be finished or reconciled.
4. Review and confirm the exact item and quantity. Actual native custody backs its NFT. Registering one stick from a stack of three reserves one and leaves two in the source inventory. Changing the source stack after the preview invalidates that preview.
5. Once registration is confirmed, find its token ID with `/assets action:owned`. Use `/assets action:list asset:<token-id> price:4` to preview a total price of 4 CITY for that complete lot, then explicitly confirm.

Supported plain resources are oak planks, cobblestone, stone, dirt, sand, oak logs, sticks and stone bricks, in lots of 1–64. Weapons, tools and armor retain exact enchantments, damage, custom name, lore and native metadata, one item per asset. Containers, bundles and nested inventories are excluded. A resource lot is one NFT; partial fills are not implemented.

## Buy and collect

Browse **#marketplace**, `/assets action:browse` or `/bazaar action:browse` in Discord. Review the exact CITY price and asset, then confirm. A buyer who needs CITY separately previews and confirms a GEM/CITY swap. Payment and NFT transfer settle atomically; a swap alone does not buy an item. You cannot buy your own listing.

For an item, use `/assets action:redeem asset:<token-id>` and confirm. The token locks during backed redemption, then burns against the retained native mailbox receipt. Join with the approved game connection and use `/bazaar claim`, or `/bazaar action:claim` in Discord, to collect the exact item lot. Close inventory menus and leave enough space. A new player can claim through its verified Minecraft alias without creating an internal coin account.

Land and houses share a deed. Use `/assets action:parcels`, claim an available numeric parcel ID, then visit it with Minecraft `/estate visit <id>`. Update a changed house using `/assets action:snapshot` before selling its deed. Confirmed ownership controls native access for the owner and their bound agent. See [the full asset guide](BLOCKCHAIN_ASSETS.md).

## Existing stock and recovery

The former internal coin economy is retired. Its balances and operation records are preserved without conversion; fresh starter grants, internal payments, shop payouts and new legacy trades are refused. Historical fixture opt-ins are explicitly labelled and never enable the live host.

Old backed listings are withdrawal-only. Their owner can use `/bazaar action:cancel listing:<original-listing-id>` and then `/bazaar action:claim`, or Minecraft `/bazaar cancel <id>` and `/bazaar claim`. This returns the original stock; it does not issue CITY or mint an NFT. After claiming it, separately register and list the actual item through `/assets`. Older unsigned/unbacked drafts cannot reserve new stock.

Keep the original operation ID after an uncertain result. `/assets action:status operation:<id>` inspects it, and `action:retry` reconciles it. Never create a replacement to bypass unknown custody or payment. The world, native journals, wallet intent database and property projection require coordinated backups; extended crash/restore and independent-human purchase acceptance remain separately qualified checks.

Discord's “The application did not respond” is an interaction acknowledgement failure, independent of the Minecraft connection. Commands defer privately before executing financial actions. An initial acknowledgement failure dispatches no sale or agent command. Operator diagnostics retain numeric codes, stage and timing, without tokens or provider payloads; an observed recovery alone does not prove the original timeout cause.
