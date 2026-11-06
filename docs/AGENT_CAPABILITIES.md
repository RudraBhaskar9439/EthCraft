# Personal agent capabilities

The current local expansion follows the user's request for autonomous structure
building. It extends the earlier calculator and platform/shelter catalog; the
canonical phase approvals and their original evidence remain separate.

Join `127.0.0.1:25596`, enter `/play`, and use `/agent create` if you do not already
own an agent. Speak privately with `/agent <request>` or `@agent <request>`.
The local Ollama model interprets the request, proposes a sequence, and the
worker carries out supported steps without requiring a command for every block.
An optional [direct Anthropic adapter](ANTHROPIC_SETUP.md) supports the same
validated planning path; it requires explicit host configuration and approval
for paid API use. Saving a key alone leaves the live Ollama worker unchanged.
Use `/agent status`, `@agent stop`, and `@agent resume` to observe or control it.
The Agent Desk also has **Inspect supplies** and **Capabilities** buttons;
`/agent inspect` and `/agent capabilities` open the same direct tools.
Start physical work near your agent in its work area. Once accepted, it can
continue while you move elsewhere on the server; you must remain online.
Disconnecting pauses work with its original material journal retained. Following
and wallet actions retain their separate visibility and authorization checks.

Examples:

```text
@agent What can you do?
@agent Inspect my supplies and work area.
@agent Build a 4 by 4 wooden house, 4 blocks high.
@agent Build a 3 block wide arch from oak planks in the clear part of my plot.
@agent Gather two oak planks, craft four sticks, and put four sticks in my destination chest.
```

The model can propose houses, towers, bridges, walls, stairs, arches and custom relative
block layouts. Compact custom designs combine rectangular solid sections and
carve out declared openings; the server expands these into ordinary placements
and checks their dimensions. Openings must be clear before materials move and
remain clear at completion. This does not grant permission to remove old builds.
Free-form custom geometry remains experimental: a valid block layout alone does
not prove it matches the requested design. Parameterized building tools provide
the reliable geometry path; arbitrary custom designs are not qualified by the
current model tests. Custom layouts support up to 256 blocks in an 8 by 8 footprint
and six layers; the actual layout must also fit the assigned plot and preserve
its chest access strips. The current full-block palette is oak planks,
cobblestone, stone bricks, stone, dirt, glass, bricks and oak logs.
These are full-block designs; a staircase design uses full blocks rather than
oriented stair items. Existing platform and shelter commands remain available.

Builds use carried materials first and retrieve missing materials from the
registered source chest. Every native withdrawal and placement is recorded and
checked against observed inventory and blocks. Existing correct blocks are not
charged again. Obstructions, shortages and unsafe or unreachable placements
pause the task; they do not cause creative item grants or claimed completion.

Gathering supports observed oak logs, oak planks, dirt and sand inside the own
plot, at most 16 blocks per task. The agent must collect the actual drops.
Foundations, access strips, chests and retained task structures are protected.
Crafting supports oak logs to oak planks, oak planks to sticks, and stone to
stone bricks, using actual recipe inputs and output quantities. Craft counts are
desired output quantities; whole recipe batches can leave extra output in the
agent's inventory. Two oak planks produce four sticks. Collection and delivery use the registered chests; delivery
can deposit carried items. Supply inspection reports observations with their
timestamp rather than assuming a chest is still unchanged.

Autonomy remains bounded to the registered work area and prepared approach.
Unrestricted exploration, mining with tools, combat, farming, smelting, arbitrary
redstone, oriented furniture, arbitrary commands/code and multi-agent teams are
not implemented. This source supports three personal agents, one per owner,
with one unfinished physical task per owner. No claim is made that the agent can
do everything a human player can do.

On joining, an agent outside its assigned plot returns to that plot's clear chest
access strip. Existing positions inside the plot are retained. A blocked home is
never cleared for onboarding.

The third slot requires the updated plugin, worker, Discord bridge and a whitelist
entry for `CityAgent3` on the actual host. Updating this checkout alone does not
increase the teammate-hosted server's capacity. During an idle upgrade, preserve
the existing worlds, agent ownership file, task journals and inventories. The
plugin reads old `taskPadsInitialized:true` saves as two initialized pads; it
prepares only the new third pad, at spawn offset x+23,z+18. This offset was checked
against the saved host terrain after the original proposal hit vegetation. It refuses an occupied
new work area instead of clearing a player build, and does not refill either old
chest or rebuild the existing walkway. Each new pad retains the disclosed one-time
local stock grant; it is not token backing. Take a coordinated backup before
installing the plugin. If the new area is occupied, restore the previous release
and have the operator review the location; do not reset saved pad markers.

On the current Windows host, build with
`powershell -File tests/inspection/build_world_assets.ps1`. In a coordinated idle
maintenance window, stop the owned worker and game container, back up the runtime
and database, install the resulting JAR, and merge the offline UUID/name entry for
`CityAgent3` into the existing whitelist without replacing other entries. Start
the game first and verify `/playable/status` through the private local API reports
`personalAgentCapacity:3`, `initializedTaskPads:3` and three task regions before
starting the updated worker. Its version check refuses a two-slot plugin. Verify
the two original owners remain unchanged, then create the third agent as the new
owner. Actual third-agent login, construction, inventory custody and estate access
still need live verification on that upgraded host. A separate Discord bot token
is optional for a dedicated DM identity; the coordinator can control the agent.

Food harvesting, farming, cooking and hunting are not implemented. Requests for
food must explain that limit and clarify the supported part of a mixed request;
dirt or another building material cannot substitute for food. Gather proposals
require a material and exact quantity grounded in the player's conversation.

The model cannot change ownership, bypass plot permissions, erase an uncertain
material operation, spend from an arbitrary wallet, or confirm a swap for its
owner. Wallet and Uniswap behavior is described in [the managed market
documentation](PLAYABLE_MARKET.md). A broader physical tool catalog does not
establish production readiness or pass the pending canonical live gates.

Actual carried resource lots and equipment use the on-chain CITY
[Minecraft marketplace](GAME_MARKETPLACE.md). The registered owner reviews and
confirms registration, price and purchase. An agent's physical-task grant cannot
approve a financial action. Older internal-currency stock is withdrawal-only;
new starter grants, internal payments and legacy sales are disabled.

The subsequent [integrated blockchain asset extension](BLOCKCHAIN_ASSETS.md)
provides exact item custody and estate deeds through Discord `/assets`.
Humans confirm registration, listings, purchases and redemption; the model cannot
sign or accept them. Registered owned bots may enter their owner's verified
estate while the human is offline. Existing construction tools still use their
registered task areas; ownership does not grant arbitrary construction powers.
