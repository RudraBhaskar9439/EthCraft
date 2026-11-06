# Mumbai Survival and objective agents

Mumbai now runs Survival rather than the protected sightseeing mode. Every
Discord-approved player may mine, build and use ordinary containers throughout
the mapped city. There is no work-plot membership requirement. Existing worlds,
inventories, receipts and wallet budgets stay in place. The museum, login gate,
financial custody and short locks around active agent work retain their guards.
Normal damage, mobs, crop growth, drops, weather and day/night cycles are enabled.
Zombies and their variants are disabled in Mumbai at the owner's request; saved
zombies are removed when their chunks load. Other mobs remain enabled.
PvP remains disabled. No city blocks are automatically listed for token sales.
Completed UniRock construction stays editable across restarts; installation and
migration still validate their original world/template bindings.
Service bots resist damage and hostile targeting inside UniRock, and bank blocks
resist entity explosions. Outdoor work retains normal Survival damage. Humans
can still mine and build in the bank. Agent arrival uses adjacent solid ground
when an edited concierge pad is no longer walkable.

## Commands

Keep Minecraft connected and approve that connection with Discord `/join`.

```
/agent agent create
/agent 0g create
/agent agent task Gather wood, craft the tools you need, and build a small house.
/agent 0g task Find nearby food and collect it. Cook it if supplies allow.
/agent agent task Make a lever-operated redstone lamp using available materials.
/agent agent status
/agent agent inspect
/agent agent wait
/agent agent task resume
/agent agent purchases off
```

Replace `agent` with `0g` for either provider. Both use the same receiving tools;
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
| Purchase | Buy up to 32 stocked materials through the backend's standing owner permission; deliver only after canonical payment/redemption and a native receipt |
| Blueprint | Read the pinned calculator material bill and relative block states; no construction or circuit-verification claim |

Buildings are currently bounded to 8 × 6 × 8 and 256 blocks per build action.
Gathering searches loaded terrain within 24 blocks, up to 32 requested items.
Movement is limited to 64 blocks per decision; agents may explore with several
decisions. Agent pauses after 60 decisions and 0G after 20, or on logout, cancellation, unavailable
inference budget or an uncertain effect. Agent retains a bounded working plan and
up to 40 compact observed results, alongside six recent full results. Memory never
grants authority. Resume uses the saved objective and
fresh observations. There is no paid inference loop while the agent is idle.

The agent may craft prerequisite tools, seek supplies and adjust after a failed
tool. It cannot execute arbitrary code, grant materials, teleport, issue admin
commands or authorize payments itself. Native active-work locks bind the registered
agent to its actual approved owner and a bounded work area.

## Honesty and recovery

An action is recorded before its effect and receipted afterward. A crash or
disconnect between those points preserves the pending record and blocks an
automatic replay. Completed work remains in history. The model can request
owner review after observed work; it does not establish independent acceptance.
Purchases have a separate durable order and can reconcile that same order on
`task resume`; the agent must not pay again or replace an uncertain order.

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
The unarmed tool fixture removes nearby hostiles only in its owned isolated copy;
this does not qualify hostile combat or change live non-zombie Survival rules.
It sends no chain transactions or model calls. The separate
`tests/playable/survival-model-live.mjs` probe uses existing paid budgets for one
structured craft decision per provider on disclosed fixture observations. It
does not claim real agent execution. Actual owner-issued objectives are the
final local gameplay check.

0G uses a flat tool-selection request followed by that tool’s required arguments;
Agent uses its structured tool schema directly. Both paths pass the same
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
Agent continued its original saved request after the navigation fix and the
explicit laptop allowance amendment to $1 total. Their three material-effect
receipts are retained, with no pending effect or remaining task lock.

- CityAgent4 / 0G output: X 1730, Y 69, Z 2812.
- CityAgent5 / Agent output: X 1746, Y 69, Z 2812.

Evidence: `evidence/runs/survival-owner-completed/d30f6732-fb3e-4608-a2d9-be29a2066ad2/report.json`.
No CITY, wallet signing or material grants were used. This establishes this
small owner-driven crafting/delivery flow, not every Minecraft skill, a fair
provider benchmark or the original independent-human production gates.

## Agent planning upgrade

The Agent advanced-compute profile uses API-verified
adaptive thinking and high effort, up to 16,384 output tokens and 60 decisions
per objective. The approved cumulative laptop spending cap is $25, including
every earlier request; usage, reservations and receipts are not reset. Missing
capabilities fail closed instead of silently disabling reasoning. The 0G
profile remains at its existing token/decision limits and $5 allowance.

These settings allow deeper planning and longer tasks. They do not add tools,
remove receiving validation, authorize wallet spending or guarantee correctness
on every objective. Three navigation failures still pause paid planning.

## Automatic material purchases

On 6 November the actual owner authorized both agents to buy testnet materials
using the existing AgentCity-managed Privy game wallet, with **no cumulative
CITY cap**. This permission is stored privately in
`.local/mumbai/agent-purchase-policy.json`; it binds the owner, current wallet,
CityAgent4/5, server and current deployment. It is separate from the $25 Agent
budget and cannot be granted or changed by a model.

The backend verifies the approved owner session, saved objective, exact quote,
owned recipient, Unichain Sepolia 1301 and wallet binding before consenting. It
retains the existing maximum 1 CITY and 0.00009 test ETH allowance per order,
the managed cumulative gas allowance and real balance checks. The eight-item
catalog and merchant inventory stay finite. There is no automatic faucet,
top-up, mint, swap, mainnet payment or transfer from an external wallet.

Use `/agent agent purchases off` (or the 0G prefix) to disable new purchases for
**both** agents. Already paid orders remain recoverable. Restarting a task does
not erase an order or create new consent. Agent orders stay outside the human
shop collection screen; their exact items go to the registered agent's inventory.
If a wallet has insufficient funds or the merchant lacks stock, the agent must
adapt using available supplies or report the blocker. Unlimited permission cannot
create CITY, test ETH or materials.

Focused checks:

```
node tests/playable/agent-shop.mjs
node tests/playable/inventory-shop-game.mjs
node tests/inference/anthropic.mjs
node tests/playable/survival.mjs
```

The calculator tool supplies the validated 144-block plan and material bill.
The shop does not currently stock all redstone components. Higher token limits
alone do not prove a newly built calculator, food collection or arbitrary Survival
behavior works. Real delegated paid delivery requires the owner's approved online
session; fixture tests and an isolated recipient guard check do not replace it.


## Adaptive compute and 0G assessment

The public workers are **Agent** and **0G**. `/agent agent task <objective>`
starts Agent; `/agent 0g task <objective>` starts the 0G worker. Legacy aliases
and private provider identifiers stay compatible with existing saves.

Routine decisions use 0G's Qwen3.5-35B-A3B with up to 1,536 output tokens.
Circuit reasoning, danger, failed tools and periodic complex-plan refreshes use
advanced compute. Agent uses its configured advanced provider, up to 16,384
output tokens for circuit reasoning; 0G stays on its configured GLM-4.7 provider.
Two invalid economy responses escalate the objective. Economy transport failures
fall back to advanced compute; Agent can also do this if the shared 0G budget is
exhausted. Saved goals, working plans, observations and compact tool results
survive model changes. Idle workers make no inference calls.

On proposed completion, GLM-4.7 assesses receiving-tool receipts and a fresh
observation, using up to 3,072 output tokens. A concrete `needs_changes` verdict
allows one bounded correction cycle. The final result remains `ready_for_review`;
only the owner accepts work. `/agent agent review` and `/agent 0g review` request
an advisory assessment of the latest stopped objective. Reviews cannot grant
spending authority or accept work. Missing evidence is reported as such.

Both economy models and assessments share the original cumulative **$5 0G**
ledger. Agent's advanced compute retains the cumulative **$25** laptop ledger.
Existing unknown reservations remain reserved. A router cannot bypass either
budget. Per-request routing and assessment attempts are durably recorded.

Focused checks: `node tests/playable/adaptive-planner.mjs`. The explicit
`node tests/playable/adaptive-model-live.mjs --run` probe uses real APIs on
labelled fixture observations; it executes no game actions or purchases.
