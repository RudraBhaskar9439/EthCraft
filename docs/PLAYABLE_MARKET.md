> **Historical CITY/GEM checkpoint.** The active UniRock market uses [CITY/mock-tUSDC](TESTNET_MARKETPLACE.md) and [optional LP investments](UNIROCK_INVESTMENTS.md). This file preserves the earlier route and evidence, not a claim that its pools are approved by the current investment service.

# Conversational agents and managed testnet wallets

On 31 October 2026 the owner explicitly requested a private playable Minecraft
testnet integration and server-managed wallets using production custody tooling.
This extends the earlier separate-demonstration route. Historical evidence and
canonical platform, identity, 0G and release requirements remain unchanged.
Neither a working private pilot nor the choice of a custody provider establishes
production qualification.

Verified in this checkpoint: actual conversational delivery, collection and
Game Coin sale; actual public Uniswap developer swap and replay; actual Privy
login binding, managed player/treasury account provisioning, separate owner and
delegate policy verification, finite faucet-funded allocations, and one managed
treasury signing grant with zero extra effects on retry. The managed grant is
not a Minecraft inventory sale or a human-approved player swap. Those integrated
player flows still require their own live verification.

## Play and speak naturally

Run `.local/setup/start-world.cmd`, join `127.0.0.1:25596` as Ruddy, then use
`/play` and `/agent create`. The agent uses local Ollama `qwen3:4b`, conversation
history, observed inventory and task progress. For example:

On a new host, install that model with `ollama pull qwen3:4b` before starting
the worker. The playable worker defaults to the model used in its language
checks; the separate historical contract demo retains its original provider.

```text
@agent Put a couple of cobblestone in my destination, then sell four more for Game Coins.
@agent What are you doing?
@agent Stop that.
@agent Resume.
```

`/agent <natural request>` also works. Exact legacy commands remain available.
The model produces at most six tool steps. A later step runs only after the
receiving tool confirms completion; ambiguity asks a question. Stop/restart
preserves unfinished tasks, material receipts and stable operation IDs. The
executor still restricts physical work to the registered tools and task areas;
mining, crafting and arbitrary structures are not implemented.

## Identity and custody

Player wallets use the official `@privy-io/node` SDK, protected signing and
provider policies. Player EVM keys are not generated or exported by this app.
The developer deployment keystores are separate Foundry-encrypted testnet roles;
they are not the production player custody implementation.

1. `/wallet` sends a short-lived login link for the current game connection.
2. Sign in through the companion page with email or a registered passkey.
3. On first use, the operator explicitly approves the public Privy user ID for
   the known Minecraft player. No offline username can enroll itself.
4. Select **Link this game connection**, then run `/wallet` again in Minecraft.

Login does not ask for an EVM wallet signature. The backend verifies the Privy
token's signature, app, issuer and expiry. Authorization is tied to the fresh
plugin connection ID; reconnecting requires a fresh login link. Raw login
capabilities live in URL fragments; PostgreSQL stores only their hashes. JWTs
and provider secrets are not persisted in authentication records.

The local operator enrollment command is:

```text
node scripts/playable_wallet_enroll.mjs --player Ruddy --subject did:privy:PUBLIC_USER_ID
```

The command approves initial enrollment, not a wallet transaction or a relink.
The player still completes their own verified browser login.

For receive-a-fixed-amount swaps with a bounded input, see [exact-output swaps](UNISWAP_EXACT_OUTPUT.md). This requires a verified replacement router and explicit capability enablement.

## Wallet and market commands

```text
/wallet
/market
/market sell cobblestone 4
/market retry SALE_ID
/swap 2 CITY GEM
/swap confirm PREVIEW_ID
/swap retry PREVIEW_ID
```

CITY and GEM are dedicated capped demonstration ERC20s on Unichain Sepolia,
chain 1301. Their pool uses official Uniswap v4 infrastructure and a fixed custom
router built with the official SafeCallback primitive. They are distinct from
the historical CRED/KIT contracts. No Minecraft-item redemption or cash backing
is promised for these test assets.

Swaps use an actual v4 quote, an exact input amount, minimum output, bounded
slippage and a deadline. A preview does not sign or broadcast. Only explicit
owner confirmation records consent. Retrying an unconfirmed preview cannot
authorize it. Confirmed swaps require canonical router, PoolManager and ERC20
transfer evidence. The output goes to the original wallet.

The separate `/balance`, `/pay` and `/sell` commands retain internal Game Coins.
They are not ERC20 balances. A crypto inventory sale requires real item removal
and a finite, funded CITY treasury. Missing funds or gas stops removal. Unknown
removal/payout results retain the same reservation and claim; retries do not
invent a replacement sale. The initial fixed catalog is cobblestone at 1 CITY
and oak planks at 2 CITY per item, at most 64 items per sale.

Natural CITY sale/swap instructions can propose these steps. The language model
cannot change wallet owners, mint tokens, choose arbitrary recipients, sign
arbitrary messages or confirm a spending quote for the player.

## Operator configuration

Non-secret references live in ignored
`.local/playable-testnet/wallet-settings.json`. Provider App Secret and P-256
authorization private key live in a mode-600 file inside a mode-700 WSL ext4
directory. The application rejects NTFS mode-777 credential files and a missing
managed provider; there is no silent fallback to local player keys.

The companion uses pinned React and Privy packages. Build with
`npm ci` and `npm run build` in `companion/`. Its generated bundle and linked
third-party license notices are served by the existing backend. The player
routes are separated from the trusted loopback operator routes. A configured
HTTPS player origin still needs actual TLS/reverse-proxy deployment verification.

```text
node scripts/playable_testnet_setup.mjs --authorize-privy
node scripts/playable_testnet_setup.mjs --configure-policy
node scripts/playable_testnet_setup.mjs --update-treasury-policy
```

The setup CLI preserves existing credentials and verifies policies before
activation. Player and treasury policies are separate. Treasury recipients are
registered managed wallets; expansion requires an explicit policy update that
preserves the funded wallet and refuses unresolved treasury intents. Broadcast
defaults to disabled. Enabling it requires verified public deployment, policies,
funding and the intended authorized operation.

The public market pointer is `.local/playable-testnet/market.json`. The actual
local development market is independently recorded under
`.local/playable-market/deployment.json` on port 8559. Local addresses are never
relabeled as public deployment proof. Public setup/recovery retains original
nonces, signed bytes and operation IDs and caps the combined developer native
budget at 0.008 faucet test ETH. No real-money spending is authorized.

## Qualification still required

The custody architecture is intended for a production deployment, but readiness
still requires managed-player end-to-end spending and inventory-sale verification,
provider/dashboard export controls, secret rotation, secure game transport and
host exposure, operating recovery and independent review. Owner administration
uses a separate key file and quorum; the worker uses a restricted delegate. Files
owned by the same WSL Unix user do not establish an operating-system boundary.
The deployment candidate excludes the owner key from runtime mounts.
The current offline
game login alone is not a production identity boundary. Test fixtures, a provider
API response and a successful developer swap do not pass those release gates.

An App Secret exposed in chat must be rotated before production use. The
production service must receive replacement credentials through private secret
storage, not source code or language-model prompts.

The official login SDK dependency tree still contains unresolved Zod,
decode-uri-component and UUID advisories. Compatible WebSocket patches were
applied; unsafe API-major overrides were not forced. The packaging evidence
retains exact before/after audit data. Production release stays blocked pending
supported remediation and verification.

Primary integration references:

- [Privy policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)
- [Privy access-token verification](https://docs.privy.io/authentication/user-authentication/access-tokens)
- [Privy protected transaction signing](https://docs.privy.io/wallets/using-wallets/ethereum/sign-a-transaction)
- [Official Unichain testnet faucets](https://developers.uniswap.org/docs/unichain/tools/faucets)
