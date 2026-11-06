# Official upstream repositories and reuse

The local voice extension uses pinned Simple Voice Chat Bukkit/Fabric 2.6.27
artifacts and its compile-only API. Upstream is All Rights Reserved; local
downloads are excluded from Git. See [VOICE.md](VOICE.md) and
`config/voice-dependencies.json` for installation, provenance and limits.

## Player-facing tunnel additions, 31 October 2026

Use official [cloudflared 2026.10.3](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3)
for the restricted HTTPS player gateway and official
[Playit 1.1.0](https://github.com/playit-cloud/playit-agent/releases/tag/v1.1.0)
for a free Minecraft Java tunnel. Generic Playit TCP/HTTPS products are not
selected; the $0 limit remains. The Playit target is the guarded loopback
ingress `127.0.0.1:8796`, never private Paper `25596` or plugin API `25597`.
Windows Node controls owned WSL tmux processes through `scripts/host_node.py`
and its Windows launcher. Pins and process preparation are not live ingress,
independent-human verification or a canonical phase pass; P0 remains blocked.

| Official Linux x64 asset | Version | SHA256 | License |
| --- | --- | --- | --- |
| [cloudflared-linux-amd64](https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-linux-amd64) | 2026.10.3 | `053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0` | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/2026.10.3/LICENSE) |
| [playit-linux-amd64 daemon](https://github.com/playit-cloud/playit-agent/releases/download/v1.1.0/playit-linux-amd64) | 1.1.0 | `1ccd3fe491d4f54e71504da001c16fa4718832a5cb7ee2461dce2816c3fbbc07` | [BSD-2-Clause](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/LICENSE.txt) |
| [playit-cli-linux-amd64](https://github.com/playit-cloud/playit-agent/releases/download/v1.1.0/playit-cli-linux-amd64) | 1.1.0 | `d0d61355cadae033595e5671e7b5cf9200f434b4796ce5ccaf55ec77139e18ba` | [BSD-2-Clause](https://github.com/playit-cloud/playit-agent/blob/v1.1.0/LICENSE.txt) |
| [Bore Linux x64 musl archive](https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz) | 0.6.0 | `e484d1e3acba77169b773f31a5bfb34192d4b660f44a094a658a2522cd2270f7` | [MIT, copyright Eric Zhang](https://github.com/ekzhang/bore/blob/v0.6.0/LICENSE) |

Bore is the authorized account-free fallback after actual Playit relay failures.
Its extracted executable SHA256 is `60548b7a145ba334981b19fda7cd0210d24a108a3d0dc113919b33fd2eaa90ab`.
`scripts/playable_bore_setup.py` verifies the official archive and exact regular
executable member, preserves an existing verified binary and prepares metadata
without starting a tunnel. Preserve the MIT notice with redistributed copies.

Preserve upstream license notices when distributing binaries. Agent claims,
guest-login capabilities and persistent Playit secrets belong only in private
WSL ext4 storage, never command arguments, public logs or documentation.
The public game admission receiver reuses the already locked official
`minecraft-protocol` 1.68.0 (MIT) parser and existing verified Discord identity
store; a relay cannot prove Microsoft identity or grant internal bot names.
See [prepared route and admission constraints](PUBLIC_MINECRAFT_TUNNEL.md).

## Discord and native rendering additions, 31 October 2026

The Discord-first local pilot uses the official [discord.js](https://github.com/discordjs/discord.js)
package at **14.28.0**, pinned in `backend/package.json` and its npm integrity
lockfile. The installed package/license identifies **Apache-2.0**. Reuse its
Gateway, application-command, component, modal and attachment APIs; do not add
a second Discord framework or put bot credentials in a model prompt. The
identity/permission and work-quote receivers remain AgentCity code. Privy
continues to use the already pinned official SDKs below. See
[Discord setup and limits](DISCORD_ONBOARDING.md).

The credential-free native renderer has its own `renderer/package.json`, npm
lockfile and Dockerfile. Selected installed dependencies recorded in that
lockfile are:

| Package | Version | License metadata | Use |
| --- | --- | --- | --- |
| [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) | 1.33.0 | MIT | Observed block models and native viewer |
| [three](https://github.com/mrdoob/three.js) | 0.128.0 | MIT | Viewer graphics engine, transitive locked dependency |
| [node-canvas-webgl](https://github.com/akira-cn/node-canvas-webgl) | 0.3.0 | MIT | Native canvas/OpenGL bridge |
| [canvas](https://github.com/Automattic/node-canvas) | 3.2.0 | MIT | Native canvas surface |
| [gl](https://github.com/stackgl/headless-gl) | 8.1.6 | BSD-2-Clause | Headless native OpenGL |
| [minecraft-data](https://github.com/PrismarineJS/minecraft-data) | 3.119.0 | MIT | Locked block/registry data |

`canvas` and `gl` versions are explicit overrides of the bridge's older native
ABI defaults. The renderer uses its pinned Node 22.17.1 Debian base image,
Mesa software GL, Xvfb and native build libraries; the backend uses its separate
Node/runtime lock. Debian packages retain their individual licenses and are
not all npm dependencies; apt package versions are not individually pinned
by the Dockerfile. MIT library metadata does not change rights in
Minecraft-derived textures/models or replace their provenance/notices.

Rendering runs without a browser, Minecraft login, Discord/Privy credentials,
world-file mount or Docker socket. Viewer 1.33.0's supported asset version is
1.21.4: observed 1.21.11 semantic states are mapped explicitly, and unsupported
states fail. Native images are labelled bounded observed-world renderings,
not client framebuffer screenshots or invented blueprint proof. Keep the
renderer loopback-only. Exact deployment constraints and existing build-tool
advisory limitations are retained in [renderer documentation](../renderer/README.md);
neither a package pin nor a synthetic image fixture establishes production
qualification or a canonical live phase pass.

## Managed-wallet additions, 31 October 2026

The playable-wallet extension uses the official Privy Node SDK 0.37.0 and React
SDK 3.51.0 (both Apache-2.0), pinned with npm integrity records. The companion
bundle retains and serves linked third-party license notices. Viem remains
2.57.13; deployment-only test keys use Foundry's standard encrypted keystores.
Runtime player custody uses Privy-managed wallets and a restricted delegate,
with owner administration kept separate. Actual API, policy metadata and managed
signing checks are recorded separately from fixtures and production qualification.
See [the integration guide](PLAYABLE_MARKET.md) and the
[official Privy controls documentation](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls).

Compatible WebSocket patches were applied to the companion dependency tree.
Remaining upstream Zod, URL-decoder and UUID advisories are retained in packaging
evidence; no unsupported major-version override or production clearance is implied.

The supplied V3 paper names technologies and official documentation titles but contains no literal GitHub repository URLs. The mappings below were checked against official repositories on 29 October 2026. Additional engineering libraries and the four standing developer tools are identified separately from paper requirements.

Use every named technology in its appropriate role. References are studied; packages/binaries are installed as pinned compatible dependencies; protocol integrations use supported deployed contracts. Cloning every repository into the runtime would not establish correct reuse.

Observed revisions identify the source reviewed today. **They are not chosen dependency locks or compatibility-test results.** Record exact installed versions, integrity hashes, deployed bytecode/addresses and preserved notices when each phase adopts them.

## Core named technologies and supporting integrations

### PaperMC/Paper

[Official repository](https://github.com/PaperMC/Paper)

- Role and phase: World server and plugin API; P0 P1.
- Reuse: Use a pinned Paper server artifact and compile-only plugin API; implement AgentCity plugin separately. Do not fork the server.
- License observation: GPL-3.0 with identified MIT contributions; mixed per LICENSE.md.
- Reviewed commit: `804dd0c3f08b666dc51a0250257915c002c59755`.
- Limits: Latest main advertises 26.3 and Java 25; bot README advertises through 26.1. Verify a compatible intersection and runtime. Paper license is inherited GPL-3.0 with identified MIT contributions; inspect artifact/file terms.

### PrismarineJS/mineflayer

[Official repository](https://github.com/PrismarineJS/mineflayer)

- Role and phase: Physical Minecraft bot; P0 P2.
- Reuse: Install and pin mineflayer; reuse movement, inventory and placement APIs behind AgentCity permissions.
- License observation: MIT.
- Reviewed commit: `5a252e6d258882b042e60e21c37d552cdf3b3380`.
- Limits: README advertises supported game versions through 26.1 and Node >=18; exact version compatibility must be run-tested. Bot completion is not functional inspection.

### PrismarineJS/mineflayer-pathfinder

[Official repository](https://github.com/PrismarineJS/mineflayer-pathfinder)

- Role and phase: Bounded navigation; P2.
- Reuse: Install and pin plugin; configure movement policies and allowed routes, disable unauthorized break/place behavior.
- License observation: MIT.
- Reviewed commit: `b07a419a4181d242bc4b9f8648a4f624e587c18f`.
- Limits: Default autonomy can dig/place; explicitly bound route, region, stock, hazards and action quota. Stop on unreachable target or unknown state.

### Arkiv-Network/arkiv-sdk-js

[Official repository](https://github.com/Arkiv-Network/arkiv-sdk-js)

- Role and phase: Independent owned discovery records; P4.
- Reuse: Use @arkiv-network/sdk with its required viem peer dependency; use official query/entity APIs and implement application schemas/validation.
- License observation: MIT.
- Reviewed commit: `371454470a253f497bdfcf27fc076ce6ebc902bd`.
- Limits: Arkiv is expiring discovery data, not escrow authority. README recommends Node >=22.10.0. Retain signed agreements outside it and verify owner/signature/domain.

### 0gfoundation/0g-compute-ts-sdk

[Official repository](https://github.com/0gfoundation/0g-compute-ts-sdk)

- Role and phase: Direct inference and account integration reference; P3.
- Reuse: Use current official SDK only if the chosen integration path requires it; Router-first backend may use its documented HTTP interface. Pin SDK if Direct is adopted.
- License observation: ISC declared in package.json; standalone license file not verified.
- Reviewed commit: `3e833e24eef2b9416a8b2c9ca72c80a81126d61e`.
- Limits: Package renamed to @0gfoundation/0g-compute-ts-sdk; @0glabs/0g-serving-broker deprecated. SDK README documents Direct provider subaccounts; Router uses a different API-key/unified-balance path. Node >=20. Package declares ISC but root standalone license not verified.

### 0gfoundation/0g-compute-ts-starter-kit

[Official repository](https://github.com/0gfoundation/0g-compute-ts-starter-kit)

- Role and phase: Official inference example; P3.
- Reuse: Reference-only study of current wiring; copy code only after license permission is established. Do not adopt a second application scaffold.
- License observation: Unverified; no root or package license found.
- Reviewed commit: `df91ab47d32f867fa02797289193b425f373e8d5`.
- Limits: No root license or package license verified. Starter is not mandatory runtime dependency and does not prove Router/Direct equivalence.

### Uniswap/v4-core

[Official repository](https://github.com/Uniswap/v4-core)

- Role and phase: PoolManager and v4 interfaces; P5 P6 P7.
- Reuse: Use audited compatible tagged code/interfaces and official deployed PoolManager; pin exact tested revision and deployment identity. Do not rewrite AMM math.
- License observation: BUSL-1.1 and MIT per file headers/licenses.
- Reviewed commit: `bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6`.
- Limits: README states BUSL-1.1 and MIT on a per-file basis. Current HEAD is observation, not an audited chosen release. Hook attaches at pool creation and must match permission bits.

### Uniswap/v4-periphery

[Official repository](https://github.com/Uniswap/v4-periphery)

- Role and phase: v4 hook and position/swap support; P6 P7.
- Reuse: Use compatible periphery interfaces/libraries/base hook APIs where current version exposes them. Keep dependencies aligned with core.
- License observation: MIT (GitHub metadata); inspect imported file headers.
- Reviewed commit: `c6e4754dab11bd38c6f08ac51c3c868569e93d64`.
- Limits: Do not assume old BaseHook path or API from tutorials. Verify selected commit public APIs, router behavior and deployed addresses.

### Uniswap/v4-template

[Official repository](https://github.com/Uniswap/v4-template)

- Role and phase: Foundry hook project example; P6.
- Reuse: Reference official hook scaffolding and tests; reuse a minimal compatible setup with notices rather than a second monorepo.
- License observation: MIT.
- Reviewed commit: `1fbf95547791f0821a170b88c750cb2e04e6818b`.
- Limits: The current official first-hook guide links the legacy uniswapfoundation/v4-template alias; GitHub resolves it to canonical Uniswap/v4-template. This is a starting example, not an audited production hook; dependency SHAs and permission address mining must be verified.

### Uniswap/universal-router

[Official repository](https://github.com/Uniswap/universal-router)

- Role and phase: Actual bounded swap route; P6 P7.
- Reuse: Prefer a verified deployed compatible router and documented ABI/commands. Implement exact-output KIT path with CRED input cap and expiry enforcement.
- License observation: GPL-3.0.
- Reviewed commit: `edf19bfde87e6cf5b29046f6ca2f483a4ffd6ae6`.
- Limits: Router is GPL-3.0. Direct protocol integration does not imply vendoring/relicensing source. Validate actual supported commands, native assets, settlement, allowance and expiry semantics; no hosted auto-routing assumption.

### OpenZeppelin/openzeppelin-contracts

[Official repository](https://github.com/OpenZeppelin/openzeppelin-contracts)

- Role and phase: Token, signature, access and transfer primitives; P4 P5 P8.
- Reuse: Use pinned reviewed ERC20/access/signature/safe-transfer primitives for custom issuance, claim and escrow contracts. No bespoke cryptography.
- License observation: MIT.
- Reviewed commit: `e2f38adbb3b1a358a264d082520d360fbe2b7404`.
- Limits: Supplemental implementation choice, not explicitly named in V3. Library security does not audit our agreement semantics, replay domains, hook or custody assumptions.

### foundry-rs/foundry

[Official repository](https://github.com/foundry-rs/foundry)

- Role and phase: Contract build, local chain, fuzz and invariant tests; P0 P5 P6 P7 P8.
- Reuse: Use pinned forge/anvil/cast binaries and dependency locks for contract unit, fuzz, invariant and fork/integration suites.
- License observation: Apache-2.0 OR MIT.
- Reviewed commit: `b3d6942cc6e2b368e93a6899e7ca22c7aa5272cf`.
- Limits: Supplemental test-tool choice, not named in V3. Local Anvil or forks cannot prove real custody, real provider access or deployment policy.

### wevm/viem

[Official repository](https://github.com/wevm/viem)

- Role and phase: Typed EVM and Arkiv client foundation; P4 P5 P7 P8.
- Reuse: Install as Arkiv-required peer; reuse chain reads, signed data encoding and transaction/receipt APIs in backend/companion.
- License observation: MIT (verified LICENSE file).
- Reviewed commit: `a8c47d58cdec9b1581618729f9eeb17ce52bb4aa`.
- Limits: README-linked Arkiv dependency. Preserve exact chain/token/base-unit domain; pending transaction or included receipt is not finalized applied game delivery.

## Standing developer tools

These tools follow the user's repository instructions and are used during engineering. They are not dependencies of the player's Minecraft runtime.

### headroomlabs-ai/headroom

[Official repository](https://github.com/headroomlabs-ai/headroom)

- Role and phase: Developer context compression; All implementation phases.
- Reuse: Use existing local checkout/tooling for compact tool context with recoverable originals; no Minecraft runtime dependency.
- License observation: Apache-2.0.
- Reviewed commit: `a2d4fe72381e186651466ee94e92ce9d8d1396cc`.
- Limits: User baseline repository, not a runtime component of V3. Keep full original evidence and retrieve details for security-critical analysis; compression is not validation.

### rtk-ai/rtk

[Official repository](https://github.com/rtk-ai/rtk)

- Role and phase: Developer command output reduction; All implementation phases.
- Reuse: Use installed configured command filtering; retain raw/full logs as test evidence. No new runtime package or global reconfiguration needed.
- License observation: Apache-2.0 OSS; README identifies BUSL-1.1 additional features.
- Reviewed commit: `7e92da00a5cf737dc87850505aa3dea603454613`.
- Limits: User baseline tooling. Current README distinguishes Apache-2.0 OSS and BUSL extras; inspected root LICENSE is Apache-2.0. Review selected edition/features before copying.

### juliusbrussee/caveman

[Official repository](https://github.com/JuliusBrussee/caveman)

- Role and phase: Concise agent communication; All implementation phases.
- Reuse: Apply current installed skill and existing local checkout; keep code, manifests and persisted technical docs exact and readable.
- License observation: Apache-2.0.
- Reviewed commit: `9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4`.
- Limits: User baseline developer skill, not game agent policy or runtime model configuration. Never compress away permissions, failure evidence or acceptance rules.

### dietrichgebert/ponytail

[Official repository](https://github.com/DietrichGebert/ponytail)

- Role and phase: Minimal complete implementation and review; All implementation phases.
- Reuse: Apply installed skill; reuse existing upstream/platform functions, keep smallest complete diff and test risky logic.
- License observation: MIT.
- Reviewed commit: `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`.
- Limits: User baseline developer skill. Minimal code never permits skipping validation, error recovery, accessibility or phase gates.

## Implementation constraints

- 0G canonical org/package changed. Use 0gfoundation/0g-compute-ts-sdk and current package name; V3 Router-first must not accidentally inherit Direct funding/accounting.
- Paper latest main and Mineflayer advertised latest support differ. Pin a tested common game/server/bot/Java/Node matrix.
- Uniswap v2 constant-product and v3 papers are explanatory research references. They are not additional AMM implementations to deploy for this v4 project.
- No requirement in V3 names Voyager, MineDojo, LangChain, LangGraph or other autonomous-agent frameworks. Do not add them based on popularity.
- 0G starter license remains unverified. Study only until copy/use terms are established; hosted Router HTTP integration does not require copying that starter.
- Arkiv SDK extends viem; install its peer rather than building our own chain RPC/signing stack.
- Private AgentCity repository does not erase upstream BUSL/GPL/MIT/ISC/Apache obligations. Do not add a blanket permissive project license over copied upstream code.
- Headroom, RTK, Caveman and Ponytail remain development tools; installing them in the game runtime would add irrelevant dependencies.
- Use a known tested v4 core/periphery/router/template combination and verify actual deployment identities; latest default-branch SHAs are observations only.

## Concepts that do not add runtime packages

The v2 constant-product and v3 concentrated-liquidity papers explain mechanisms. They do not require deploying v2/v3 AMMs beside the v4 implementation. Dynamic fees are a later hypothesis, not a first-release feature. Router-first inference does not require a Direct SDK integration solely to claim another dependency. The official Direct SDK and starter are studied for their selected-path relevance; an unverified starter license prevents copying its source.

No requirement names Voyager, MineDojo, LangGraph or a general autonomous-agent framework. The supported blueprint, Mineflayer executor and deterministic permission checks already provide the required bounded loop.

Full source links and review metadata are retained in [planning/upstreams.json](../planning/upstreams.json). Private hosting does not remove upstream license obligations; do not place a blanket permissive license over copied restricted code.

## Licensed calculator data candidate

[Redstone-Compiler/redstone-compiler](https://github.com/Redstone-Compiler/redstone-compiler), reviewed commit `f39ecf2d528598eff8866a1392fa7ee15eff1bbf`, supplies the small MIT-licensed two-bit adder candidate under `fixtures/candidates/redstone-compiler/`. The notice is retained. It is candidate data, not another runtime framework. Upstream simulator results do not establish physical Minecraft correctness; P1 must validate the added lamp interface and complete behavior.
