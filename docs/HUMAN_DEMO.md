# Human wallet demonstration

This is the separate synthetic contract demonstration on Unichain Sepolia (chain 1301). Contract purchases, stock, construction, inspections and payments have no effect on Minecraft items, access or gameplay. The contract demonstration uses one KIT, exactly 6 test CRED labor, and at most 3 test CRED for materials. Real spending stays at $0.

The implementation is prepared for human wallets. Preparation and fixture checks do not establish a completed human demonstration. Two genuine Microsoft-authenticated Java identities, two WalletLink signatures and two agreement approvals remain prerequisites. The official launcher showing Play Demo does not establish a Java multiplayer entitlement.

## Before creating the timed agreement

Open `http://127.0.0.1:8789/human` in Brave. The page checks the retained identities, exposes private wallet links only on an explicit click, and enables the timed agreement only after both identities are verified. It derives transaction senders from the pinned participants. The trusted operator confirms test-resource provisioning and synthetic construction separately; each participant confirms their own wallet requests.

TLauncher may be used when Microsoft authentication provides a valid Java session. Its “Authorization without a password” accounts cannot satisfy the online login check. A Microsoft account alone does not prove Java entitlement: the selected account must own or otherwise have active access to Java Edition. Keep authentication enabled when a launcher reports missing entitlement or an invalid session.

1. Each participant joins the owned direct online-mode probe with an entitled Java account and types `/walletlink THEIR_PUBLIC_WALLET`.
2. Each participant approves their private WalletLink request with their own wallet. They may use the same computer sequentially. A historical link proves control during its verified login; it does not establish simultaneous multiplayer or a current authenticated web session.
3. The trusted operator checks both recorded identities before creating the final timed agreement:

   ```sh
   node scripts/human_demo.mjs --identities REQUESTER_WALLET BUILDER_WALLET
   ```

4. Create the fresh agreement and collect both explicit wallet approvals using the existing private agreement handoffs. Work ends one hour after the immutable start; review/pass/absolute expiry end 75 minutes after start. Expired earlier unsigned records remain retained.
5. Register that approved agreement:

   ```sh
   node scripts/human_demo.mjs --register AGREEMENT_HASH
   node scripts/human_demo.mjs --funding-plan AGREEMENT_HASH
   ```

Registration requires two distinct recorded player UUIDs and wallets whose consumed challenges predate agreement creation. It pins their private identity snapshots, the canonical agreement, chain instance, one local workflow job, and stable operation IDs. Pinned terms cannot be replaced, including while a transaction outcome is unknown. Public discovery must not expose Microsoft names, email addresses or raw game UUIDs.

The funding plan reads balances and allowances only. The requester needs up to 9 test CRED and faucet ETH; the builder needs faucet ETH for their own claim. It does not mint, transfer, fund, or open a keystore. Test CRED distribution and operator gas remain separately disclosed test subsidies and require readiness before any transfer.

## Wallet and operator sequence

| Step | Actor | Action | Verification before proceeding |
| --- | --- | --- | --- |
| 1 | Requester wallet | `approve_escrow` | Exact token/spender/6 CRED allowance transaction |
| 2 | Requester wallet | `fund` | Canonical matching Funded event, two confirmations, fixed builder allocation |
| 3 | Requester wallet | `approve_procurement` | Exact procurement spender and bounded material allowance |
| 3a | Disclosed publisher operator | Refresh expired synthetic market status | Explicit click, retained publication ID, canonical receipt and fresh registry availability before quoting |
| 4 | Requester wallet | `buy` | One KIT, 3 CRED maximum, fixed destination, immutable 60-second quote, canonical Purchased and ClaimCreated events |
| 5 | Disclosed operator | Synthetic delivery and acknowledgement | Canonical receipt block and claim fields; exactly one durable bundle receipt; verified chain acknowledgement |
| 6 | Local model and disclosed attestor | Synthetic construction and inspection | Actual local Ollama proposal, fenced operation, exact material consumption, protected synthetic 16-case report |
| 7 | Requester wallet | `accept` | Exact protected report; pending lock and durable external intent commit together; canonical matching Accepted event |
| 8 | Builder wallet | `claim` | Canonical acceptance first; builder signs their own fixed pull claim |

`refund` remains the requester-controlled contract timeout path under the signed deadlines. A model or operator cannot accept or claim for a human. The workflow never receives human private keys and never automatically submits their transactions.

Every action has one durable ID. A lost wallet reply or unknown broadcast retains the original nonce, transaction body, quote and full reservation until canonical reconciliation. It must not create a second purchase. Known reverts and expired prepared requests require explicit operator review; there is no automatic fresh quote or nonce. A review-link timeout cannot cancel already mined canonical funding. The protected synthetic world stays locked while an acceptance outcome is unknown, including after the pass expires.

## Integration interface

`openHumanDemoRuntime()` opens the PostgreSQL records and public RPC only. It returns `{store, client, deployment, external, workflow, close}` and wires both trusted external-service callbacks. It never opens a private keystore.

- `workflow.register(hash)` pins approved terms and earlier verified identities.
- `workflow.prepareAction(hash, action, wallet)` uses the stable operation ID and returns the immutable wallet transaction request. For `buy`, it persists the first bounded quote.
- `external.recordSubmittedHash(id, hash, wallet)` records the human wallet's submitted transaction. `external.reconcile(id, wallet)` verifies its canonical outcome.
- `external.beginBroadcast(id, wallet)` durably marks the intent unknown before releasing its transaction request once. The browser sends only after that explicit step. A known wallet rejection can reopen that same nonce and request while still valid; uncertain replies require the original hash from wallet activity.
- `workflow.sync(hash)` reconciles existing actions, records verified funding, and releases a protected lock only after verified acceptance.
- `workflow.fundingPlan(hash)` reads test balances and allowances without transfers.
- `workflow.advanceSynthetic(hash, {operator})` requires explicit readiness and an injected disclosed operator `{ready:true, evm, attestor, acknowledgeDelivery}`. It stops before human requester acceptance. The acknowledgement callback must use the supplied stable operation ID and reconcile its own original warehouse transaction.

The operator's EVM adapter must use the same pinned public chain instance and the runtime's public client. Load only warehouse and attestor operator roles; the older developer demo runtime also opens developer requester/builder keys and must not stand in for human participation. Publishing a fresh synthetic-health state is a separate operator responsibility before purchase; it is not an automatic funding action.

`createHumanDemoOperator(runtime, {ready:true})` supplies the narrow adapter. Its `advance(hash)` unlocks only warehouse and attestor, verifies their deployed roles, acknowledges the original delivery operation, and calls the synthetic workflow. Its read-only `summary(hash)` includes the funding plan and disclosed roles. Its explicit `publishHealth(hash)` opens only the publisher, checks synthetic backing, and journals one report before sending. An uncertain report retains its original operation, sequence and deadline. Only canonical completion permits a later refresh. Status and purchase preparation never publish; the console presents a separate button when the market needs refreshing.

Its separately invoked `provisionTestResources(hash)` requires the two private verified identity snapshots and cryptographically valid human agreement signatures before opening issuer/admin keystores. It persists one immutable plan before sending anything: the requester's initial deficit up to 9 test CRED and the builder's initial deficit up to 0.0002 faucet ETH. Only needed roles are opened. Replays retain these original amounts/IDs and reconcile the original receipts, including after recipients spend their balances; they never compute another top-up. A new plan or new unsigned operation is refused once human funding/purchase has started. Existing native-budget guards remain unchanged; insufficient role funds or an exhausted cap is reported as blocked. This function is not called by runtime opening, registration, status, summary, or tests against the public network.

The CLI supports `--status AGREEMENT_HASH` for reconciliation and the two read-only/preparation commands above. None of its commands sends a public transaction. The laptop console remains loopback-only without shared per-user authentication; do not tunnel it as a shared release.

## Focused verification

Run `node tests/workflow/human-session.mjs` and `node tests/workflow/human-web.mjs` for pinned operation authority and browser-provider fixtures. Run `node tests/workflow/human-health.mjs` for freshness, explicit publisher authority and retained unknown publication checks. Run `node tests/workflow/human-http.mjs` against the local console for HTTP boundaries and redacted status. These checks do not supply human signatures, authenticate a real Java account or send participant transactions.

Run `node tests/workflow/human-demo.mjs`. It uses an isolated real PostgreSQL schema, real ephemeral fixture signatures, an actual local Ollama decision, and explicitly scripted chain/session/operator evidence. It checks identity ordering, immutable terms/roles/operation IDs, one bounded provisioning plan with no repeat top-up, fixed budgets and unknown purchase reuse, canonical claim binding/reorganization refusal, one synthetic delivery/build/report, and protected manual settlement. Its simulated logins, purchases, resource transfers and acceptance do not pass genuine-human or public-transaction gates.

Existing external-wallet tests verify transaction construction, authority, fee/material reservations and receipt reconciliation. Real acceptance still requires genuine identities, explicit signatures, the selected funded test wallets, actual canonical public receipts and a builder claim/replay that pays zero additional CRED. Real 0G verification remains pending until hackathon access is supplied.
