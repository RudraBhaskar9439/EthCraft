<aside>
🔬

Research design paper — Version 3. This is a mechanism-level analysis of the proposed AgentCity system, not a report of a working implementation. Official documentation establishes infrastructure capabilities; economic examples and system models are our derivations. Hypotheses remain untested. Research reviewed: October 29, 2026.

</aside>

# Abstract

AgentCity investigates whether useful work inside a persistent game world can be organized as an accountable service economy. A requester commissions a build, an independently operated builder and agent produce it, a resource market supplies the inputs, a deterministic checker evaluates functionality, and an explicit acceptance action settles the labor reward. The first experiment is a redstone calculator supporting all 16 combinations of two inputs in the range 0–3.

The proposed system combines 0G-hosted model inference, Arkiv marketplace records and a Uniswap v4 material-voucher market. Its research interest lies in the relationship between these mechanisms: agent decisions consume resources; resource prices affect feasible jobs; inspection exposes execution failures; and reported game-service conditions constrain trading through a hook.

The central argument is that AgentCity should be understood as a coordinated institution spanning a game server and several external systems. Tokenization creates obligations, inference proposes actions, market prices allocate scarce inventory, and contracts enforce selected settlement rules. None of these components independently proves that an in-game build is correct or that a warehouse report is truthful.

This paper explains those mechanisms, examines participant incentives and failure cases, defines module boundaries, and proposes experiments that could support or reject the design. No claim of lower cost, higher reliability, economic sustainability or sponsor eligibility is established without those experiments.

# 1. Research question, method and contribution

## 1.1 The problem being studied

A Minecraft player may value a calculator, farm or piece of infrastructure without possessing the knowledge or time to build it. Another player may possess that expertise and operate a construction bot. Matching them is only the first problem. They must also agree on the result, obtain inputs, coordinate actions, detect failure and decide when payment is justified.

AgentCity asks: **Can a bounded agent-assisted workflow reduce the coordination cost of commissioning functional in-world work while keeping resources, acceptance and payment legible to participants?**

A working prototype would answer a narrower question than “Can AI build anything?” It would show whether one supported service can complete a coherent economic and technical lifecycle.

## 1.2 Research questions

| ID | Question | Evidence that would answer it |
| --- | --- | --- |
| RQ1 | What value does model-based decision-making add beyond a fixed blueprint script? | Controlled comparisons on interruptions, request interpretation and repairs |
| RQ2 | Can an inventory-backed voucher support useful resource exchange? | Backing reconciliation, actual procurement, delivery and supplier behavior |
| RQ3 | How do liquidity and demand affect job affordability? | Quote curves, executed trades and budget-failure rates |
| RQ4 | Can a hook reduce purchases made during known service outages? | Compared outage scenarios with and without the hook |
| RQ5 | Can independently controlled participants coordinate through shared records? | Separate publications, discovery and authorized agreements |
| RQ6 | Does inspection plus requester acceptance provide adequate settlement incentives? | Payment outcomes and analysis of rejection/timeout behavior |
| RQ7 | Can the workflow recover without duplicating obligations or assets? | Deliberate crash, retry and inconsistent-state experiments |

## 1.3 Method and evidence boundaries

The method combines primary-source technical review, explicit mechanism design, illustrative accounting models and a proposed prototype evaluation. It is not a market-size study, user-demand validation or empirical performance paper.

The document uses three kinds of statement:

- **Documented mechanism:** a capability described by an official protocol or software source.
- **AgentCity proposal:** a design choice we must implement and validate.
- **Analytical implication:** a consequence derived under stated assumptions, not an observed result.

Current documentation can describe a feature without establishing its availability for our chosen model, provider, network or pool. Deployment addresses, exact model selection, credit requirements and routing support remain verification tasks.

## 1.4 Intended contribution and counterfactual

The intended contribution is an integrated commissioning process with visible material consumption, actual functional testing and accountable settlement. It is not a claim that jobs, Minecraft bots, token markets or escrow are new individually.

A centralized job board, fixed-price material shop and scripted builder are the baseline alternatives. If those alternatives produce the same experience with less overhead, the additional infrastructure needs a defensible benefit: independent publication, external token composability, enforceable pool-specific rules or improved exception handling. Sponsor inclusion alone is not evidence of benefit.

# 2. Economic actors, assets and core goals

## 2.1 Participants and their incentives

| Actor | What they supply or seek | Main incentive | Main exposure |
| --- | --- | --- | --- |
| Requester | Demand for a functional build | Useful result at acceptable total cost | Non-delivery, confusing terms, material loss |
| Builder/operator | Expertise, coordination and controlled agent execution | Labor reward and discoverable work history | Repair costs and requester refusal |
| Contributor | A bounded part of a team job | Fixed approved allocation | Team dependency and departure conflicts |
| Supplier | Locked material bundles | Net proceeds from selling backed KIT | Assembly cost, slow sales, custody dependence |
| Liquidity provider | CRED and/or KIT capital across price ranges | Trading fees | Inventory-price exposure and idle capital |
| Server operator | World, warehouse, checker and coordination services | A working service; any revenue policy must be explicit | Operating cost, incident liability and trust |
| Compute provider | Model inference through 0G | Usage-based compensation | Compute cost and service reliability |

These roles are distinct even when one demonstrator performs several. A supplier can sell KIT without being the pool's liquidity provider. An LP can acquire already issued KIT without personally gathering blocks.

## 2.2 Assets and obligations

**CRED** is the proposed demonstration spending token. **KIT** is a transferable voucher redeemable for one precisely defined calculator-material bundle. A **job agreement** is a specific service commitment. A **delivery claim** is an obligation created by burning KIT for a designated destination.

These are different economic objects. A custom calculator commission is not interchangeable with every other build. An approved KIT unit must be interchangeable with another KIT unit of the same definition and redemption promise.

CRED has no assumed dollar peg or external redemption value. KIT is backed by goods, not by a promise to return a fixed amount of CRED. The distinction is essential when discussing prices or refunds.

## 2.3 Goals and the narrow experimental scope

The core goals are understandable commissioning, independent discovery, explicit agreements, meaningful procurement, useful bounded decisions, functional inspection, recoverable execution and one-time settlement.

The first complete experiment uses one server/version, one protected plot, one blueprint, one kit definition, one pool, one settlement chain, one requester and one builder with a bot. Team records support fixed allocations, but unrestricted collaboration is not required for the first result.

An observed end-to-end run should contain: published request → independent offer → approved funded agreement → actual purchase → redeemed and consumed resources → visible construction → detected fault → repair → passing report → explicit acceptance → reward claim.

# 3. System logic: connecting intention, resources, action and settlement

## 3.1 The causal chain

A job begins as an intention. It becomes executable only after the requested behavior maps to a supported template, participants approve its conditions, required resources become available and an authorized actor receives a task.

Construction changes the world. Inspection reads that changed world and compares it with the agreed behavior. Acceptance authorizes settlement. Marketplace records make relevant parts discoverable, while operational journals connect asynchronous actions.

This ordering prevents several category errors: a model's plan is not construction; a swap is not delivery; delivery is not a passing build; a pass is not requester acceptance.

## 3.2 A formal model of bounded agency

Let S_t denote the actual world and workflow state at time t. The agent receives a bounded observation O_t: relevant blocks, inventory, task status, agreement version and inspection evidence. The observation can be incomplete or stale.

The model proposes an action a_t from an application-defined tool set. A deterministic policy checks whether the action belongs to the permitted set A(O_t, agreement, actor). Only then can an executor apply it. The world transition produces a receipt and a new observation.

This is a partially observed control problem in the ordinary sense that the model does not see the entire live world. AgentCity does not require implementing a particular reinforcement-learning algorithm. Its initial policy is a prompted model combined with deterministic guards and a known blueprint.

The design objective is higher successful completion with lower coordination effort and bounded cost. It is a hypothesis about behavior, not a guarantee that the model optimizes a formal objective.

## 3.3 Three loops with different responsibilities

| Loop | Main question | Authority |
| --- | --- | --- |
| Decision loop | What permitted task should happen next? | Model proposes; policy validates |
| Resource loop | Are the inputs available, affordable and delivered? | Inventory evidence and contracts |
| Acceptance loop | Does the result meet the agreed behavior, and is it accepted? | Checker plus requester plus escrow |

These loops influence one another. A price increase can pause procurement. Missing stock can change the next agent task. A failed test can initiate repair. None gives the model authority over another participant's reward.

## 3.4 Three ledgers and consistency

The game ledger describes blocks, item custody and structural revisions. The operational ledger describes tasks, requests, receipts and retries. The settlement ledger describes token balances, claims and payment rights. Arkiv supplies owned discovery records and references across these domains.

A successful chain transaction can precede a failed game action. Therefore the integration behaves as a sequence of recoverable steps rather than one transaction. Every crossing requires a stable operation identity, a completion condition and a rule for uncertainty.

If materials may already have been delivered but the backend lacks a receipt, blindly repeating the command is unsafe. The correct next operation is reconciliation using the plugin journal and inventory evidence.

# 4. How 0G works, and what the decision model actually does

## 4.1 Separate the network, provider, model and agent

0G Compute is infrastructure for obtaining model inference. Its architecture separates service providers, client interfaces and payment/verification mechanisms. An application requests execution of a model; it does not automatically receive a Minecraft agent, an action policy or a verifier. 0G Compute overview

For AgentCity, four terms must remain distinct:

| Term | Meaning in this design |
| --- | --- |
| 0G Compute | The infrastructure through which we access inference |
| Provider | The service handling a supported model request |
| Model | The selected language/reasoning model producing the response |
| Agent | Our software loop combining observations, model proposals, permission checks and execution |

Selecting a model through 0G does not train it on our world. The initial application supplies relevant context at inference time; fine-tuning is not part of the first scope.

## 4.2 The two integration paths

0G documents a Router path with an API key, automatic provider management and one billing balance, and a Direct path with explicit provider selection and per-provider funding. They are different accounting arrangements; a balance funded in one does not automatically fund the other. Router versus Direct

| Dimension | Router | Direct |
| --- | --- | --- |
| Application relationship | Backend calls a common gateway | Application uses provider-oriented SDK flow |
| Provider management | Routing and failover handled by gateway | Application chooses/manages provider |
| Funding | Unified Router/payment-layer balance | Provider sub-accounts |
| AgentCity fit | Simpler initial server-side integration | Useful when provider-level control is required |

**Proposal:** benchmark the Router first for the backend decision loop. Choose Direct only for a concrete control or eligibility requirement. Neither choice changes who controls the Minecraft world.

The Router exposes a familiar chat-completion interface and manages discovery, authentication and failover. Network environments and their keys/balances are separate. We must configure the actual environment rather than treating any funded wallet as sufficient. Router overview

## 4.3 One request through the proposed system

Consider a calculator that fails six high-carry cases.

1. The checker creates a factual case table and pins the build revision.
2. The backend adds the relevant blueprint segment, observed blocks, available resources and allowed tools.
3. The inference adapter authenticates to the chosen 0G interface and requests the selected model.
4. In Router mode, routing selects an eligible provider. The documented default chooses a healthy provider and can try another on failure; optional policies can favor price, latency or a pinned provider. Provider routing
5. The model returns a structured proposal, such as inspecting the carry-path region.
6. The backend validates schema, evidence references, actor, revision, region and task permissions.
7. A deterministic executor obtains fresh observations or performs an authorized repair.
8. The new result becomes feedback. The checker, not the model, reruns the functional tests.

The LLM sees a representation of the circuit. It does not directly inhabit the game or access inventories unless our tools expose observations and execution.

## 4.4 Decision representation and supported actions

A decision record should identify job, task, observed revision, selected action, parameters, evidence references and a short rationale. A request to repair without an identified region or approved operation is incomplete.

0G's chat interface documents tool calling and JSON-style output for models advertising those capabilities. Feature availability is model-specific and must be checked rather than inferred from the gateway's overall interface. Chat completions and model capabilities

For this prototype, useful decisions include mapping a request to the calculator template, selecting an unblocked construction stage, waiting for materials, assigning a non-conflicting task and proposing an evidence-based repair.

Arithmetic, token caps, role permissions, block placement routines and all 16 test expectations remain deterministic. Having the model recompute rules already known by code adds failure opportunities without an established benefit.

## 4.5 Payment and inference cost

Router billing is usage-based: input and output token counts are multiplied by their respective declared prices. Full context contributes to input usage, so repeatedly sending long histories has a cost. The documented Router balance and usage records should be used for accounting; live model rates must be obtained at implementation time. Deposits and billing

An AgentCity cost model is:

$$
C_{AI}=\sum_{j=1}^{n}(I_jp_{in,j}+O_jp_{out,j})
$$

I_j and O_j are measured input/output tokens; prices use a consistent unit. Add separately any funding-transaction costs and application overhead. This is an accounting identity, not a price estimate.

The economic implication is to invoke inference at meaningful decision boundaries. A known 500-placement stage need not incur 500 model calls. Summarized observations, bounded output and deterministic stage execution should be compared experimentally with more frequent prompting.

In Direct mode, documentation describes provider sub-accounts and accumulated fee settlement; an apparently unchanged balance is not proof that requests were free. Those Direct mechanics must not be copied wholesale into Router accounting. Direct inference and settlement

## 4.6 What verification establishes

The documented trust paths differ. TeeML places model execution inside a trusted execution environment. TeeTLS attests an authenticated relay to an upstream model service; it does not establish that the upstream model ran inside the relay's enclave. Standard access should not be assumed to provide an attested response. 0G trust-mode explanation, Privacy and trust modes

A routing or execution attestation is not proof that the model's answer is correct, its plan is safe or a calculator passed inspection. Those are application-level claims requiring separate evidence.

The Router also documents an optional verification result. Its returned verified flag represents the Router's verification assertion; independent checking is a stronger and separate procedure. Verifiable execution

**Evidence qualification:** broad statements on some overview pages describe all providers as attested, while more detailed trust-mode documentation distinguishes standard routes without a verifiable proof. AgentCity should use the narrower claim: explicitly select the required trust mode and inspect the actual returned evidence. Do not infer guarantees from a model name or an overview slogan.

## 4.7 Failure and accountability

Failover improves availability only if another eligible provider can serve the selected model under our constraints. A temporary provider outage must become a paused decision, not fabricated progress or silent use of an unrelated model.

Record model/provider, request identity, policy outcome, action receipt and cost. Exclude private keys and unnecessary player data from prompts. If we require a trust property, configure it explicitly and treat absent/failed evidence according to that policy.

The strongest initial test of 0G's role is a perturbation: give the agent a missing material, a blocked stage or a failed test and observe whether its next permitted action improves completion relative to a simple scripted baseline.

# 5. Resource tokenization and market dynamics

## 5.1 Why a standardized voucher is the market asset

The player wants blocks, but a Uniswap pool exchanges onchain assets. AgentCity therefore needs a redemption promise between a transferable token and a defined bundle of game items.

A KIT unit should specify item types, quantities, server/world scope, permitted delivery destination and any fulfillment conditions. Two KIT units are economically interchangeable only if those promises match. A unique house or bespoke commission belongs in the job market rather than being treated as an identical material unit.

The bridge is institutional: the server controls stock and an authorized issuer recognizes deposits. A hook can enforce a trading condition, but token issuance and custody create the backing relationship.

## 5.2 Backing and conservation

Let I_i be locked warehouse inventory of item i; q_i the quantity of that item in one KIT; U the outstanding KIT supply; and Q the kit-equivalent quantity burned into undelivered claims.

The proposed backing requirement is:

$$
I_i \geq q_i(U+Q)\quad\text{for every required item }i
$$

This is our accounting condition, not a protocol guarantee. U includes KIT held in wallets and in the pool; pool inventory must not be counted again. Fractional tokens contribute proportionally to outstanding obligations even though redemption requires whole kits.

Issuance increases U only after new stock is locked. Burning a KIT decreases U and increases Q by the same amount until delivery. Successful delivery reduces the relevant stock and Q together. A mint without a locked deposit or a second delivery of the same claim breaks this accounting.

The bottleneck matters: abundant stone does not compensate for missing redstone. Reconciliation must check each ingredient, not the total number of items.

## 5.3 Three distinct quantities: stock, vouchers and liquidity

| Quantity | What it measures | What it does not establish |
| --- | --- | --- |
| Warehouse stock | Materials available to fulfill obligations | An executable market quote |
| Outstanding KIT | Claims represented by transferable vouchers | KIT currently offered by the pool |
| Active pool liquidity | Ability to exchange assets near the current price | Total goods held in the warehouse |

A warehouse can be fully backed while trading is expensive because few tokens are actively available in the pool. Conversely, a liquid pool can trade an inadequately backed token. These are separate failure modes.

A deposit or redemption does not automatically change pool reserves. A supplier's sale, requester's purchase, or liquidity change does. The market observes trade flow; it does not continuously inspect the world.

## 5.4 How the price emerges

Uniswap's AMM mechanism exchanges against supplied liquidity rather than matching a discrete seller for each purchase. Reserves and active liquidity determine the execution curve. How Uniswap works

The initial price is a design input selected when the pool is initialized and funded. It is not proof of a fair or discovered price. Continued independent trading can change it.

For intuition, use an idealized constant-product model with x units of CRED, y units of KIT and k = xy. Buying q KIT, ignoring fees and rounding, requires:

$$
\Delta x=\frac{xy}{y-q}-x=\frac{xq}{y-q},\quad 0<q<y
$$

This derivation uses the textbook constant-product relationship described in Uniswap's early design. It is an explanatory model, not our final v4 quote engine. Uniswap v2 whitepaper

## 5.5 Worked example: why depth matters

**Illustrative calculation only:** start with x = 1,000 CRED and y = 100 KIT. The starting marginal ratio is 10 CRED/KIT. This scale is independent of the earlier 10 CRED job-budget example.

| Purchase | Total CRED required | Average CRED per KIT | Marginal ratio after trade |
| --- | --- | --- | --- |
| 1 KIT | 10.1010 | 10.1010 | 10.2030 |
| 10 KIT | 111.1111 | 11.1111 | 12.3457 |
| 20 KIT | 250.0000 | 12.5000 | 15.6250 |

The calculation excludes fees, gas, rounding, intervening trades and concentrated-range boundaries. It demonstrates why a displayed starting price cannot be multiplied by a large quantity to obtain the executed cost.

Under the same idealization, a cap b permits at most q = by/(x+b) KIT. This is an algebraic feasibility bound, not an instruction to execute that quantity on a live v4 pool.

## 5.6 What changes in v4 concentrated liquidity

V4 retains concentrated-liquidity behavior: providers select ranges, and only currently active liquidity supplies local depth. Positions outside their ranges stop supplying active liquidity and earning ordinary swap fees until price reenters. Concentrated liquidity

The constant-product intuition applies through virtual reserves within an active interval; actual quotes must account for ranges, tick crossings, fees and rounding. Dividing the pool's aggregate token balances is not a sufficient v4 pricing algorithm. Uniswap v3 core paper, concentrated-liquidity model

For the prototype, use a deliberately chosen and disclosed liquidity configuration and test the intended route. A large token allocation sitting outside the trading range does not solve immediate procurement failure.

## 5.7 Demand and supply in the game

**Demand** comes from jobs requiring kits, players holding vouchers for future projects and potentially speculative trading. Only some demand produces useful construction. Token turnover by itself is not a measure of player value.

**Supply** comes from gathering or manufacturing the defined items, depositing them in custody, obtaining issuance and selling or supplying the resulting KIT. More warehouse stock affects price only when it leads to additional tokens available for trade.

A supplier participates when expected net sale proceeds justify gathering/assembly cost, issuance and trading expenses, time and custody exposure. This is a proposed incentive condition, not observed behavior.

| Game event | First-order implication | Necessary qualification |
| --- | --- | --- |
| More calculator commissions | More potential kit demand | Jobs must actually authorize purchases |
| More suppliers deposit and sell KIT | More token supply offered into the market | Backing and issuance must be valid |
| LP removes active liquidity | Worse depth for a given trade | Warehouse backing can remain unchanged |
| Delivery reliability falls | Voucher utility can decline | Price response depends on trading and restrictions |
| Bots build faster | Lower construction time may increase job demand | The fixed blueprint still consumes its defined materials |
| Operator injects free materials/CRED | Alters scarcity or spending power | Must be disclosed; cannot be presented as organic equilibrium |

If blocks are effectively unlimited through administrative minting, material gathering cost is not the claimed scarce resource. The server's economic rules must be explicit.

## 5.8 Backing does not create a price peg

One KIT promises materials, not a fixed CRED payout. Its market price can differ from the cost of assembling the materials because of convenience, scarcity, time, perceived fulfillment quality and trading depth.

If the market price rises above supplier cost, additional suppliers may find issuance and sale attractive. This is a source of supply pressure, not an instantaneous guaranteed price ceiling.

If KIT trades below the holder's value for the bundle, buying and redeeming may be attractive. It is not automatically risk-free arbitrage: the holder needs a way to realize value, delivery must work, and fees/time matter. Without a reverse material-to-CRED exit at a reliable price, no hard CRED floor exists.

## 5.9 Suppliers and liquidity providers earn differently

A supplier can earn by selling issued KIT above their all-in acquisition and operating cost. An LP earns trading fees while carrying a changing mix of assets.

Swap fees compensate active liquidity, but fee income is not the same as net profit. Uniswap fee mechanics

An LP can underperform simply holding the initial assets as relative prices change; concentrated positions also face range and rebalancing choices. This exposure is part of AMM participation, not a guaranteed yield. Uniswap v2 discussion of LP exposure

In this application, an LP additionally bears the quality of KIT's redemption promise. If the warehouse fails, holding more KIT may be economically worse even though token accounting remains valid.

## 5.10 Price impact, slippage and procurement policy

Price impact is the movement caused by our trade along available liquidity. Slippage is the difference caused by changes between quoting and execution. The purchase must enforce a maximum input for the required output and an expiry; a quote alone is not a spending guard. Swap execution and protections

The initial procurement policy is requester-signed purchase of one whole KIT within a fixed cap. Labor escrow is separate. A rising price pauses procurement rather than silently reducing the builder's reward or consuming unallocated funds.

Do not use a thin-pool spot price to determine compensation, reputation or warehouse solvency. The prototype needs an executable bounded quote, not a price oracle governing unrelated decisions.

## 5.11 Sustainability and cold start

The market needs initial KIT, CRED, active liquidity and useful demand. Seeded capital makes a demonstration possible but does not prove that independent suppliers or LPs would remain.

Measure total cost per accepted job, supplier proceeds after costs, useful redemptions, active depth, failed quotes and subsidy consumption. A plausible long-term system must explain who pays for inference, hosting, inspection, publishing and recovery.

For the prototype, openly subsidizing these costs is reasonable. Treating that subsidy as evidence of a self-sustaining economy would be misleading.

# 6. Game-state hooks: market policy under delayed information

## 6.1 What a hook contributes

A v4 hook is a contract attached to a pool at creation that can run at specified callbacks, including before or after swaps. Hooks are optional. Their role is to customize pool behavior, not to observe an external game directly. Uniswap v4 hook mechanism

AgentCity's proposed connection is:

**Observed service condition → authorized onchain report → deterministic hook rule → allow or reject a pool action.**

The registry and publisher provide information. The hook applies a market policy. Tokenization, backing and delivery remain separate mechanisms.

## 6.2 Initial rule and state representation

The initial proposal is a purchase-availability gate. A report contains server/market identity, increasing sequence, delivery availability, submission time and bounded validity. Only an authorized publisher can update it.

The beforeSwap callback verifies the expected PoolManager/pool and determines whether the trade buys KIT with CRED. A purchase is allowed only when the configured report is available and unexpired. The intended sell direction and liquidity removal are not blocked by this purchase gate.

The rule is deliberately deterministic. There is no model inference inside the swap callback. The model cannot tell the hook to ignore a stale report.

## 6.3 Information delay and freshness

An outage must first be observed, then reported, then included onchain. Until the update becomes effective, an older healthy report may still permit purchases. Expiration limits how long an unrefreshed report remains usable, but it does not create instant outage detection.

A shorter validity interval reduces stale exposure while requiring more frequent successful updates. A longer interval lowers refresh pressure while allowing older information to govern trades. Choose it through measured detection/publication delay and cost, not an invented claim of real-time synchronization.

The publisher can also misreport. Sequence numbers stop replay of old updates; they do not establish the truth of a new update.

## 6.4 Asymmetric restrictions and LP exposure

A purchase-only pause helps prevent new users acquiring KIT through our designated pool during reported outages. It is not economically neutral.

If KIT holders can still sell, the pool may exchange its remaining CRED for more KIT while delivery is impaired. LPs can become more exposed to the uncertain asset. If both trade directions are paused, holders lose that exit through the pool. Neither policy repairs missing stock.

| Policy | Potential benefit | Main cost |
| --- | --- | --- |
| Pause purchases only | Limits new acquisition through this pool; preserves sale direction | LPs may absorb risky KIT |
| Pause both directions | Stops outage-period exchange through this pool | Restricts holder exit and price discovery |
| Add state-dependent fee | Keeps trading while changing execution cost | Cannot guarantee fulfillment or eliminate LP losses |

The first is the working prototype proposal, not a proven optimal design. The evaluation should measure who bears the resulting exposure and explain the rule to participants before they provide liquidity.

Restrictions apply to this pool. Another market or direct token transfer may exist. Existing redemption claims must retain their obligations outside the swap rule.

## 6.5 Dynamic fees as a later hypothesis

V4 supports hook-managed dynamic LP fees, distinct from custom hook fees or protocol fees. Changing an LP fee does not automatically fund AgentCity's warehouse or compensate affected requesters. Dynamic-fee mechanics

A later experiment could relate fees to measured congestion or service risk, but the causal rationale matters. Higher fees may suppress demand without fixing delivery capacity; lower fees may increase procurement volume while the warehouse is already overloaded.

The first experiment should isolate the availability gate. Adding multiple adaptive policies simultaneously would make it harder to identify why completion improved or worsened.

# 7. Arkiv as the information institution

## 7.1 How the record layer works

Arkiv stores owned entities with searchable attributes and payload data. Writes use signed transactions; owners control supported modifications. Records have expiration, so a live discovery view requires retention or renewal policy. Arkiv's database engine does not support deploying our arbitrary escrow/voucher contracts. Arkiv fundamentals

AgentCity proposes profiles, agent registrations, services, jobs, independently owned offers, agreement references, milestones and completion references. Application/server namespaces distinguish our records from unrelated users of the shared database.

Queryable attributes should contain fields such as record type, supported template and job status. Longer descriptions belong in payloads or retained artifacts. The official profile pattern similarly separates query fields and descriptive content. Arkiv user-profile example

## 7.2 What independent discovery means

A meaningful experiment requires the builder to publish an offer under independent control and the requester to discover it. Having one backend write every participant's alleged identity into a payload is weaker evidence.

Arkiv supports attribute-based queries and ownership filters that can serve these discovery needs. AgentCity still defines which records are accepted and how signatures are checked. Arkiv querying documentation

A wallet field inside an entity is a claim, not ownership proof. Owner fields, verified authorizations and the linked game-account challenge determine who can act for whom.

## 7.3 Agreements and mutable records

Discovery data and settlement commitments serve different purposes. A builder may update a profile or availability, while a funded agreement must remain the exact terms the parties approved.

Retain a canonical agreement and signatures, bind its digest and critical payment fields to escrow, and use Arkiv as a discoverable reference. Do not let a later listing edit change reward recipients or a test manifest.

Expiration should remove stale discovery, not erase the only copy needed to recover money. A pending job must remain recoverable through retained agreement data, operational records and contract state even if its listing is unavailable.

## 7.4 Reputation is an inference, not a stored truth

A list of completion references can support reputation, but a wallet-owned profile can still contain exaggerated claims. Self-funded jobs and colluding participants can manufacture favorable histories.

A useful reference links requester, agreement, exact test manifest, inspection and confirmed settlement. Even then, its value depends on the trusted checker and whether the work resembles the new job.

For the first version, show evidence rather than an unexplained universal score. Future ranking should distinguish independent counterparties, repeated relationships, template relevance and paid versus merely claimed completion. These are proposed mitigations, not proven Sybil resistance.

## 7.5 Key aims of the Arkiv module

The proposed Arkiv integration has four aims:

1. **Independent discovery:** requesters can find services, and builders can find suitable work, without treating one backend's invented participant records as independent activity.
2. **Attributable proposals:** a service, offer or update has an identifiable authorized publisher.
3. **Shared context:** participants can retrieve the same agreement reference, supported template and relevant evidence.
4. **Portable work history:** another compatible client can query completed-work references under the same schema and validate their supporting evidence.

Arkiv is the information layer. Game permissions, bot execution, inspection findings and money remain authoritative in their respective systems.

## 7.6 Example starter record set

The following names and identifiers are illustrative application records, not existing entities or prescribed Arkiv SDK fields.

| Example | Publisher / authority | Important content | Main reader and use |
| --- | --- | --- | --- |
| Profile P-requester | Requester wallet | Display name and verified game-account association reference | Builders identify the commissioning participant |
| Profile P-builder | Builder wallet | Services and supported-template references | Requester evaluates available help |
| Agent A-01 | Builder/operator wallet with explicit authorization | Bot identity, owner, supported tools and service reference | Backend validates which operator may use the bot |
| Service S-calculator | Builder wallet | Calculator template version, availability and example-work links | Requester discovers a suitable builder |
| Job J-42 | Requester wallet or explicitly authorized publisher | Scope, plot reference, budget ceiling, open status and template/test versions | Builders discover and inspect the request |
| Offer O-17 | Independent builder wallet | Job reference, labor quote, availability and proposed contributor configuration | Requester compares/selects offers |
| Agreement reference G-42-v1 | Designated publisher; validity requires all required parties' signatures | Canonical digest, retained terms reference, participants and settlement contract/job reference | Backend and participants resolve the approved commitment |
| Progress event E-42-01 | Authorized builder or server role, identified by event type | Job/agreement reference, milestone and supporting receipt | UI displays attributed progress |
| Inspection reference I-42-r7 | Authorized checker/service publisher | Build revision, manifest version, report location/digest and attestation reference | Requester reviews actual test evidence |
| Completion reference C-42 | Authorized completion publisher | Accepted agreement/revision, inspection and confirmed settlement references | Future requesters inspect previous work |

Use application/server namespace, record type and schema version on every record. Add job/agreement references where applicable. Searchable attributes support filters; longer terms and evidence belong in payloads or retrievable artifacts.

Ownership of an agreement-reference entity is not unilateral authority to approve its terms. The parties' verified approvals and the funded contract commitment determine validity.

## 7.7 Starter handoffs: from publication to work

| Handoff | Sender → receiver | Record or evidence passed | Receiver's required check | Result |
| --- | --- | --- | --- | --- |
| H1 — Publish capability | Builder → marketplace readers | Profile, S-calculator and A-01 | Publisher ownership and operator authorization | A discoverable supported service |
| H2 — Publish demand | Requester → builders | J-42 | Requester authority, supported template, plot and complete proposed requirements | Builders can prepare offers |
| H3 — Submit offer | Builder → requester | O-17 referencing J-42 | Actual offer owner, price, availability and template compatibility | Requester selects a candidate |
| H4 — Agree | Requester and builder/team → agreement module | G-42-v1 plus signatures | Same canonical digest and every required approval | Agreed terms ready for funding |
| H5 — Establish funding | Escrow chain → workflow | Confirmed funding receipt matching G-42-v1 | Actual contract, chain, job, recipients and amounts | Workflow may begin authorized procurement |
| H6 — Supply resources | Procurement/redemption/plugin → workflow | Confirmed swap, claim and delivery receipt | Spending cap, claim identity and reconciled inventory | Construction task becomes eligible |
| H7 — Start agent task | Workflow → 0G adapter → policy → bot | Approved agreement, observations, task lease and action proposal | Current revision, actor, plot, stock and tool permissions | A bounded construction action executes |
| H8 — Publish evidence | Bot/checker → progress/report readers | Attributed milestones and I-42-r7 | Authorized writer and underlying game/checker evidence | Repair or requester review |
| H9 — Record completion | Requester/escrow → history publisher | Acceptance and confirmed entitlements/claims | Correct agreement/revision and actual settlement state | C-42 becomes discoverable |

H5–H7 deliberately use evidence outside Arkiv. An Arkiv payload saying “funded” or “materials delivered” must not by itself trigger construction. A published record is a handoff of information, not execution permission.

Similarly, a builder may publish “stage complete,” but only the authorized checker can supply functional results. A completion reference must distinguish accepted/claimable work from rewards actually claimed.

## 7.8 Operating rules and failure behavior

- **Authorship:** validate actual entity ownership or explicit verified authorization. A wallet address in a payload is insufficient.
- **Role-specific writes:** builders control their offers; requesters control their requests; service roles publish only their authorized event types. Do not make every shared entity writable by everyone.
- **Agreement immutability:** edits to listings do not rewrite signed or funded terms. Use a new version and required approvals.
- **Application scope:** reject records for another server, schema, job or agreement version.
- **State validation:** confirm authoritative contract/game state before executing consequential actions; discovery can be stale.
- **Idempotency:** include semantic event/operation identifiers and expected versions. Retried publication must not create a second payment or task.
- **Expiration:** renew active records before expiry under a configured policy; retain terms, signatures, claim identifiers and recovery evidence independently.
- **Disagreement:** if records conflict, pause the affected operation and reconcile with its authoritative source. Do not ask the model to invent a definitive financial state.
- **Privacy:** publish only intended marketplace information; keep keys, wallet challenges and private sessions out of public records.
- **Honest history:** link evidence and disclose shared operators. A completion count is not proven independent reputation.

## 7.9 Minimum initial setup and demonstration

Start with two independently controlled wallets, linked game accounts, publishing funds on the selected Arkiv network, one application namespace and a versioned schema. Register one operator-approved bot and one calculator service. Choose record lifetimes and a renewal worker before treating the listing as durable.

Then create J-42 and an independently published O-17. Query them from the opposite participant's client, verify ownership, collect agreement signatures and demonstrate that changing an unrelated profile cannot change the funded job.

A useful negative test publishes an offer claiming another builder's wallet in its payload. The application must reject the impersonation. A second test expires the job listing while a delivery claim is pending; recovery must still find the obligation without relying on that listing.

These exercises test the module's aims directly: independent publication, discoverability, authorized handoff and recoverability. They do not establish market demand or eliminate collusion.

# 8. Verification, incentives and payment fairness

## 8.1 Functional verification is a finite specification

For A and B in {0,1,2,3}, the manifest contains 16 expected additions. Inputs use two weighted levers each; outputs use three weighted lamps. Reset, placement, settling behavior and server version are part of the specification.

If the high carry output is permanently absent, sums of 4–6 fail: six cases fail and ten pass. This predictable fault makes a useful test fixture. Screenshots can explain it, but actual lamp readings determine the result.

Passing all 16 cases establishes the tested behavior under the manifest. It does not establish arbitrary redstone correctness, long-term availability, appearance satisfaction or performance under untested concurrent edits.

## 8.2 Inspection and settlement bind to one revision

Inspection acquires a structural lock and records agreement, test version and build revision. After a pass, keep that structure protected while the requester operates the approved controls and reviews it. Acceptance names that revision.

A structural edit invalidates readiness. If a transaction is pending, the application must not release the lock prematurely or silently substitute a newer build. A server-signed pass remains an attestation from trusted infrastructure, not a trustless world proof.

## 8.3 Why requester acceptance is understandable but incomplete

Escrow ensures that a funded reward exists and that an authorized accepted outcome can create fixed entitlements. It does not ensure that a satisfied requester will accept.

Let W be the labor reward, C_b the builder's all-in cost in a common accounting unit and alpha the probability that the work is paid. A simplified participation condition is:

$$
E[\Pi_b]=\alpha W-C_b \geq 0
$$

This is our incentive model. With illustrative W=6 and C_b=4, alpha=0.9 gives 1.4 expected margin; alpha=0.5 gives -1. These are hypothetical inputs, not measured participant behavior.

Better functional evidence can reduce disagreement, but it does not force honest acceptance. An expiry-refund policy can increase requester protection while transferring rejection risk to builders. A production design needs a deliberate answer through milestones, adjudication, bonds or another tested mechanism.

## 8.4 Team jobs and contribution allocation

A team shares one external acceptance result but has separate internal tasks. Fixed allocations are approved before funding. The lead coordinates and submits; escrow pays named contributors directly.

Block counts are a poor default measure of value: placing the final correction may matter more than placing the casing. The model can suggest coordination but cannot retrospectively decide who deserves money.

Initial funded allocations remain immutable. A departing member triggers a supported cancellation/successor process or a separately designed amendment. Partial milestones and automatic contribution scoring are outside the first implementation.

## 8.5 Materials and cancellation

Labor, purchased vouchers, pending claims and consumed items have different cancellation semantics. A rejected build does not reverse the market trade. A burned KIT remains a delivery obligation even if its job is cancelled.

The proposed ownership policy assigns purchased KIT, delivered items and the commissioned structure to the requester, with limited builder access. Unused stock returns to requester-controlled access. The agreement must adopt and enforce this policy explicitly.

Proposed labor timeout: acceptance before the contract's expiry creates contributor entitlements; otherwise expired unaccepted labor becomes refundable. Accepted but unclaimed rewards remain contributor entitlements. Acceptance and refund must be mutually exclusive.

This policy is a prototype simplification and an acknowledged incentive weakness.

# 9. Architecture and module boundaries

The following module inventory translates the research mechanism into implementation responsibilities. It retains a complete server scope while separating reasoning, custody, observation and enforcement. Several logical modules can share one process in the prototype.

## 9.1 Game and participant access

### M01 — World authority and Paper plugin

This module owns actual blocks, protected regions, inventories, structural revisions and game-action receipts. It validates authenticated commands and applies them using appropriate game scheduling. For example, it allows an assigned bot to place a repeater while denying an outsider's edit. It depends on persistent world/plugin storage, identity and job permissions. It cannot select offers, price KIT or authorize payment. Paper is the plugin foundation, not the finished job system. Paper development

### M02 — Interface and account linking

This module connects an authenticated game session to a wallet using a short-lived, single-use challenge and presents readable actions. For example, a player reviews Calculator #42 in-game and signs its agreement in the companion. It depends on game identity, wallet signatures, nonce/session storage and backend authorization. A display name cannot establish ownership, and a submitted transaction cannot be displayed as settled.

## 9.2 Work and information

### M03 — Agreement and team domain

This module defines versioned scope, blueprint/tests, plot, spending cap, reward allocations, deadlines and cancellation terms. Parties approve one canonical digest. For example, a team signs 3/2/1 CRED allocations before funding. Dependencies are identity, offers, manifests and escrow. It cannot change funded recipients through a backend edit; replacements require an explicitly supported agreement transition.

### M04 — Workflow coordinator

This module owns task leases, job transitions, command identities and the operational journal. It records intent, dispatches actions and advances only on evidence. For example, a confirmed purchase resumes at redemption after a restart rather than triggering another buy. It depends on durable storage and all adapters. It coordinates sources of truth without overriding their facts.

### M05 — Arkiv adapter

This module owns publication schemas, entity references, queries and renewal. It publishes jobs and reads independently controlled offers; for example, a requester discovers a builder's calculator service. Dependencies are publishing funds, ownership checks and workflow projections. It is not an escrow or proof-of-work verifier, and expired records cannot be the only recovery data.

## 9.3 Decisions and execution

### M06 — 0G inference adapter

This module builds bounded context, calls a selected provider/model and records a structured proposal, cost and evidence metadata. For example, it proposes inspecting the carry path after a failure. Dependencies are funded access, model capabilities, observation adapters and tool schemas. It cannot execute its own proposal or assert world truth merely because inference was authenticated.

### M07 — Tool policy

This module deterministically checks actor, state, revision, bounds, inventory and financial authorization. For example, it rejects a repair outside the plot or a purchase above the cap. Dependencies are agreement data, task leases and execution adapters. It must reject disallowed requests even when a model provides a plausible justification; prompting cannot modify its policy.

### M08 — Blueprint and bot executor

This module owns the pinned material bill, stage instructions, orientation and execution checkpoints. It translates an approved stage into movement and verified placements. For example, it installs four input levers at manifest coordinates. It depends on Mineflayer, navigation, game compatibility, plot permissions and delivered stock. It is not arbitrary circuit invention or unlimited-block construction. Mineflayer API

## 9.4 Custody, contracts and exchange

### M09 — Warehouse ledger

This module locks deposits and reconciles each required ingredient against outstanding vouchers and pending claims. For example, a ten-bundle deposit supports ten units of obligations, not repeated issuance from the same chest. Dependencies are controlled game custody, issuance records and delivery receipts. It cannot treat burned-but-undelivered claims as extinguished or substitute a total-item count for ingredient coverage.

### M10 — CRED contract

This module defines balances, allowances, controlled issuance and token units for the demonstration spending asset. For example, it supports a separately authorized materials purchase and labor funding. It depends on the settlement environment and token-compatible pool/escrow. It does not create stock backing, native gas or 0G compute credit; its initial distribution is a disclosed economic assumption.

### M11 — KIT issuance contract

This module mints against uniquely identified authorized deposits and records replay protection. For example, one locked three-bundle deposit can issue three KIT once. Dependencies are the warehouse's attestation, role management and the redemption contract. It trusts authorized stock reports and cannot independently inspect a chest. KIT's definition must not silently change for existing holders.

### M12 — Labor escrow

This module binds the funded agreement, fixed recipients, amounts and expiry; validates revision-bound inspection evidence; and permits requester acceptance followed by one-time claims. For example, the team receives separate entitlements instead of payment to a redistributing lead. Dependencies are CRED, approvals, a trusted inspection attestor and protected review. It cannot determine redstone truth or guarantee the requester will accept.

### M13 — Procurement adapter

This module obtains an executable quote and prepares a requester-signed bounded swap on the tested CRED/KIT route. For example, a 2.7 CRED quote fits a 3 CRED maximum. Dependencies are tokens, active liquidity, router integration, chain access and the hook. It cannot draw from labor escrow, round a fractional balance into a whole kit, or equate a successful swap with delivery.

## 9.5 Conditions and fulfillment

### M14 — Publisher and GameStateRegistry

This module reports delivery health with authorized identity, sequence and bounded validity. For example, a failed worker health check produces an unavailable report; publisher silence eventually makes it stale. Dependencies are game/worker observations, chain access and a separate publisher role. It does not publish independent proof or instant state, and it must not share unrestricted issuance/payout authority.

### M15 — GameStateMarketHook

This module validates the expected v4 callback and applies the fresh/available predicate to the purchase direction. For example, a stale report rejects a KIT buy through our pool. Dependencies are the registry, pool configuration, valid hook permissions and route tests. It neither mints vouchers nor delivers goods; it cannot constrain every market or eliminate the risks of a dishonest publisher.

### M16 — Redemption and delivery

This module atomically burns authorized whole KIT into a durable job-bound claim, then coordinates delivery after the selected chain-confirmation policy. For example, an offline server leaves the claim pending. Dependencies are KIT, warehouse reserves, chain listeners and the plugin journal. It cannot safely repeat an uncertain inventory mutation without reconciliation. Any onchain delivery acknowledgement remains server-attested evidence.

## 9.6 Evidence and operations

### M17 — Functional checker

This module owns the reset/timing procedure, all 16 expected outcomes, structural lock and pass attestation. For example, A=3/B=1 must illuminate only the output weight 4. Dependencies are a pinned interface manifest and actual world reads. It cannot use model opinion or screenshots as functional results. Post-inspection structural changes invalidate readiness.

### M18 — Reports and completion history

This module stores full agreements/reports and projects verified milestones into the game, companion and Arkiv references. For example, it shows 10/16 repair required, then 16/16 ready for review, then actual claim status. Dependencies are durable artifacts, inspection and confirmed contract events. It cannot invent progress or rely on a report hash as proof that observations were honest.

### M19 — Recovery and administration

This module maintains event deduplication, confirmation/reorganization handling, backups, role rotation, health and reconciliation. For example, a restart finds an existing delivery receipt instead of delivering again. Dependencies span chain events, operational storage and world/plugin journals. Administrative maintenance cannot substitute payout recipients or forge requester acceptance. Unresolved evidence pauses the affected operation.

# 10. A complete case study and the finished experience

The following is a proposed sequence with illustrative amounts, not an experimental result.

## 10.1 Commission and agreement

A requester enters the build hub and selects “Request a build.” The model maps the description to the supported calculator. The card describes the input range, four levers, three lamps, protected plot, 16-case test manifest, deadline, review rules and budget.

An independent builder publishes an offer through Arkiv. The requester selects it. Both sign the same agreement; 6 CRED is funded for labor. Materials may cost at most 3 CRED, and 1 CRED remains unallocated. Network and inference expenses are disclosed separately.

## 10.2 Procurement and physical progress

The pool is initialized and seeded transparently. An executable quote for one KIT is 2.7 CRED. The requester signs with a 3 CRED maximum and expiry. The hook finds a fresh healthy report and permits the purchase.

Redemption burns the KIT and creates a job claim. After confirmation, a durable delivery operation transfers the bundle into the protected inventory. The UI says “Materials delivered” only after evidence exists.

The bot obtains those items and constructs the known stages. At meaningful boundaries, the 0G model selects a permitted next task. The player sees construction and can continue exploring. Protocol details are available in receipts, not required to understand each action.

## 10.3 Fault, repair and payment

For the demonstration, disclose a deliberately introduced carry disconnection. Submission locks the plot. The checker runs every input pair and records 10/16 passed. Labor stays held.

The model receives the failure table and blueprint observations, proposes inspection of the carry path, and a validated repair reconnects it. The full test reruns and produces 16/16. The requester operates the controls while structural edits remain locked.

The requester accepts the exact revision. Escrow creates the builder's fixed entitlement, the builder claims it once, and the completion reference links agreement, report and settlement. In team mode, each approved contributor claims their own allocation.

## 10.4 What the player ultimately receives

The result is a usable calculator standing in the world, clear controls, accessible evidence and known ownership. The companion shows confirmed purchases, claim/delivery status and labor settlement. The builder gains a verifiable reference to accepted work, subject to the server-trust limits already described.

A failed workflow must remain understandable: an outage says delivery unavailable, a quote failure says budget exceeded, and a pending claim stays visible. The user should not be asked to repeat a purchase because the system lost track of a delivery.

# 11. Evaluation design: how to test the claims

## 11.1 Separate technical validity, user value and market viability

A successful demo is evidence of integration, not sufficient evidence of adoption or sustainability. Evaluate three questions separately:

1. **Technical validity:** do custody, construction, testing and settlement follow the stated rules?
2. **Decision value:** does the model help users or execution compared with simpler logic?
3. **Economic usefulness:** does the market support procurement and independent participation at acceptable cost?

No results are reported here. The following experiments are proposed.

## 11.2 Comparative experiments

| Experiment | Conditions | Measurements | Interpretation boundary |
| --- | --- | --- | --- |
| E1 — Decision contribution | Scripted blueprint workflow versus 0G-assisted workflow; identical manifests and permissions | Completion, interventions, invalid proposals, elapsed time, repair attempts and inference cost | A model call alone is not improvement |
| E2 — Exception handling | Missing material, blocked region, disconnect and multiple fault types | Recovery success and time, task choices, human help | Separate held-out failures from prompt-development examples |
| E3 — Backing/recovery | Interrupt before/after issuance, burn, delivery and receipt acknowledgement | Item-level reserves, duplicate mint/delivery, pending obligations | Clean runs do not establish retry safety |
| E4 — Market depth | Vary active liquidity, ranges, demand size and fixed budget | Executed price, failed quotes, cost per accepted build | Seeded pools do not demonstrate organic liquidity |
| E5 — Hook enforcement | No hook, UI-only gate and pool hook under the same reported outage | Direct-client purchases allowed/rejected, delay, false pauses, LP asset mix | Measure pre-report exposure separately |
| E6 — Settlement | Pass/fail, requester rejection, timeout, competing acceptance/refund and delayed claims | Correct entitlements, duplicate prevention, unpaid completed work | Contract correctness is different from payment fairness |
| E7 — Marketplace independence | Independent publishers and clients; expired records and stale offers | Discovery, authorization and continued recovery | Shared schema does not prove demand or Sybil resistance |
| E8 — User comprehension | Participants review cards and explain states without coaching | Misunderstood costs, mistaken payment/delivery beliefs, task completion | Actual users are required; team familiarity is not a substitute |

For E1/E2, retain the same scenario definitions, server version, resources and permissions across conditions. Record selected model/provider, request configuration and repeated trials. Report variation and failure traces; choose trial counts based on observed variability rather than presenting one favorable run as typical.

## 11.3 Model benchmark dimensions

The model should be evaluated on supported-template interpretation, necessary clarification, valid action schemas, permission compliance, evidence-grounded repairs and correct waiting/escalation. Measure execution outcomes after policy validation, not merely linguistic plausibility.

A decision can be syntactically valid but useless. Conversely, a refusal can be correct when the request exceeds scope. Include both in the benchmark.

If a deterministic workflow matches the model on the supported tasks, report that result. The defensible role for inference may then be natural-language interaction or exception interpretation rather than the entire construction process.

## 11.4 Economic measures and cost attribution

For requester utility, a simple analytical model is:

$$
U_r=V_{build}-M-W-F_r
$$

Here V_build is requester value, M materials expenditure, W labor payment and F_r other requester-borne expenses, all expressed in a common accounting unit for analysis. This is not social welfare: W is a transfer to a builder, not a resource destroyed by the system.

Record compute, publishing, server and recovery expenses with the actor that pays them. Do not silently count a subsidized cost as zero. CRED, native gas and compute balances are separate payment domains; converting them for analysis requires stated rates or reporting them separately.

Useful market measures include KIT purchased per accepted build, percentage of purchases redeemed, fulfillment delay, backing coverage, active depth, failed procurement and LP outcome relative to holding the initial assets. Transaction volume alone can be inflated by self-trading and is not a core success metric.

## 11.5 Evidence artifacts

A reviewable run should retain the approved agreement and signatures, independent Arkiv references, exact model/provider/request record, validated action receipts, deposit/issuance reference, actual swap, claim/delivery receipt, per-case inspection results, revision-bound acceptance and final reward claims.

Public evidence should omit secrets and unnecessary personal data. Explain each artifact's scope: a signed report establishes authorship, a chain receipt establishes a chain event, and neither alone proves honest physical-world/game custody.

# 12. Failure analysis and limits

## 12.1 Trust remains concentrated in the server

The operator can affect the world, warehouse, checker and observations supplied to the model. Separate service keys and logs reduce accidental privilege overlap but do not remove an operator's ability to misreport controlled infrastructure.

A false “healthy” report can permit an undesirable purchase. A false inspection attestation can authorize readiness. No amount of inference provenance repairs falsified input. These are the design's principal trust limits.

## 12.2 Coupled incentives can create feedback loops

More accepted jobs can increase resource demand and attract suppliers. Better execution can improve builder history and attract requesters. Those are positive hypotheses, not self-executing growth mechanisms.

The reverse is also possible: failed delivery weakens voucher demand, harms LP exposure, reduces liquidity, increases procurement costs and causes more jobs to stall. Hook policy can interrupt part of that loop, while imposing its own restrictions.

Model autonomy can amplify errors if incorrect decisions trigger repeated purchases or repairs. Budget caps, task leases, deterministic tests and escalation are therefore part of economic control, not just software hygiene.

## 12.3 Centralized alternatives may dominate at small scale

A single operator with one blueprint and predictable stock may serve players more efficiently using a fixed-price shop and scripted workflow. Market deployment, signatures, fees, funding and recovery add overhead.

The decentralized components are most defensible when independently controlled parties actually publish, trade or depend on enforceable shared rules. The prototype should demonstrate that boundary clearly and avoid claiming that every server function is decentralized.

## 12.4 External validity

The calculator is intentionally small and exhaustively testable within its input domain. Results do not automatically generalize to unrestricted builds, aesthetics, long-running farms, multiple worlds or large teams.

Public token-linked deployment requires review against current Minecraft platform rules; testnet tokens alone do not establish permission. Hackathon tracks and pre-event-work rules also require current verification. These are deployment constraints, not conclusions established by this paper. Minecraft usage guidelines

# 13. Research position and next decisions

The architecture is plausible as a bounded prototype because it limits construction, resources and verification to known forms. Its strongest testable claim is that these mechanisms can compose into one recoverable and understandable commission.

The most important unresolved questions are whether model decisions outperform simple control logic, whether independent suppliers/LPs find the market useful, how the hook distributes outage risk and how honest builders are protected from refusal.

The next engineering decisions should follow evidence: validate the calculator/checker, benchmark the actual 0G model/path, test a backed kit purchase and delivery, compare hook policies, and exercise acceptance/refund races. Exact chain, model, liquidity ranges, heartbeat interval and timeout values should remain explicit configuration choices until those tests are run.

A convincing end result is a working in-world calculator and a complete evidence chain for how it was commissioned, provisioned, built, repaired and paid. A convincing research result additionally explains which mechanisms were necessary, what they cost and where they failed.

# 14. Primary-source reference guide

All mechanisms below are drawn from primary documentation. AgentCity-specific incentive models, numerical examples, module boundaries and hypotheses are our analysis.

## 0G architecture, requests and accounting

- Compute architecture overview
- Router overview
- Router versus Direct
- Provider routing
- Chat completions and capabilities
- Router deposits and billing
- Direct inference

## 0G verification and trust limits

- Compute trust-mode explanation
- Privacy and trust-mode distinctions
- Response verification and the Router trust boundary

## Uniswap mechanisms

- AMM overview
- Uniswap v2 whitepaper
- Uniswap v3 core paper
- Concentrated liquidity
- Swap execution and protections
- Fee mechanics
- V4 hooks
- Dynamic fees

## Records and game execution

- Arkiv fundamentals
- Arkiv profile pattern
- Arkiv querying
- Paper development
- Mineflayer API
- Minecraft usage guidelines