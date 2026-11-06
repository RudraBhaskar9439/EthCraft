# Inputs and local work through Phase 8

## Current approved route

The user selected [Minecraft internal mechanics with a separate contract demonstration](DEPLOYMENT_ROUTE.md). Ollama temporarily replaces 0G, the user's computer is the temporary host, existing developer-wallet/testnet authorization remains valid, and an independent participant joins for final testing. No additional secret is required to begin. Blockchain claims and rewards must not affect Minecraft. The original integrated-spec requirements below are retained for traceability; unavailable 0G is not a blocker for the revised local inference route.

Updated 30 October 2026 in Asia/Calcutta. Phases 0–2 have verified local milestones. The user also authorized local implementation and testing through Phase 8 while live checks remain pending. See [the local implementation report](LOCAL_P3_P8_IMPLEMENTATION.md). No later canonical live gate is marked complete by local fixtures.

The separate demonstration now uses actual funded developer wallets on Unichain Sepolia and Arkiv Tiramisu. Public discovery, deployment, a real hooked-pool trade, synthetic delivery, acceptance, payout and same-job replay have been verified. See [public deployment and operator commands](PUBLIC_TESTNET.md). No personal wallet private key or additional provider key is required for the current pilot.

## Earlier local preparation, retained for traceability

The earlier local checkpoint ran the construction worker, inference controls, PostgreSQL identities/agreements, local Arkiv discovery, custody, a local v4 pool/hook, procurement, synthetic delivery and escrow settlement. Its scripted inference responses and local wallets/contracts are disclosed fixtures. That evidence alone cannot establish real0G service, independently controlled people, liveArkiv publication, public-chain deployment or funded liquidity. The subsequent public-testnet and actual Ollama results are linked above.

The first useful inference preparation is implemented in `backend/src/inference/proposal.mjs` and exercised by `node tests/inference/local-smoke.mjs`. It uses the actual retained10/16 calculator report with a scripted authorization/material context. Five focused checks cover a scoped carry-repair proposal, inspection proposal, forbidden mint refusal, material-shortage wait and provider-unavailable wait. It executes no Minecraft actions, contacts no external inference provider and spends nothing. It is not an LLM or0G inference test.

The transport follows the official Router chat-completions shape. Real model selection, JSON capability, billing and verification mode remain to be checked when access arrives. The same client can use the official base URL after credentials/configuration are supplied; no key is embedded in the repository.

## Original integrated-spec external requirements, retained for traceability

| Phase | Can prepare/test locally | Needed for live completion |
| --- | --- | --- |
| P2 — construction | Actual bot, controlled stock, staged placement and basic resumption | Nothing new for local work. Genuine game access is required before an authenticated human/server demonstration. |
| P3 — inference | Scripted HTTP responses, proposal parsing, repair/inspect/wait permission checks | Hackathon0G environment, Router API credential, usable Router credits/balance, available model and spending cap. Record required trust/attestation mode. |
| P4 — identity and discovery | Local wallet challenges, agreements, local discovery records | Two independently controlled requester/builder participants with their own wallets and genuine Java game access; authenticated bot access when required. Arkiv network, publishing access and transaction fees. |
| P5 — custody and claims | Isolated local contracts, deposits, issuance and pending-delivery accounting | Compatible platform/product decision, chosen settlement network, RPC, test gas, role-owner public addresses and approved test budget. Actual controlled inventory before backed claims are issued. |
| P6 — registry and v4 hook | Official v4 contracts on a local EVM, state reports and simple hook behavior | Verified network-specific PoolManager/router addresses, deployed assets, LP seed funds, initial price/fee/range and a report signer. Confirm halt and withdrawal terms before funds enter. |
| P7 — purchase and delivery | Local bounded purchase/redemption workflow and synthetic delivery accounting | Requester's wallet approval/signature and purchase cap; test tokens/gas, actual backed stock and approved destination. Integrate with Minecraft only after platform suitability is resolved. |
| P8 — acceptance and settlement | Local signed inspection binding, requester acceptance, single claim and refund | Requester-funded labor escrow, public recipient addresses/allocations, agreed deadlines and actual requester acceptance. User signatures remain user-controlled. |

I can choose ordinary implementation defaults, locate official deployment addresses for the selected network, generate disposable local wallets and prepare scripts. The user/hackathon must provide restricted access, funding authorization and genuine human participation. A cloud host/domain is only needed when remote users must reach a shared deployment; local development does not need one.

API credentials belong in local environment/secret storage. Share public addresses and network information; never paste wallet seed phrases or private keys into chat or Git.

## Important compatibility decision

Minecraft's current Usage Guidelines restrict currencies with real-world value/cash-out and mods that use out-of-game ownership to control in-game features. Transferable CRED/KIT tied to Minecraft item delivery therefore cannot be assumed permitted, including merely because a deployment is private/testnet. Hackathon credentials do not resolve this platform issue.

The approved route keeps non-token Minecraft gameplay and tests contracts separately using synthetic inventory. Before any future integrated economy, adopt a design permitted by the platform, obtain the necessary permission, or use a world platform that permits the intended mechanics. No onchain-to-Minecraft economic integration is claimed approved here.

## What the new economics document changes

The supplied832-line document is a proposed economic design study. Its C/R notation does not require replacing current CRED/KIT or adding a governance token. Keep the calculator-first MVP, one immutable KIT promise and one resource pool.

Retain actual backing and burned-but-undelivered obligations: per resource, eligible controlled stock must cover outstanding claims plus pending delivery and other separately owed units. Compute budgets remain separate from game currency. Existing pool depth, not just warehouse inventory, determines execution price/impact.

The older P6 plan gated purchases only. The separate demonstration now implements the update's symmetric halt in `contracts/src/AgentCityHook.sol`: stale or unavailable backing stops both swap directions; ordinary liquidity removal has no hook callback. It uses a static fee. This describes the actual synthetic demonstration and does not renew the original integrated-economy gates.

Dynamic fees, treasury levies, extra commodity pools, TWAMM, lending and insurance are later proposals, not added MVP requirements. Numerical examples are not live prices, measured0G tariffs or guaranteed economic results.

## Official references checked

- 0G Router quickstart: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
- Router endpoint: https://router-api.0g.ai/v1/chat/completions
- Direct inference/account separation: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference
- Minecraft Usage Guidelines: https://www.minecraft.net/en-us/usage-guidelines

Router and Direct balances/access paths are separate. Hackathon or iAI credits must be checked against the actual supported route; ownership of a credit does not automatically fund Router requests. Using0G inference does not select the settlement chain or prove a Uniswapv4 deployment exists on that chain. Avoid adding a bridge simply to combine the diagrams.
