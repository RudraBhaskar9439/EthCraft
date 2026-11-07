# Editable calculator

Use `/calculator` after approving your Minecraft connection through Discord
`/join`. The calculator workshop uses Survival mode: break a block, collect its
item, then place it where you want. Adventure mode normally disables these
actions. Bring tools and building materials; this feature grants no inventory.
`/mumbai` returns to UniRock.

Select a tool or an empty hotbar slot when using levers and chests. Holding
the Marketplace compass opens the shop instead. Personal agent task tools
remain bound to their existing Mumbai work areas.

The guide and play menus also open this workspace. `/museum` retains the
protected reference demonstration used by the original job engine. Both are
in the existing reference world, with the editable copy translated 128 blocks
east, outside the protected plot. No new world UUID is created.

On first entry, the plugin copies the current calculator block layout into an
empty destination. It does not copy container contents, entities or ownership.
Existing blocks at the destination stop installation rather than being replaced.
The generated layout is practice scenery, never token backing or merchant stock.
Once installation completes, player changes are preserved instead of rebuilding
the template on visits or restarts. A safe remaining floor is required to enter.

The private `plugins/AgentCity/calculator-workshop.json` marker binds the world,
reference bounds and destination. An interrupted first installation can fill
only unchanged matching cells or missing air cells from the same reference
layout. Changed reference data or conflicting destination blocks require
operator reconciliation. Do not delete this marker to reset a used workspace.

Verify plugin upgrades on an isolated world copy with
`node tests/playable/calculator-workshop-native.mjs`. The controlled fixture
tests approval, empty copied stock, actual Survival break/place and lever use,
reference-state preservation, restart persistence and all seven world UUIDs.
These checks do not pass the original independent-human or research gates.
Reference `/museum` travel timed out in an earlier controlled fixture; that
separate UI route is not qualified by the workshop test.
