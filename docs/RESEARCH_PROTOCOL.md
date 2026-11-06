# AgentCity research protocol

This protocol turns the proposed E1–E8 experiments in the AgentCity research design paper Version 3, section 11, into executable comparisons. It separates technical correctness, decision value, participant understanding and economic usefulness. It contains no measured results and assumes no advantage for AI, blockchain markets or a particular hook policy.

A research experiment is complete when its registered comparisons have been executed honestly, their evidence is retained and their limitations are reported. AI does not have to beat the scripted workflow. A market does not have to prove sustainable. A negative or null result can complete the research requirement while changing the recommended product design.

Technical release gates remain separate. No research result permits an authorization bypass, unbacked issuance, duplicate delivery, invalid inspection or contradictory settlement. An experiment that reveals such a defect blocks the affected implementation phase until the defect is fixed and the relevant tests pass.

## Register the study before collecting final results

Before implementation benchmarks begin, create a versioned study manifest containing the following information. Update it through an explicit amendment; do not silently change it after seeing outcomes.

- The research question, comparison conditions, supported scope and primary and secondary metrics for each experiment.
- Exact calculator, blueprint, test-manifest and tool-policy versions; client, server, plugin, bot and backend versions; deployment identities and configuration digests.
- Selected 0G interface, network, model, provider-selection constraints, generation settings, response schema, retry limits, inference budget and any required trust mode or response evidence.
- Scenario families, parameter bounds, fault-injection locations, reset procedure, randomization seeds, trial order and maximum allowed time and cost.
- Training or development scenarios, pilot scenarios and held-out scenarios. Freeze this split before prompt tuning and final comparison. Keep held-out fault details outside model prompts and prompt-development examples until their evaluation run.
- A pilot procedure that measures variation, failure rates, latency and feasibility. Use those observations to choose final trial counts and precision targets before final trials. Record the rationale rather than inventing an arbitrary claim of statistical adequacy.
- Eligibility and exclusion rules, stop conditions, treatment of missing data and external outages, participant consent, evidence retention and the analysis procedure.
- The approval owner for the manifest, amendments and completed report. A reviewer confirms that changes and exclusions are visible.

Record pilots separately from final trials. If a pilot scenario becomes a development example, it cannot remain an unseen held-out test. If the final study changes, preserve the original manifest and identify which results belong to which version.

## Common execution and evidence rules

Use controlled local or test-network environments with disclosed stock, token balances, gas funding and liquidity. Do not use live customer funds. Verify platform suitability before the intended token-linked game integration. Test tokens or a private repository do not establish Minecraft permission.

Keep the supported prototype narrow: one compatible world, protected plot, calculator blueprint, immutable material bundle, requester and independently controlled builder with a bot. Team contract fixtures may test fixed entitlements without claiming that a full team interface has been implemented.

For comparisons, hold the physical executor, checker, permissions, material quantities, agreement, budgets and scenario definitions constant unless a particular variable is the registered treatment. Reset from a known fixture or use fresh, uniquely identified jobs. Reusing an operation or claim identity is reserved for explicit replay tests. Do not restore a game snapshot while pretending that external chain effects were also undone.

Counterbalance or randomize trial order and block related trials where provider conditions, network delay or server load could affect results. Record those conditions. A failed or interrupted run remains a result unless a predeclared exclusion rule applies; retain its evidence even when excluded from a summary statistic.

For every trial retain:

- Study and scenario IDs, condition, seed, release commit, environment manifest and timestamps with clock sources.
- Approved terms and signatures, stable job/task/operation identifiers and relevant actor capabilities.
- Bounded model request and actual response metadata, provider/model, trust evidence if required, validation result, refusal reason and observed execution outcome.
- Deposit and issuance evidence, actual quote and swap, claim and physical delivery receipts, inventory reconciliation and relevant chain confirmation state.
- Complete inspection case results, structural revision and lock lifecycle, requester action and actual acceptance, refund and reward-claim state.
- Injected fault point, observed result, recovery steps, retries, human assistance and deviations from the registered procedure.
- Cost records and evidence references. Redact credentials and unnecessary personal data before sharing artifacts.

Screenshots support explanation. Real lamp observations determine functional results. A signed report establishes its author; a chain receipt establishes a chain event. Neither independently proves honest game custody. Record requested, submitted, included, confirmed, applied and reconciled states separately.

## E1 Decision contribution

**Question.** Does model-based task selection improve the supported workflow compared with a deterministic controller?

**Setup and controls.** Implement a scripted blueprint controller and a real 0G-assisted controller using the same allowed tool set, policy validator, executor, observations, material budget and checker. The script is a credible simple baseline, including documented waiting and blueprint-difference handling. Neither condition receives extra permissions or stock. Record which request-interpretation or coordination functions each controller performs.

**Execution.** Run matched registered scenarios from equivalent initial states, including ordinary construction, a blocked stage, a shortage and the disclosed carry fault. Use the frozen development, pilot and held-out split. Apply the same time, retry, action and spending bounds. Preserve actual model/provider and settings for each model run; document eligible failover rather than silently substituting another model or trust property.

**Metrics.** Primary measures are successful accepted completion under the registered limits and required human interventions. Secondary measures are total elapsed time, invalid proposals, useful versus redundant actions, repair attempts, waiting/escalation correctness, consumed materials and inference cost. Measure execution after policy validation, not persuasive wording or valid JSON alone.

**Evidence and analysis.** Retain paired traces, every failed/refused run, action receipts and full real inspection reports. Report completion counts and uncertainty, distributions or intervals for time and cost, differences between conditions and observed variation. Define before analysis whether failed runs are reported separately or included through a registered time-limit rule; do not quietly remove them from completion-time averages.

**Interpretation and exit gate.** Both controllers must respect all safety invariants. Complete the registered comparison and report whether any observed benefit justifies inference cost and added failure modes. A tie, worse model performance or a narrower useful role for inference is an acceptable research finding. One successful model call is not evidence of improvement.

## E2 Exception handling

**Question.** How well do the controllers recover from supported interruptions and faults?

**Setup and controls.** Reuse the E1 controllers, versions and constraints. Pre-register missing-material cases, blocked regions, bot disconnects and multiple fault types. Distinguish faults used during prompt/controller development from genuinely held-out combinations or locations. The evaluator records which information is observable to each controller.

**Execution.** Inject each fault at a recorded checkpoint and run both conditions from equivalent states. Include cases where the correct response is to wait or request help rather than continue. Stop at the same registered limits and label every human recovery intervention. Repeat according to pilot-informed trial counts.

**Metrics.** Recovery success, time to diagnosis and safe resume, next-task choices, retries, human help, additional inference/action cost and permanent or unresolved outcomes. Track forbidden proposals separately from executed violations; deterministic policy must block the former.

**Evidence and analysis.** Preserve fault recipes, pre/post world and inventory observations, checkpoints, policy refusals, model decisions and recovery records. Summarize results by fault family and held-out status, including unsuccessful recovery and uncertainty. Do not pool an easy known fault with unseen faults without showing the groups.

**Interpretation and exit gate.** All registered exceptions have observed outcomes and reproducible evidence. Unsafe mutation or fabricated progress blocks technical progression. A correctly escalated unresolved fault is different from autonomous recovery and must be reported as such.

## E3 Backing and recovery

**Question.** Do issuance, redemption and delivery preserve obligations through failures and retries?

**Setup and controls.** Use an immutable item-level material bill, real controlled stock, pinned token units, durable plugin/worker journals and a declared chain-confirmation rule. The accounting oracle is independent integer arithmetic: for every ingredient, locked inventory covers outstanding KIT plus burned-but-undelivered claim equivalents. Count KIT in wallets and the pool once. Fractions contribute proportionally even though redemption accepts whole kits.

**Execution.** Interrupt before and after deposit custody, issuance intent and confirmation, atomic burn/claim creation, delivery mutation, receipt persistence and acknowledgement. Inject duplicate/reordered events, parallel workers, full or offline destinations, partial multi-item delivery and contradictory observations. Include ordinary pre-confirmation reorganization and a simulated deeper reorganization after physical effects under the adopted incident procedure.

**Metrics.** Item-level backing coverage, supply and pending obligations, attempted and successful duplicate issuance/delivery, time to safe reconciliation, quarantined operations, human repair and lost or unresolved evidence. Track recovery availability separately from safety: stopping safely is not successful fulfillment.

**Evidence and analysis.** Retain before/after stock, token and claim snapshots, deposit/claim semantic IDs, operation journals, canonical receipts and an item-by-item conservation report for every fault location. Show why each operation is proved unapplied, completed or quarantined. Do not infer exactly-once behavior solely from an event listener or message ID.

**Interpretation and exit gate.** No unauthorized mint, duplicate completed delivery or erased pending obligation is allowed. Every uncertain side effect must be quarantined until reconciled; it must not be blindly replayed. Execute each registered fault location and record all unresolved cases. Clean happy-path runs alone cannot complete E3.

## E4 Market depth and affordability

**Question.** How do active liquidity, ranges and demand affect a job's bounded procurement?

**Setup and controls.** Use the selected v4 implementation and tested quote/router path. Register initial price, token units, fees, ticks/ranges, active liquidity, seeded capital and each funding actor. Keep backing and delivery healthy while varying market depth so custody failures do not masquerade as liquidity effects. Use actual concentrated-liquidity quotes; the paper's constant-product examples are analytical illustrations, not the execution oracle.

**Execution.** Vary active liquidity, in-range versus out-of-range capital, range boundaries/tick crossings, requested quantity and fixed material budget. Compare quote with execution under registered intervening trades and slippage conditions. Include insufficient liquidity and cap/expiry boundaries. Use fresh matched pool fixtures or documented sequential trade histories; do not compare different histories as though only depth changed.

**Metrics.** Expected and actual CRED input for exact KIT output, price impact, quote-to-execution deviation, failed procurement rate, active depth, gas and total cost per accepted build. Also measure KIT bought per accepted build, percentage redeemed and fulfillment delay. Report pool capital separately from warehouse backing.

**Evidence and analysis.** Retain initialized pool identity, range/position configuration, liquidity operations, executable quotes, swap receipts, balance deltas and cap failures. Report curves and distributions with units, fees and rounding assumptions. Explain costs of unsuccessful and cancelled jobs alongside accepted-job costs.

**Interpretation and exit gate.** All registered depth/range/budget conditions execute or produce documented valid refusal. Spending caps and exact-output requirements remain enforced. Seeded liquidity, self-trading volume or a chosen initial price cannot establish organic demand, a fair price or a sustainable market.

## E5 Hook enforcement and outage exposure

**Question.** Does an onchain pool gate change purchases during the same reported outage, and who bears the exposure?

**Setup and controls.** Compare three conditions: a pool without an availability hook, a pool protected only by an interface check and the designated pool with the purchase-availability hook. Use separate pools initialized for their respective conditions. Hooks are fixed at pool creation; do not retrofit or toggle a hook on an existing pool and label that a matched comparison. Use isolated deployments/snapshots or clearly documented paired test tokens/configurations where needed to make PoolKeys distinct. Disclose any resulting configuration difference.

Match initial price, seed amounts, active ranges/depth, fee configuration, trade sizes, outage sequence, publisher schedule and requester cap as closely as the protocol allows. Disclose all seeds, operators, simulated demand and liquidity funding. Use only controlled test funds and no live customer balances. Isolated no-hook control pools are research fixtures, never an approved production procurement route.

**Execution.** Attempt purchases through both the ordinary interface and an independent direct client/router in each condition. Test healthy, unavailable, missing and expired state; stop publisher refresh; race reports and swaps in both canonical orders. Separately record outage onset, observation, report submission, onchain effectiveness and old-report expiry. Measure exposure before the report becomes effective separately from enforcement afterward. Execute intended KIT sales and liquidity removal during the purchase-only pause. Restore fresh healthy state and resume an existing claim independently of the purchase gate.

**Metrics.** Direct-client and interface purchases allowed/rejected, time to effective pause, permitted purchases during stale-information exposure, false pauses, rejected healthy purchases, publisher/gas cost and LP asset mix. Compare LP holdings and fees with holding the same initial CRED and KIT amounts over the same period. Show raw asset quantities; if a common valuation is used, register its source and time rather than assuming a CRED dollar peg.

**Evidence and analysis.** Retain pool initialization and hook-permission records, exact PoolKeys, registry sequences, timestamps, direct-client transactions, state reverts, LP position/balance snapshots and claim fulfillment evidence. The expected UI-only bypass is a finding about that isolated control condition, not permission to bypass the designated hook.

**Interpretation and exit gate.** The designated hook must reject new CRED-to-KIT purchases under effective unavailable/stale state on the actual route, including direct clients, while preserving its declared sale/removal behavior and existing claim obligations. Report delayed observation honestly. Purchase-only gating can leave LPs holding more risky KIT; do not claim the rule eliminates outage loss or governs every secondary market. Both-direction pauses and dynamic fees require a separately registered later experiment.

## E6 Settlement correctness and fairness

**Question.** Are entitlements enforced correctly, and what happens when a requester refuses to accept completed work?

**Setup and controls.** Adopt exact approval, work/review/pass/absolute-deadline, ownership, cancellation and refund rules before funding. Use fixed approved allocations and independently authorized requester acceptance. Preserve structure while any issued pass remains usable and while acceptance/finality is pending, or use an explicitly tested onchain invalidation protocol before early unlock.

**Execution.** Exercise correct 16/16, failed 10/16 and incomplete inspections; absent/invalid/expired evidence; requester acceptance and refusal; work/review/absolute-deadline boundaries; competing acceptance/refund orderings; delayed claims; duplicate/reentrant claim attempts and failed token transfers. Call the contract directly with stale signed evidence rather than testing only the interface. Keep purchased KIT, pending deliveries, unused stock and placed materials separately accounted through timeout or cancellation.

**Metrics.** Correct fixed entitlements, duplicate payout attempts/successes, terminal outcome, held/refunded/claimed labor, time to settlement, failed claims and completed but unpaid work. Report any human intervention and recovery cost. Accepted-but-unclaimed rewards must remain distinct from unpaid unaccepted work.

**Evidence and analysis.** Retain canonical terms/signatures, inspection and lock/revision records, requester actions, direct contract traces and confirmed fund/accept/claim/refund receipts. Reconcile every funded base unit. Where participants are simulated, label that fact; simulated refusal rates cannot establish real builder participation or a real probability of payment.

**Interpretation and exit gate.** No invalid acceptance, duplicate payout or accepted/refunded dual outcome is permitted. All funded labor must have the adopted terminal path. Separately report the fairness weakness: a technically correct expiry-refund policy can leave an honest builder unpaid. Do not infer that contract correctness proves fair incentives or silently add arbitration, bonds or milestone payments.

## E7 Marketplace independence and recovery

**Question.** Can separately controlled parties publish, discover and recover the same supported job through shared records?

**Setup and controls.** Use at least two independently controlled wallets linked to authenticated game accounts. Register one application/server namespace and schema version, one authorized bot and one calculator service. Disclose shared supplier, publisher or server-operator roles. Retain terms, signatures, reports and claim identifiers outside expiring discovery records.

**Execution.** Have the builder publish its own service and offer; query them from the requester's client. Publish the requester job and query it from the builder's client. Where a second compatible reader is available, verify the same schema and supporting evidence through it. Test false wallet fields, wrong entity owner, cross-server/schema/job records, stale/changed/withdrawn offers, expired listings and renewal/RPC failures. Expire a job record while a confirmed delivery obligation is pending and recover that obligation from its authoritative sources.

**Metrics.** Successful independent publication/discovery, owner/authorization rejection rate, stale offer handling, time to retrieve valid terms/evidence and continued recovery after expiry. Record who signed every consequential write and whether completion is accepted, claimable or actually claimed.

**Evidence and analysis.** Retain entity references, actual publisher ownership, opposite-client query results, canonical approvals, refusal traces and independent recovery references. A wallet address in a payload is not ownership proof. An Arkiv field saying funded or delivered must not authorize construction without contract/game evidence.

**Interpretation and exit gate.** Independent authorized publication and cross-client discovery must work, impersonation must fail and expired discovery cannot strand an existing obligation. The study does not establish real demand, independent reputation or Sybil resistance merely by sharing a schema or counting completions.

## E8 User comprehension

**Question.** Can intended users understand costs, states and required actions without coaching?

**Setup and controls.** Recruit actual intended participants beyond the implementation team under the applicable participation rules. Obtain informed consent for tasks, observations and any recording. Explain the controlled test environment and absence of real customer-money requirements without teaching the answers. Register recruitment criteria, prior game/wallet experience, tasks, question wording, assistance policy and stopping rules. Use pilot observations to determine final participant/trial counts.

Pseudonymize participants and restrict access to any study-to-wallet or account linkage. Collect no private keys or unnecessary personal information. Explain that public chain transactions or marketplace records may remain public and cannot be made anonymous merely by removing names from the report. Define evidence access and retention in the consent procedure.

**Execution.** Ask participants to review an agreement and explain the material cap, actual quote, labor escrow, other fees, deadlines and cancellation rules. Give tasks involving a submitted transaction, acquired KIT, pending redemption/delivery, 10/16 repair, 16/16 review, acceptance, claimable reward and actually claimed reward. Include unavailable delivery and a pending claim after interruption. Use uncoached first attempts, neutral task wording and counterbalanced order where learning could affect comparisons. Record every hint, intervention or abandonment. Intervene for safety under the registered rule and mark the task assisted.

**Metrics.** Unassisted task completion, time, wrong actions, assistance, abandonment, misunderstood costs and mistaken beliefs that submitted means paid, purchased means delivered or passed means accepted. Also measure whether the user understands that retrying an existing claim should not require another purchase. Report results by relevant prior experience rather than treating team expertise as representative.

**Evidence and analysis.** Retain consent records separately from pseudonymized task traces, exact interface/version, neutral questions, participant explanations and intervention timing. Publish aggregate results and appropriately redacted examples. Show uncertainty and recruitment limits. Avoid claiming comprehension from a polished demo narrated by a developer.

**Interpretation and exit gate.** Complete the registered user study and report misunderstandings, including negative findings. A material misunderstanding affecting consent, spending, ownership or payment must reopen the owning interface/terms implementation gate for correction and fresh uncoached verification. Required comprehension criteria are registered before final evaluation, not lowered after observing errors.

## Cost attribution and LP accounting

Maintain one cost record per trial and payer. Include the actor role, activity, asset/payment domain, integer amount and units, source receipt or usage record, timing, actual rate if applicable, subsidy payer and shared-cost allocation rule. Distinguish requester, builder, supplier, LP, server operator and compute provider roles even when one demonstrator performs several.

Keep these domains separate unless a stated analytical conversion is supplied:

- CRED spent on KIT and labor; KIT acquired, redeemed, held in the pool and still pending delivery.
- Native-chain gas and funding transactions.
- 0G Router charges or Direct provider-account charges under the selected integration; an apparently unchanged balance is not proof of a free request.
- Hosting, publishing, inspection, monitoring and recovery expenses, including operator time under a disclosed valuation if reported.

Disclose free stock, initial CRED, gas sponsorship, seeded liquidity, compute grants and unpaid operator effort. Report both participant outlay and total resource cost under the declared method. Do not count a subsidized expense as zero or labor transferred to a builder as a destroyed social resource.

For LP analysis, retain the initial contributed asset quantities, position/range, liquidity changes, collected fees and final asset quantities. Compare with holding those same initial assets over the identical observation window. Report fees separately from net outcome and account for added/removed capital, rebalancing and gas. If the valuation of KIT or CRED is uncertain, show quantities and sensitivity to stated valuation assumptions rather than inventing a dollar return or guaranteed yield.

## Analysis and completion report

Each experiment report contains the registered question, setup, executed conditions/trial counts, exclusions, amendments, primary and secondary results, uncertainty, raw evidence references, failure traces, cost attribution and limitations. Preserve null and negative outcomes and distinguish implementation defects from observed mechanism limitations.

For proportions, report numerator and denominator and an appropriate uncertainty interval. For latency/cost, report the relevant distribution and variability; state treatment of timeouts, failed jobs and censoring. Use matched or paired analysis where the design is paired. Do not invent significance or causal certainty from a small convenience sample. Summaries must not hide repeated failed attempts or informal human help.

The final research gate requires E1–E8 to have completed registered comparisons with reviewable evidence, or an explicit scope amendment identifying any experiment that could not be performed and why. An unexecuted experiment stays incomplete. A product release may not claim evidence it does not have. Honest findings that the script is sufficient, liquidity is too shallow, users misunderstand the flow or the acceptance policy discourages builders must remain visible in the conclusion.
