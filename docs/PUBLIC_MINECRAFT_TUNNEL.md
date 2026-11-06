# Public game tunnel preparation — 31 October 2026

Use **Playit 1.1.0's free Minecraft Java tunnel**, together with a separate HTTPS route for the player setup pages. Minecraft Java is explicitly listed as free; generic TCP and HTTPS are paid Playit products, so do not select them or buy a plan. Players use their ordinary Minecraft server address field; only the host runs Playit. This is the concrete $0 game route. A free Playit account/agent must be claimed by the operator before an endpoint can be configured. [Official free products and account entry](https://playit.gg/download/linux), [official vanilla server guide](https://playit.gg/support/how-to-setup-a-mc-server/).

The implemented host uses separate HTTPS onboarding and guarded Minecraft ingress. Paper stays on private loopback `127.0.0.1:25596`, alongside the private plugin API, renderer and database. Playit can target `127.0.0.1:25565` or `127.0.0.1:8796`: both listeners use the same admission checks. They reject internal actors and require a verified Discord reservation before a login reaches Paper. The plugin then requires approval of that exact connection through Discord.

## Official pinned tools

Current maintained release reviewed: [v1.1.0, released 27 October 2026](https://github.com/playit-cloud/playit-agent/releases/tag/v1.1.0). The GitHub release metadata supplied these SHA256 digests; no binary was downloaded or run during research.

| Asset | Official URL | SHA256 |
| --- | --- | --- |
| Daemon, Linux x64 | https://github.com/playit-cloud/playit-agent/releases/download/v1.1.0/playit-linux-amd64 | `1ccd3fe491d4f54e71504da001c16fa4718832a5cb7ee2461dce2816c3fbbc07` |
| CLI, Linux x64 | https://github.com/playit-cloud/playit-agent/releases/download/v1.1.0/playit-cli-linux-amd64 | `d0d61355cadae033595e5671e7b5cf9200f434b4796ce5ccaf55ec77139e18ba` |

In this release, `playit-linux-amd64` is **playitd**, while the separate CLI controls it. That mapping is confirmed by the [official release build](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/.github/workflows/build-release.yml). Do not assume old single-binary instructions apply unchanged.

`scripts/playable_playit_setup.mjs --manifest` prints public pins only. After root coordinates preparation, run `--prepare` using the pinned Linux Node in WSL. It downloads only the two exact assets, verifies both hashes, stores executables and wrappers in a private `0700` ext4 directory under the WSL user's home, and writes disabled public configuration references to `.local/public-access/playit-settings.json`. It never starts a process or tunnel. Existing mismatched executables/wrappers are refused; it does not reset an agent or existing key.

## WSL tmux, launched from Windows Node

Use the helper-generated absolute paths; the following shows their command equivalents. Private paths are placeholders for the prepared WSL user directory, not Windows-mounted secret files.

```sh
# Root runs these only after the ingress is implemented and tested.
tmux new-session -d -s agentcity-playit /PRIVATE/run-daemon.sh
tmux new-session -d -s agentcity-playit-setup /PRIVATE/run-setup.sh
```

The daemon wrapper uses `--secret-path /PRIVATE/playit.toml --socket-path /PRIVATE/playit.sock --log-path /PRIVATE/daemon.log`. The CLI wrapper uses `--socket-path /PRIVATE/playit.sock --stdout setup`. These flags and the setup flow are taken from the pinned [daemon source](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/packages/playitd/src/bin/playitd.rs) and [CLI source](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/packages/playit-cli/src/main.rs). The daemon persists its secret atomically with Unix `0600` permissions. [Official secret writer](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/packages/playitd/src/daemon.rs).

The CLI prints an agent claim URL, waits for the operator's browser approval, and provisions the daemon over private IPC. It can also print a guest-account login capability. Therefore wrappers capture **all** stdout/stderr in private files with `umask 077`; never paste raw setup logs or `claim exchange` output into a public terminal, Discord channel, evidence or a commit. `--claim-status` extracts only the claim URL into a private file and returns that file's path/status, without printing the URL or secret. Root can present the claim link privately to the authorized operator. No browser is launched by the helper.

The Windows Node supervisor should call `wsl.exe` with an argument array: `['-d','Ubuntu','--exec','tmux','new-session','-d','-s','agentcity-playit',daemonScript]`. Use a separate named tmux session for the CLI wrapper, refuse existing unowned sessions, and never place a secret in command arguments. [Playit's official tmux instructions](https://playit.gg/support/host-247-with-playit/) support this hosting approach. A local tmux session does not keep a sleeping Windows host or disconnected internet connection online.

After claiming, configure one **free Minecraft Java** tunnel targeting `127.0.0.1:25565` (the default) or guarded port8796. Both enter the same verified-name gate. Read the public hostname/port from the actual Playit account. Playit and the admission proxy share the WSL network namespace; direct Paper stays private on25596.

## Implemented admission proxy

`backend/src/discord/minecraft-ingress.mjs` reuses installed `minecraft-protocol` **1.68.0** from `tests/compatibility/package-lock.json`. It bounds and parses the handshake/login, authorizes the exact name, and forwards original bytes to the fixed private backend. Protocols774 and777 are supported; other versions are rejected. Client UUIDs do not establish ownership. Normal supported Minecraft clients need no tunnelling software. [Upstream minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol).

Before opening any backend connection:

1. Reject case-insensitively `CityAgent1`, `CityAgent2`, `WorldBuilder`, `WorldRequester` and `WorldInspector` on this public ingress, regardless of a database row or existing whitelist entry.
2. Require an exact-case active reservation for the configured server joined to a verified `ac_discord_identities` / principal row. A preserved legacy Minecraft/wallet alias or plugin-only fixture reservation is insufficient. Database failure, expiry, malformed names or unknown profiles deny admission. Reuse the existing identity store; do not copy a stale allowlist into a new authority.
3. Let the existing Java gate create a fresh pending connection and require the registered Discord principal's exact connection approval. Name filtering grants no movement, inventory access, Microsoft identity claim, wallet signing or remote agent authority.

Only bounded native server-list status and ping are forwarded without login authorization. Focused fixture checks and actual local status/denial checks passed, with unchanged world/task/access hashes. They do not establish a successful authorized remote human login. Preserve that separate live requirement.

## Persistent Windows host

Run `python3 scripts/host_node.py start` in WSL. The supervisor verifies the pinned Cloudflared binary, creates owned sessions on the `agentcity-host` tmux socket, and runs the web backend, Discord worker, onboarding gateway, HTTPS tunnel and Minecraft ingress. Prepared Playit settings add its daemon. `status` prints public readiness; `stop` first requires physical tasks and locks to be reconciled, then stops only owned services. Saved Docker world and database remain intact.

Attach with `tmux -L agentcity-host attach -t agentcity-worker`, or replace the session name with `agentcity-web-tunnel` or `agentcity-playit`. Detach with Ctrl+B then D. The HTTPS tunnel forwards only the onboarding gateway on8795; operator endpoints return404. OAuth callback queries survive the gateway and browser startup.

`scripts/host_node_windows.ps1` starts the WSL services and requests that Windows stay awake while `.local/hosting/enabled` exists. It leaves display sleep and screen locking available. The configured per-user Windows Startup shortcut launches it hidden at login; owned Docker containers use `unless-stopped` restart policies. Windows, Docker Desktop and internet connectivity are still required. Closing a terminal does not stop tmux; shutdown, explicit sleep or closing a laptop lid can interrupt hosting. This is temporary hosting, not an uptime guarantee.

Quick Tunnel hostnames stay usable while their tunnel survives. A tunnel restart can assign a new hostname; the supervisor updates exact public origins and reloads the web/Discord processes only after physical tasks finish. If Privy enforces an origin allowlist, approve the new exact HTTPS origin in its dashboard. Never use a wildcard for every tenant on a shared tunnel domain. A stable production hostname requires separately configured hosting.

## Account-free Bore fallback

[Bore's maintained upstream](https://github.com/ekzhang/bore) provides public TCP forwarding without an account. The user-authorized fallback was tested after Playit relay resets. Its pinned [0.6.0 release](https://github.com/ekzhang/bore/releases/tag/v0.6.0) archive SHA256 is `e484d1e3acba77169b773f31a5bfb34192d4b660f44a094a658a2522cd2270f7`, with an [MIT license](https://github.com/ekzhang/bore/blob/v0.6.0/LICENSE).

Run `python3 scripts/playable_bore_setup.py --prepare` inside WSL to prepare the binary on private ext4 and `.local/hosting/bore.json`. This verifies cached artifacts and refuses mismatches; it never starts or restarts a process. The supported command is `bore local 25565 --local-host 127.0.0.1 --to bore.pub --port <requested-public-port>`. Port25565 is the guarded public ingress compatibility listener; private Paper25596 remains inaccessible through the tunnel. The supervisor owns service adoption and startup. A requested public port can be unavailable after disconnect; readiness requires an actual Minecraft status response and ping through the assigned public address.

The first actual fallback test returned Paper26.3 status and exact ping echo without a player login. This establishes a working relay at that observation, not an independently verified human join. Keep current runtime endpoints in ignored host state rather than public documentation. Bore is a shared public broker and does not itself encrypt payload traffic. Do not promise relay availability, a stable address or Microsoft authentication.
