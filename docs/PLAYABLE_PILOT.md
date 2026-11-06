# Playable pilot development

This document preserves the initial playable checkpoint. Current structure,
gathering and crafting tools are described in [Personal agent capabilities](AGENT_CAPABILITIES.md),
and the subsequent managed wallet implementation is described in
[the managed market update](PLAYABLE_MARKET.md).

On 31 October 2026 the user authorized a playable-server expansion and parallel
implementation. This changes the earlier calculator-only product scope; it does
not turn historical fixtures into passing release evidence.

The current milestone adds a separate protected lobby with five clickable NPCs,
a Survival world, owned agents, local language requests and internal Game Coins. The running
calculator is preserved in its original saved world. The pilot is a separate clone
on the same loopback game address, 127.0.0.1:25596, using the pinned Paper runtime.

Commands:

- `/agent` opens the Agent Desk menu.
- `/agent create`, `follow`, `come`, `wait`, `status` control your own agent.
- `/agent task <request>` asks local Ollama to select a supported movement,
  construction, collection, delivery or sale action.
- `/agent release` releases an empty owned agent and preserves its receipts.
- `/wallet` or `/balance` shows internal Game Coins and recent ledger history.
- `/pay <known-player> <whole-coins>` prepares a payment preview.
- `/accept <preview-id>` confirms your own preview once.
- `/jobs` reports the current supported job capabilities honestly.

To start the prepared Windows host, run `.local/setup/start-world.cmd`, then join
`127.0.0.1:25596` with Minecraft Java 26.3 as your allowlisted local username
(`Ruddy` is already configured). On an existing session, `/lobby` opens the lobby
flow again. Click Guide or Play, enter Survival, and use `/agent create` followed
by `/agent status` to find your assigned source chest, destination and build
origin. Stay beside the prepared task area and leave its working cells clear.
You can play
normally alongside it; locked task areas temporarily reject item/block changes.

There are initially two agent slots. New players enter `agentcity_lobby`, which
contains the onboarding NPCs and a Play entry. `/play` enters the separate normal
terrain world `agentcity_play`; `/lobby` returns. The calculator is an optional
`/museum` visit, never the initial spawn scene. Worlds and player inventory persist.

Agents work in the play world. The current physical catalog supports bounded
platforms (2–8 blocks per side), small shelters (4–6 per side), and deliveries
between the agent's registered source and destination chests. Examples:

```text
/agent build platform 2 2 oak_planks
/agent task build a 4 by 4 cobblestone shelter
/agent deliver cobblestone 4
/agent collect cobblestone 4
/agent task collect 4 cobblestone from my source chest
/agent sell cobblestone 4
/sell oak_planks 2
```

Task pads receive a disclosed one-time demo grant of 128 oak planks and 64
cobblestone each. These are real game items, not blockchain backing. Builds consume
actual inventory; delivery moves actual items. Persistent operation receipts and
receiving-boundary plot/chest locks reconcile retries and preserve uncertain work.
`/agent wait` pauses safely; repeating the same plan resumes its retained task.
Source chests must be replenished with actual items when stock runs out.
The prepared approach corridor is used for chest/build travel so an agent does
not cut diagonally through surrounding natural terrain. Human players can explore
normally; agent physical tasks remain bounded to registered work areas.

The internal shop buys cobblestone for 1 Game Coin and oak planks for 2, with a
1–64-item limit. A separately recorded 10,000-coin shop treasury is seeded once.
Sales reserve treasury coins, remove actual inventory through a durable server
receipt and then settle once. `/sell retry <sale-id>` uses the original removal
operation; unknown effects retain the reservation and may need operator review.
The model cannot choose arbitrary prices or mint a reward for claimed work.

Mining, unrestricted blueprints and paid jobs remain later work. Language requests
outside the supported catalog are refused rather than marked complete.
The current UI is in-game; a player web dashboard remains subsequent work.

Game Coins use PostgreSQL transactions, immutable request bindings, whole-number
balances, one-time starter grants and retry-safe receipts. They have no cash-out,
Uniswap conversion or blockchain backing. `/wallet` in this pilot is different from
the browser signing page at `/wallet`. External wallet/Uniswap demonstrations
remain separate; the newly requested in-game crypto wallet is not implemented.

The plugin attributes requests to the actual local player event, persists its queue
and serves it only through the private plugin API token. The worker consumes that
queue and applies agent ownership or ledger checks. The LLM cannot spend money,
accept work, change recipients or run arbitrary commands. Local allowlisted names
are not proof of Microsoft identity or independent human participation.

Runtime state stays under ignored `.local/playable-world/`; no keys enter prompts
or committed evidence. The pilot retains the calculator job's original operation
journal, materials and locks. New hub/stair infrastructure is disclosed operator
infrastructure and is not construction stock or token backing.

Canonical P0 remains blocked for renewed implementation-scope review, and original
live P3–P8 gates remain pending. This is explicitly authorized local product
development, not advancement or approval of those canonical gates. Existing cases
and failed attempts remain unchanged.

Development uses three parallel lanes for the UI, personal agents and economy,
with root ownership of shared plugin routing, host setup and integration. The
next milestones are broader task tools, task previews/approval, paid game jobs and
the player dashboard. They require
actual world/accounting verification before being presented as usable.

## Wallet audit

The in-game ledger legitimately requires no EVM signature: it is a server-managed
Game Coins account. The separate browser wallet page explicitly calls
`eth_signTypedData_v4`, and the human transaction flow calls `eth_sendTransaction`
with consent. Configured operator roles can decrypt local keystores and sign
programmatically; absence of a browser prompt does not mean an unsigned crypto
transaction. A future in-game crypto wallet would therefore require server custody
or an appropriately authorized delegated wallet, plus a real identity/security
design. No such wallet or new public deployment is established by this milestone.
Existing historical testnet evidence remains separate. Testnet balances do not
establish cash value, and this pilot does not convert item sales to testnet tokens.
The user prioritized the playable features before that wallet work.
