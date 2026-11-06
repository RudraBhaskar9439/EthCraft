# Human wallet approval handoff

The wallet page records explicit approval of a prepared test agreement, or an optional authenticated identity challenge. It uses the injected EIP-1193 wallet in Brave. It never asks for a private key, recovery phrase or password, signs on another person's behalf, funds an agreement, or submits a transaction. Minecraft continues to use internal materials and has no economic connection to these approvals.

The supplied primary requester address is `0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f`. Its public address does not prove control. The builder supplies their own public address at final participant testing. The trusted local operator can prepare unsigned drafts using those public addresses. Preparation tests created two pending requests with zero signatures or transactions; no primary-user or independent-human approval has been collected.

## Small server integration

`backend/src/identity/handoff.mjs` exports `createHandoffService` and `HANDOFF_SCHEMA_SQL`:

```js
const origin = 'http://127.0.0.1:8789'
const handoffs = createHandoffService({
  store, agreements, identity, deployment, origin
})
await handoffs.initialize()
```

Use the current public-testnet deployment (`chainId: 1301`, `environment: PUBLIC_TESTNET_SYNTHETIC_ONLY`) and the existing agreement service for that deployment/schema. Root's initial HTTP integration exposes agreement approvals only. Leave `identity` absent until an actual authorized game/session source is configured; a fixture resolver must not be installed in a human endpoint. The optional identity service must use the same origin and chain and a genuine trusted session resolver. Identity preparation refuses missing or logged-out sessions. A browser flag, an invented UUID or a TLauncher connection cannot establish authenticated game control. The agreement approval path does not require connecting wallet balances to Minecraft access.

The trusted local operator first prepares a **new unfunded** canonical agreement containing the intended humans' public addresses, exact fixed allocations, material cap and deadlines. Creating an unsigned draft does not authenticate those people or approve its terms. Do not modify or reuse the parties of a funded demonstration job. The existing agreement service validates the draft. Then prepare one scoped request for each required signer:

```js
const prepared = await handoffs.prepareAgreement({ agreementHash, account: participantPublicAddress })
const link = origin + '/wallet#' + prepared.urlFragment
```

If genuine session linking is needed separately, call `handoffs.prepareIdentity({ playerUuid, sessionId, wallet })`. The session ID must be a non-secret identifier supplied by the trusted session authority, never a bearer credential. This links identity only; it does not approve an agreement or grant gameplay rights.

Preparation stays behind the trusted operator boundary. The public page cannot choose typed data, recipients, contracts, amounts or signing methods. Prepared payloads are immutable in PostgreSQL, expire within five minutes, and have random scoped access tokens. Give the link only to its intended participant. Its token remains in the URL fragment/session storage and request header; do not commit links or log tokens.

Root owns these small HTTP routes; the handoff implementation does not edit `server.mjs`:

| Route | Fixed behavior |
| --- | --- |
| `GET /wallet` | Serve `backend/src/web/wallet.html`. |
| `GET /wallet.mjs` | Serve only the corresponding fixed module. |
| `GET /wallet.css` | Serve only the corresponding fixed stylesheet. |
| `GET /api/wallet/handoffs/:id` | Call `handoffs.get(id, request.headers['x-agentcity-handoff'])`. |
| `POST /api/wallet/handoffs/:id/signature` | Require the exact configured `Origin`, JSON body no larger than 4096 bytes and the scoped header; call `handoffs.submit(id, token, body)`. |

The current console has no per-user login or application roles. Its loopback binding, Host checks and same-origin/CSRF token protect the local browser boundary; they are not shared-user authentication. Anyone given access to a forwarded console can obtain its operator token and invoke demonstration buttons backed by the configured testnet developer-role wallets. **Do not forward, tunnel or expose this console as a shared participant UI.** Public/shared web release remains blocked until real user authentication and role authorization exist. A scoped wallet-approval link verifies its expected signer; it does not grant or isolate console operator rights.

Send `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a same-origin-only CSP with framing disabled. Do not add wildcard CORS or a public arbitrary preparation/signing endpoint. The POST body has exactly `account`, numeric `chainId`, `consent: true`, and `signature`. Server verification checks the expected signer, chain-1301 typed-data domain and immutable contract/amount/scope hashes, then delegates to the existing agreement or identity service. A durable receipt is idempotent; it does not certify independent-human participation.

## Final participant steps

1. The operator records the actual requester and builder public addresses and prepares fresh unfunded terms. Both people review the same addresses, labor allocations, material purchase cap, work/review/pass deadlines, scope and exact contract addresses. The page displays only test amounts.
2. Open the participant's prepared link in Brave with the intended injected wallet enabled. Select **Unichain Sepolia, chain 1301**, and the exact expected account. Click **Connect my wallet**. The page refuses a different account or network.
3. Read the complete review, expand the exact terms if needed, tick the explicit consent box, and click **Sign this approval**. Inspect the wallet's typed message before approving. Declining leaves the request pending. An account/network change requires another review and connection.
4. The server verifies and retains the signature once. The page confirms that approval was recorded and that no transaction was submitted. Repeat for the other required signer using their own wallet and prepared request.
5. Separately, the human requester controls any token allowance, funding, bounded purchase and final acceptance transactions. Each human claimant controls their own claim transaction. Those transaction screens and confirmations are outside this signing page; review the latest exact contract/terms again before sending. Test gas and test assets must be available. No production money or Minecraft items are involved.
6. Observe both actual participants completing the final review/acceptance flow and retain its genuine signatures and canonical transaction receipts. Record independent control and comprehension separately. Fixture signatures and a public wallet address cannot pass that final human test.

An agreement signature approves its displayed terms and can remain usable under the contract deadlines after the review link expires. New agreement review links last at most fifteen minutes, capped by the agreement's signed approval deadline; existing requests and deadlines remain immutable. Identity challenges keep their own session-bound expiry. Expiring a link does not revoke an already issued signature. The helper uses only the fixed `Agreement` and `WalletLink` EIP-712 schemas through `eth_signTypedData_v4`; it never calls `eth_sendTransaction` or signs arbitrary typed data. Regular 65-byte account signatures are supported; contract-wallet signature verification is not implemented.

The fifteen-minute review update passed [seven focused fixture/PostgreSQL checks](../tests/identity/runs/handoff-c1c1aa49-0ec8-4bda-8c8c-251b7c8af4d7/report.json), including the longer-review cap and unchanged signed deadlines. Human approval remains a separate live check. Browser tab titles show the expected wallet so two participants on one computer can select the right request.

The page checks expiry while it is open and before wallet actions. Expired requests disable connect, consent and signing, with a **Prepare fresh approval pages** link beside the controls. Wallet feedback appears in that same area, and the review expiry uses the browser's local time zone. Recorded approvals remain recorded after link expiry. `node tests/identity/wallet-expiry.mjs` verifies the expiry boundary and refusal before any wallet call; the actual expired view and recovery link were checked in Brave.

For two people using this computer, open the local console in Brave and select **Prepare approval pages** when both are ready. The operator-only endpoint uses the privately configured participant addresses; browser input cannot choose accounts or signing schemas. Repeat preparation keeps the same live requests and recorded approvals. When both unsigned requests have expired, the next explicit preparation creates new unsigned terms. A partially approved expired agreement requires operator review rather than silently discarding its approval. Private request links are returned only to this local operator action and remain outside Git and status reports.

The [separate online-authentication probe](../tests/identity/online-auth-probe/README.md) now supplies the real game-session resolver when its owned server is running. Each person signs into entitled Java through the official launcher, joins `127.0.0.1:25598` and enters `/walletlink` with their own public wallet address. Only that trusted game event can supply the player/session binding for a WalletLink challenge. Both challenge creation and signature consumption recheck the live session; there is no fixture fallback. The software checks passed, but actual human joins and WalletLink signatures remain pending.

## Verification and remaining work

Run `node tests/identity/handoff.mjs`. The six focused checks use an isolated real PostgreSQL schema, local fixture signatures and a scripted EIP-1193 provider. They verify immutable deployment/amount binding, scoped access, wallet account/network changes, declined consent, unsupported schemas, exact server signature verification, idempotent approvals, existing identity/session rules and funded/expired/foreign-record refusal. The funded-state refusal uses a clearly scripted funding verifier in the fixture; it does not establish live funding. They make no public RPC call or transaction. The final focused report is [handoff verification](../tests/identity/runs/handoff-613b6d1a-2beb-44b1-b5bd-cbd6113122a3/report.json).

Real Brave approval by the primary user, the independent participant's wallet/session, and human-controlled funding/acceptance/claim transactions remain pending until actually exercised. HTTP integration, provider checks and unsigned preparation tests do not substitute for those actions. The earlier complete local/public demonstrations and physical Minecraft results remain historical evidence; this page does not turn their fixture roles into human approvals.

## Laptop HTTP integration

The laptop server now serves the fixed wallet page/assets and capability-protected GET/signature endpoints. Preparation remains an operator action; there is no public request-creation endpoint. The HTTP path loads no private keys, submits no transactions and does not expose a fixture Minecraft identity resolver. Wrong origin, missing request capability and oversized bodies are refused.

Validate a draft without creating a request:

```sh
node scripts/prepare_human_approval.mjs --builder BUILDER_PUBLIC_ADDRESS --check
```

When both participants are present, omit `--check` to prepare fresh unfunded terms for the supplied primary requester and the specified builder. The command writes two private role shortcuts under `.local/human-approvals/`; it prints only their directory and the public agreement hash. Open the corresponding private HTML shortcut locally in Brave. Links contain capabilities: share each only with its intended participant and keep them outside Git and chat. The current loopback host does not provide remote participant access.

Preparation/signature approval does not fund or accept a contract. User-controlled onchain funding and final acceptance still require their separate wallet transactions and canonical receipt checks. No actual primary-user signature or independent-human acceptance has been claimed.
