# Direct online-mode identity probe

This standalone probe verifies Minecraft Java session authority without changing the adopted game host, its JAR/config, the user's server on 25588, or any contract. It uses the cached pinned Paper 26.3 build 231, Temurin 25 and ViaVersion/ViaBackwards 5.12.2 artifacts from `config/minecraft-runtime.json`. Its world and random container owner are separate under ignored `.local/online-auth/`.

```sh
python3 scripts/online_auth_probe.py start
python3 scripts/online_auth_probe.py status
node tests/identity/online-auth-probe/checks.mjs
```

Only the probe uses game port **127.0.0.1:25598** and protected control port **127.0.0.1:25599**. Startup reuses only an exact owned instance, preserves its world, refuses occupied/foreign ports, checks cached artifact hashes and never starts the official launcher. The 0600 API token is separate from the public per-login session UUID and is never included in a wallet message. No control API accepts mutation requests.

The plugin refuses offline mode, Bungee/Velocity forwarding and proxy-protocol mode. Actual `PlayerJoinEvent` records come from the direct online-mode engine; `PlayerQuitEvent` immediately removes live authority. Every login has a new public `sessionId`, and every server process has a new `serverBootId`. A fresh main-thread snapshot supplies connected state and a short current expiry. Empty readiness proves software configuration only: it does **not** verify any human, Java entitlement or wallet.

## Actual human steps

1. Finish the current wallet agreement review first. When ready, each person opens the installed official Minecraft Launcher and signs into their own Microsoft account themselves. They need a usable Java profile/entitlement; a Microsoft account or Demo-only installation is insufficient. The agent never handles passwords, launcher access tokens or recovery codes.
2. Join **127.0.0.1:25598** from the signed-in Java client. Native 26.3 is the simplest path; the pinned Via pair also supports the existing 1.21.11 protocol. Keep this game connection open through identity signing. Joining this server does not require a wallet or token balance.
3. In the game, type `/walletlink YOUR_PUBLIC_WALLET_ADDRESS`. The server binds that address to the actual authenticated player UUID and current login. It accepts the same address again, but refuses a changed address for that login. To change it, disconnect/rejoin and start a new session. This pairing command grants no items, rewards, operator rights or gameplay access.
4. The trusted local operator lists only genuine player-initiated pairs:

   ```sh
   node scripts/prepare_human_identity.mjs --list
   node scripts/prepare_human_identity.mjs --player AUTHENTICATED_PLAYER_UUID
   ```

   The command obtains the wallet from the protected game authority; the operator cannot substitute a wallet argument. It writes a private identity-review shortcut under `.local/human-identities/` and does not print the capability link.
5. Open that private HTML shortcut in Brave. Verify the expected wallet, server and player UUID, select Unichain Sepolia 1301 and sign the fixed **WalletLink** identity message yourself. This is separate from agreement approval and submits no transaction. The challenge expires after five minutes; remain connected until its verified receipt is returned.
6. Repeat with the other person's actual Java account and wallet. Two distinct game profiles and wallet signatures are required to establish the two associations. Independent human control/comprehension still needs genuine participant observation; two names, public addresses or agent-controlled accounts are not that evidence. Sequential logins on one computer establish those individual sessions; they do not prove simultaneous multiplayer.

## Backend trust boundary

`backend/src/identity/minecraft-sessions.mjs` validates the private metadata/token owner and permissions, exact Docker owner, pinned image/artifacts, command, mounts and loopback ports before reading the protected API. It checks exact server/boot/player/public-session/wallet bindings, current connected state and expiry. Both challenge creation and signature consumption call this live authority through the existing identity service. A server restart, disconnect, changed login, expired snapshot or different requested wallet fails closed. There is no fixture fallback.

`identity/http-runtime.mjs` adds that lazy real identity wrapper to the existing wallet handoff runtime. Agreement-only actions do not contact the probe. The console must load this updated module before identity requests can be served; root coordinates its restart after active wallet work. The standalone probe does not restart the console itself.

The existing single-use nonce, EIP-712 origin/server/chain binding and one-to-one wallet/profile rules remain unchanged. A retained identity link or approval receipt is historical association evidence, not a continuing live session or web-console authentication. The console still needs separate real per-user authentication/roles before any shared/public exposure. No Minecraft token/economic integration is introduced.

## Actual verification and remaining work

The focused software report at `tests/identity/runs/online-auth-5e07c787-769f-476b-b59d-56d6ca0acaf8/report.json` passes four checks: offline/proxy fixture refusal; logout/expiry/server/boot/session/wallet invalidation; actual owned empty-server health/private API with protected artifacts unchanged; and an actual offline client's failed admission with zero authenticated joins.

The server was left ready with **zero authenticated human profiles** and **zero human wallet links**. The official launcher was not opened. Real entitled Java joins, player-initiated pairing and the two human WalletLink signatures remain unverified until the people perform them. The private plugin `events.jsonl` retains actual BOOT/JOIN/PAIR_REQUEST/QUIT observations without credentials. Do not relabel the software checks as Microsoft account or independent-human evidence.
