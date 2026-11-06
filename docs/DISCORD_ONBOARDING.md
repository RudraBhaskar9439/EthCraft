# Discord-first local pilot

Discord is the entry point for account setup, agent controls, observed-world images and nonbinding work offers. A verified Discord identity links to one canonical owner and Privy identity. A Minecraft alias is separate: agents may work under an explicit scoped, expiring owner grant before that owner joins Minecraft. Revocation and expiry are checked at receiving boundaries; mentioning another person's agent does not grant control.

This is a local pilot extension. Original calculator, independent-participant, 0G, platform-suitability, funded-chain and requester-signature requirements retain their existing gate history. Planning checks and controlled fixtures do not pass those canonical live gates.

## Operator setup

For the Mac/Linux laptop, prepare public IDs, then run:

```sh
python3 scripts/local_discord_setup.py --application-id DISCORD_APP_ID --guild-id DISCORD_SERVER_ID --privy-app-id PRIVY_APP_ID
```

The helper asks for the **Discord bot token** and **Privy app secret** through hidden prompts. It uses the active laptop server ID and `http://127.0.0.1:8789`; optional `--server-id` and `--origin` set explicit public values. It validates every required input before writing credentials, stages mode600 files in mode700 directories, and publishes the Discord enable flag last. Ordinary write failures roll back. Existing compatible credentials can be retained by leaving their prompts blank; different identities or replacement keys are refused, and existing signing/delegate fields remain untouched.

Alternatively, use `python3 scripts/local_discord_setup.py --env-file /absolute/private/local.env`. The owned mode600 file must be inside an owned mode700 directory and contain nonempty `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `PRIVY_APP_ID`, `DISCORD_BOT_TOKEN` and `PRIVY_APP_SECRET`. Optional `DISCORD_ORIGIN` and `AGENTCITY_SERVER_ID` set public values. The parser accepts literal `NAME=value` lines and simple matching quotes; it never sources the file or expands shell expressions. Unknown/duplicate fields, blank required values and conflicting public CLI arguments are refused. No private values are printed or passed as command arguments.

Optional `DISCORD_AGENT1_APPLICATION_ID` and `DISCORD_AGENT1_BOT_TOKEN` may remain in that private environment file as an inactive, unassigned bot identity. Import preserves them there but does not register, activate or copy that token into the coordinator's runtime credentials. Only `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` select the coordinator.

This prepares identity authentication only. It does not contact either service, log in a bot, create signing policies, write financial deployment manifests or start a worker. Review the configuration and stop any competing bot/agent manager before activation. Privy's login method/origin configuration and a real browser sign-in still need verification. Use a dedicated test bot and guild unless the existing remote gateway has been stopped.

For identity verification alongside an existing Minecraft worker, set the public local Discord setting `identityOnly:true`, then run `node scripts/local_discord.mjs`. This dedicated process starts no agent manager, inference provider or financial runtime. It keeps `/start`, `/profile`, `/join` and a read-only saved `/agents` directory; it neither posts a public startup panel nor drains older notifications. Tasks, work offers, financial controls, DMs and stale buttons are refused. Existing controlled agent ownership remains unchanged. Restart the owned onboarding backend after this mode's code/configuration changes so `/api/discord/config` advertises `walletSetupAvailable:false`; the setup page then hides wallet creation and explains the restriction. The wallet API and remote-agent authorization also reject this mode. Stop any other Discord gateway for the same application before starting it; the existing recovery/gameplay worker may remain running because the identity process takes no game-manager lease.

The [blockchain asset extension](BLOCKCHAIN_ASSETS.md) uses `/assets` for exact
resource lots, equipment, land/house deeds, finite test funding and hooked Uniswap payments.
Account setup stays in Discord and its secure browser; Minecraft applies
confirmed ownership and provides estate visits and item collection.

All new Minecraft sales settle in CITY on Unichain Sepolia. `/bazaar` browses
the CITY market and recovers older escrowed stock; it cannot create another
internal-currency trade. See [marketplace usage](GAME_MARKETPLACE.md) for
registration, confirmations, owned-agent sources and mailbox claims.

1. Create a Discord application and install its bot in the intended test guild. Configure the public application, guild and optional panel/work-channel IDs in ignored `.local/discord/settings.json`. The bot uses pinned `discord.js` 14.28.0; request only the permissions/intents actually used by the configured commands.
2. Enter the bot token through the hidden-input WSL helper `python3 scripts/discord_credentials.py`, or the locally generated `.local/setup/configure-discord.cmd`. It stores credentials outside Git in private WSL storage. The helper expects the operator-prepared settings or pending-settings file; it does not create a Discord application. Never paste bot tokens, Privy secrets, login tokens or private keys into Discord, source files or evidence.
3. Enable Discord login/account linking in the existing Privy application and configure its approved origin/callbacks. Preserve the existing Privy app and wallet-owner/delegate configuration. Existing owners sign into their existing account before linking Discord; a new Discord login must not replace an existing funded owner's Privy identity or wallet.
4. Start the coordinated owned server/backend/worker and bot runtime. Discord registration and command installation require the actual bot token and guild configuration; no live Discord delivery has been established without them. Browser setup is served at `/discord/setup`; completion and wallet setup use the same approved origin.
5. Keep the renderer private at `127.0.0.1:8793`; follow [renderer setup](../renderer/README.md). It receives bounded observations, not credentials, world-file mounts or permission to control Minecraft.

The public settings file contains `applicationId`, `guildId`, `origin`, `serverId` and `enabled` (initially false). The credentials helper adds only the private file reference and enables the bot. Optional `panelChannelId` selects an existing writable text channel; otherwise the bot chooses one. No privileged Message Content intent is needed for slash commands, DMs and mentions of this bot. `node scripts/discord_setup.mjs --invite` prints the minimum-permission invite; `--status` prints public readiness, `--check` verifies actual bot/guild access and `--register` installs guild commands. Run credential-dependent commands in WSL with the prepared Node runtime. These commands never display the token.

In Privy, enable **Authentication → Login methods → Discord**. Default provider credentials are suitable for development if offered. With custom credentials, enter the Discord OAuth2 application ID and Client Secret in Privy, then add `https://auth.privy.io/api/v1/oauth/callback` to the Discord application's OAuth2 redirects. The OAuth2 Client Secret differs from the bot token. Existing wallet owners retain email/passkey login and link Discord after signing in. See [Privy's configuration guide](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods).

The default onboarding origin is `http://127.0.0.1:8789`. That URL reaches the host's own computer only. Friends on other computers need a separately configured reachable HTTPS origin and matching Privy/backend origin settings. Do not describe a localhost link as multiplayer onboarding or expose the renderer/plugin API to solve this prerequisite.

## Organized server and agent bot identities

The organized server uses three managed categories: START HERE, COMMUNITY and WORKSPACE. Welcome, agent directory, jobs and transactions are read-only boards. General chat stays writable. Each linked agent owner gets a private room with one persistent control card; `/agents` links that room instead of printing more cards. Screenshots and progress are delivered privately. Server administrators can access private guild rooms. Existing channels and messages are preserved.

The coordinator needs Manage Channels and Manage Roles for creation and access rules, alongside its existing message permissions; Administrator is unnecessary. `node scripts/discord_setup.mjs --invite-organized` prints that invitation. `node scripts/discord_layout.mjs --plan` checks permissions without channel writes. `--apply --agents <operator-json>` explicitly provisions rooms for `[{"slotName":"CityAgent2","ownerDiscordId":"..."}]`. Durable IDs prevent name-based adoption or duplicate retries after uncertain results. Enable `organizedServer:true` in private local settings to activate the live experience.

Every agent can have a separate **real Discord bot account** and DM inbox. These identities require separately created Discord applications and tokens. The generic registry has no two-agent restriction. The source supports three physical agent slots after the [coordinated plugin/worker/whitelist upgrade](AGENT_CAPABILITIES.md); an unchanged live host retains its earlier capacity. This change does not create unlimited Minecraft capacity or automatically create Discord applications. Unconfigured profiles are explicitly marked as awaiting provisioning.

Creation automation was researched separately. Discord's [official OpenAPI](https://github.com/discord/discord-api-spec/blob/main/specs/openapi.json) does not document an application/bot creation endpoint for bot tokens. Original community code such as [discord.py-self](https://github.com/dolfies/discord.py-self/blob/master/discord/http.py) contains user-authenticated application creation routes; that is evidence of an undocumented approach, not a verified supported service. Browser-assisted portal setup likewise requires an authenticated operator and any human verification. Neither route was executed or added to this runtime. A pool of operator-created real bot identities could support automatic assignment, but that allocator is not implemented by the current explicit per-agent registry. Application Identity Profiles are game-stat records, not additional bot accounts or DM inboxes.

For each registered agent, create its bot application in the Discord Developer Portal, then run `python3 scripts/discord_agent_credentials.py --agent AGENT_NAME` inside WSL. Enter the public application ID and the token at its hidden prompt. The helper writes a mode600 file inside a mode700 private directory; never paste tokens into chat. `--list` prints public readiness and `--invite` prints bot invitation links. Configure `agentCredentialsFile` to that private file. Credentials can cover any registered agent identifier; a separate token/client is required per bot. The coordinator grants each ready bot access only to its owner's room. Owner DMs execute existing scoped task requests; other verified server members can send work requests but cannot control the agent. Bot messages never trigger other bots.

The jobs board contains redacted task states and nonbinding CITY offers. Job conversations have private participant rooms. The transaction board shows verified canonical Unichain Sepolia receipts with explorer links; older activity is archived and earlier stock listings are withdrawal-only. The feed itself never signs or creates payments. Submitted transactions, synthetic/local-chain fixtures and account-enrollment details are not published as confirmed public receipts. Accepted work quotes still require their own funded execution integration; quoting alone never pays an agent.

## Account and play flow

Use `/start` and the private setup link. New players continue through Discord. Existing wallet owners use the existing-account login first, then **Link my Discord account**. The backend verifies the Privy token and the matching Discord OAuth subject; display names and email similarity do not establish ownership. Finishing setup consumes the opaque challenge once. Creating/viewing the managed testnet wallet is a separate browser action and does not fund it or authorize transactions.

Use `/profile` to reserve the server username and login route, then `/agents` or `/agent` for the personal agent. A remote grant names the owner, agent, plot, permitted physical/read-only tools and expiry. It grants no wallet, transfer, sale, swap or job-payment authority. Work requires actual carried/chest materials and the existing task journal, locks and permission checks.

On joining Minecraft, `/join` approves the actual pending player UUID and connection ID. A username reservation is not account verification. The local server-profile route accepts either Microsoft or TLauncher clients and establishes control of that Discord-approved local connection. Microsoft account verification on the current offline-mode host is unavailable; the Discord command refuses that route before reserving a name. `microsoftLoginSupported` must stay false until real server/provider authentication exists; enabling a UI setting alone cannot satisfy the plugin's Microsoft authentication check. Existing funded wallet rows, provider IDs, addresses, keys and original owner IDs are preserved when adding Discord aliases.

For a Discord-linked player, Minecraft `/wallet` reads the existing managed test wallet after checking the current approved connection and stored provider ownership. It does not start the older game enrollment flow, create another wallet or authorize spending. Complete setup and manage the account through `/wallet` in Discord. An unapproved or stale connection cannot disclose the wallet.

**Pause** retains the current task for **Resume**. **Update**, **Screenshot** and **Supplies** remain available while work is paused. **Cancel task** explicitly abandons only a quiescent physical task with no recorded effects, pending operations or carried items; it preserves the cancelled workflow and task history. Tasks with material effects still require reconciliation before different work can begin.

`/work`, `/worklist` and `/offer` exchange bounded requests and immutable quote versions. Only the provider owner can quote; only the requester accepts the exact quote. Agent bidding is denied by default without an explicit owner policy. Acceptance means **terms accepted, awaiting funding**. It does not reserve money, execute a job, remove materials, create escrow or pay anyone. Later funding must attach to the same immutable parties, quote ID, digest and deadlines through a separately implemented authorization path.

## Images and verification

Images come from an existing Mineflayer bot's actually loaded bounded world cache. Native Prismarine Viewer renders an independent overview camera and records observation time, world, agent and block/PNG hashes. This is not the player's Minecraft framebuffer, a full-world snapshot, proof of unobserved blocks or a substitute for physical calculator inspection. Viewer 1.33.0 assets target 1.21.4; the adapter maps observed 1.21.11 semantic block states explicitly and refuses unsupported states. A synthetic renderer fixture is labelled as such.

Focused local checks:

```sh
node tests/playable/discord-identity.mjs
node tests/playable/discord-work-orders.mjs
node tests/playable/remote-agents.mjs
```

These use controlled fixtures and do not establish live Discord OAuth, message delivery, Microsoft authentication or independent-human acceptance. Actual receiving-boundary and agent checks are in `tests/playable/discord-access-live.cjs` and `tests/playable/discord-agent-live.mjs`; run only in the coordinated owned-server window and preserve every failed attempt. A real second participant must complete their own Discord/Privy link, connection approval and permission checks. A second bot identity is not that participant.

Planning changes require WSL `python3 -m unittest discover -s tests -v` and `python3 scripts/check_plan.py`. They verify planning infrastructure only. New shared dependency/interface paths reopen affected evidence; no canonical evidence record is rewritten by this guide. See [upstream reuse and licenses](UPSTREAM_REUSE.md).
