# Mumbai Survival and objective agents

Mumbai now runs Survival rather than the protected sightseeing mode. Every
Discord-approved player may mine, build and use ordinary containers throughout
the mapped city. There is no work-plot membership requirement. Existing worlds,
inventories, receipts and wallet budgets stay in place. The museum, login gate,
financial custody and short locks around active agent work retain their guards.
Normal damage, mobs, crop growth, drops, weather and day/night cycles are enabled.
PvP remains disabled. No city blocks are automatically listed for token sales.

## Commands

Keep Minecraft connected and approve that connection with Discord `/join`.

```
/agent claude create
/agent 0g create
/agent claude task Gather wood, craft the tools you need, and build a small house.
/agent 0g task Find nearby food and collect it. Cook it if supplies allow.
/agent claude task Make a lever-operated redstone lamp using available materials.
/agent claude status
/agent claude inspect
/agent claude wait
/agent claude task resume
```

Replace `claude` with `0g` for either provider. Both use the same receiving tools;
their existing provider-specific spending ledgers remain enforced. A create
command reconnects existing ownership and does not transfer another player's bot.

## Skills and decision loop

The agent observes real health, hunger, carried inventory, nearby resources,
entities, crafting options and the assigned source chest. It proposes one
validated action, executes through Mineflayer and native permission checks,
records the actual result, then plans again. A failed precondition becomes new
information for the next decision. Ordinary building geometry executes locally from one build action; redstone components can be planned separately.

| Tool | Receiving behavior |
| --- | --- |
| Move / observe | Short reachable moves; fresh world and inventory observations |
| Gather | Natural resources and mature crops; suitable carried tools and real drops |
| Craft | Available vanilla recipes, real ingredients and a table when required |
| Build | Checked house, tower, bridge, wall, stairs or arch geometry; real block consumption |
| Place / activate | Carried blocks and redstone components; actual placed and activated states |
| Eat / equip | Carried food, equipment and observed hunger |
| Hunt | Nearby livestock only; no player, villager, agent or pet targets |
| Smelt | Empty observed furnace, actual input/fuel and collected output |
| Chest transfer | Deposit actual carried items; withdraw only from the registered source chest |

Buildings are currently bounded to 8 × 6 × 8 and 256 blocks per build action.
Gathering searches loaded terrain within 24 blocks, up to 32 requested items.
Movement is limited to 64 blocks per decision; agents may explore with several
decisions. A run pauses after 20 decisions, on logout, cancellation, unavailable
inference budget or an uncertain effect. Resume uses the saved objective and
fresh observations. There is no paid inference loop while the agent is idle.

The agent may craft prerequisite tools, seek supplies and adjust after a failed
tool. It cannot execute arbitrary code, grant materials, teleport, issue admin
commands or authorize payments. Native active-work locks bind the registered
agent to its actual approved owner and a bounded work area.

## Honesty and recovery

An action is recorded before its effect and receipted afterward. A crash or
disconnect between those points preserves the pending record and blocks an
automatic replay. Completed work remains in history. The model can request
owner review after observed work; it does not establish independent acceptance.

The primitive tools do not establish that every Minecraft task is supported.
Complex redstone orientation/timing, large builds, hostile combat, breeding,
fishing, enchanting and arbitrary recipes still require representative testing
or additional skills. Missing materials and absent natural resources are real
blockers, not reasons to invent stock. Public/independent-human release gates
remain separate from this laptop implementation and controlled local tests.

## Verification

```
node tests/playable/survival.mjs
node tests/playable/mumbai-agents.mjs
python3 scripts/build_plugin.py
python3 scripts/mumbai_city_host.py isolate
node tests/maps/mumbai-city-visit.mjs
```

The native check uses an isolated city copy and labelled controlled clients. It
checks shared Survival container access, actual crafting, material-consuming
building, a powered lever, city mining and the existing marketplace custody flow.
It sends no chain transactions or model calls. The separate
`tests/playable/survival-model-live.mjs` probe uses existing paid budgets for one
structured craft decision per provider on disclosed fixture observations. It
does not claim real agent execution. Actual owner-issued objectives are the
final local gameplay check.

0G uses a flat tool-selection request followed by that tool’s required arguments;
Claude uses its structured tool schema directly. Both paths pass the same
receiving validator. This avoids the nested-schema decoding failures recorded
during the actual 0G probe; it does not relax tool or payment permissions.

Navigation uses the existing cardinal-alignment walker with diagonal clipping
disabled. Three consecutive path failures pause inference even when proposed
waypoints differ. The original real owner task and its empty effect history
were retained during the bank-exit repair; the navigation-only recovery reached
the registered source chest without model calls or material movement. Budget
limits still apply before each request; a saved objective does not override them.

## Verified owner task — 6 November 2026

Both real provider-specific agents completed the actual approved owner goal:
withdraw two oak planks, craft four sticks and deposit all four into their
registered destination chest. 0G used the new native owner-issued request;
Claude continued its original saved request after the navigation fix and the
explicit laptop allowance amendment to $1 total. Their three material-effect
receipts are retained, with no pending effect or remaining task lock.

- CityAgent4 / 0G output: X 1730, Y 69, Z 2812.
- CityAgent5 / Claude output: X 1746, Y 69, Z 2812.

Evidence: `evidence/runs/survival-owner-completed/d30f6732-fb3e-4608-a2d9-be29a2066ad2/report.json`.
No CITY, wallet signing or material grants were used. This establishes this
small owner-driven crafting/delivery flow, not every Minecraft skill, a fair
provider benchmark or the original independent-human production gates.
