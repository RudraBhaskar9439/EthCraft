# Maintained Minecraft runtime

This is a loopback-only, non-token runtime qualification and narrow source adoption. The historical version lock and user server on port 25588 remain unchanged. The tested candidate source, narrow patch, artifact pins, notices and all actual attempts remain in `tests/compatibility/maintained-candidate/`. The adopted runtime is selected by `config/minecraft-runtime.json`.

The [official Paper metadata](https://fill.papermc.io/v3/projects/paper/versions/26.3) reports Minecraft 26.3 as supported and Java 25 as its minimum. The selected [Paper build 231](https://fill.papermc.io/v3/projects/paper/versions/26.3/builds/231) is stable. The exact tested candidate is:

| Component | Pinned candidate |
| --- | --- |
| Server | Paper 26.3 build 231, commit `8a170a38c6811b0a6c82f858da4ff67191c08970` |
| Runtime | Temurin 25.0.5+8, image `eclipse-temurin@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507` |
| Protocol translation | ViaVersion 5.12.2 and ViaBackwards 5.12.2 |
| Bot/client protocol | Unmodified Mineflayer 4.39.0 and pathfinder 2.4.5 dependencies; Minecraft 1.21.11 protocol |
| Bot compatibility hook | Emit the defined `tick_end` packet at actual Mineflayer physics-tick boundaries |
| App compilation | Pinned historical Temurin compiler image, Java 21 class files; native linkage tested on Java 25/Paper 26.3 |
| Networking | Game `127.0.0.1:25596`; control `127.0.0.1:25597`; owned temporary containers |

`candidate.json` contains the complete official download URLs and SHA256 values. Paper's checksum-addressed JAR is verified against its build metadata. Both Via JARs are verified against official GitHub release-asset digests. [ViaBackwards' pinned registrations](https://github.com/ViaVersion/ViaBackwards/blob/5.12.2/common/src/main/java/com/viaversion/viabackwards/api/ViaBackwardsPlatform.java#L171-L173) explicitly provide the 26.3 → 26.2 → 26.1 → 1.21.11 translation path and require ViaVersion at least 5.12.2.

The original plugin cannot run unchanged on this server. It deliberately accepts only 1.21.11. The qualified and adopted source retains a guard with the exact allowlist `{1.21.11, 26.3}`. Its local-fixture plugin allowlist adds only the pinned Via pair and named native test fixture; arbitrary plugins remain rejected.

One actual native API change was found: Paper 26.3 renamed `CraftBlock.getNMS()` to `getBlockState()`. The candidate `NativeLever` selects the appropriate accessor for exactly the two allowed versions and retains the original native lever `pull` operation. An isolated fixture calls the candidate path to turn a lever on and off and restores its outside-plot probe blocks. This avoids replacing real lever behavior with direct block-data writes.

The translated bot also required a missing standard protocol message. Paper 26.3 rejects a second position packet within one client tick. Actual server packet logs showed finite movement values but no `ClientTickEnd` boundaries; actual bytecode confirms that the boundary resets this guard. The installed Mineflayer version does not emit that message. The candidate-process hook emits `tick_end` on its real `physicsTick` event, which occurs before `updatePosition` and therefore closes the preceding logical tick. It preserves normal movement packets, coordinates, flags and server validation. It never adds a marker per movement packet. Earlier movement-packet promotion experiments failed and are not used.

The corrected smoke passed all five checks in `runs/agentcity-maintained-07f6f870/`: three translated logins and scoped sessions, authoritative empty-circuit/144-stock reading, one native placement with exactly one item consumed, an unauthorized native dig refused without a world or revision change, and actual native lever on/off interaction. The dig is rejected at the earlier interaction boundary; a later block-break event is not required to fire after that rejection.

The original JAR SHA256 is `a8ec21a9858659f806c06c7f9e4b7eac9daac80c8d3d3e784717151956abc008`. The candidate JAR SHA256 is `781191a016255d21528f904d0b8e0375f8d40341d79036c774630c01efffaa97`. `source-manifest.json` records every original and candidate source hash; `candidate.patch` contains the complete narrow change. Each later attempt freezes its harness and source hashes separately.

The fresh full maintained run `agentcity-maintained-4b4bb938` passed both six-check process segments. It made exactly 144 native placements and 144 placement receipts, consumed the exact stock once, recovered the original lost-reply operation once, and passed all 16 actual lamp cases at revision 144. It used real local Ollama and retained protected review. This is the same construction/inspection harness used for the historical fixture, with the maintained protocol hook and exact runtime pins.

The rebuilt production JAR is `0edd1f1958ef3aa3cc74bc84f7ff5418696dfc3db0c50bc8bb361bd4f6ae78be`. All 38 class entries and two resources are byte-identical to the qualified candidate; only archive metadata differs. The production tick-emitter body is also byte-identical. Exact source, class/resource and emitter proofs are in `adoption/source-equivalence.json`. The adopted-production smoke `agentcity-maintained-b2a9e50a` separately passed all five receiving-boundary/native checks using the production JAR, config and source/runtime assertions before enabling its protocol hook.

Run from the repository root:

```sh
python3 tests/compatibility/maintained-candidate/prepare.py
docker pull eclipse-temurin@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507
python3 tests/compatibility/maintained-candidate/run.py --mode smoke
python3 tests/compatibility/maintained-candidate/run.py --mode full
python3 tests/construction/run.py --internal --runtime maintained
```

The full mode creates a fresh world and invokes the existing construction probe with maintained ports and the tick-boundary hook. It preserves the original 12-placement lost-reply interruption, new-process recovery, remaining 132 native placements, exact stock/receipt accounting, actual 16-case lamp inspection and protected review. The construction entry point selects the adopted config for internal builds; `--runtime historical` retains the old reference fixture. Historical production locks are not rewritten.

The managed host uses a separate owned clone on game port 25596 and control port 25597:

```sh
python3 scripts/maintained_world.py start
python3 scripts/maintained_world.py status
```

The first start preserves the qualified saved world, creates one private clone, verifies pinned application/runtime artifacts, reconnects the three disclosed fixture players and obtains a new real 16/16 report. Later starts reuse the owned active metadata and world. Source worlds are never reset, new stock is never injected, and port 25588 is untouched. Private state lives under `.local/maintained-world/`; the API token is a separate 0600 file and never appears in status output. Readiness means the owned maintained software host is running and reachable, not that a human has authenticated or accepted a job. `evidence/MAINTAINED_RUNTIME.json` is the durable qualification/host summary.

Managed host `agentcity-maintained-host-b553ae1b` is running on 25596/25597. Its fresh restored inspection `d1e4fa50-031c-43cf-8bad-e24a40c10ef8` passed 16/16 with all 144 structural blocks and empty stock/inventories retained. Repeat start preserved its Docker identity, runtime, one clone and inspection files. Both manifests of 224 saved source files match across the explicitly recorded window from the existing clone before retry through verification; the source was not mounted in the managed container. The original missing-container parsing failure and overly strict offline-actor preflight are retained alongside the passing report. Actor absence can quarantine a job; software-host health does not override that authority or clear quarantine manually.

Notices are retained under `official/`. Paper carries GPL and bundled upstream notices. The full Via plugins are GPLv3; ViaVersion's API-only license is MIT. Temurin/OpenJDK is GPLv2 with the Classpath Exception; container build scripts are Apache 2.0. The complete image also contains Ubuntu and third-party components, so it is not assigned one blanket license. Bundled JDK license and additional licensing information are retained. Release checksums were checked; external release attestations were not independently cryptographically verified.

All attempts, including startup and protocol failures, remain retained. This qualification uses agent-controlled local fixture identities and $0 local compute. It does not prove independent human participation, live 0G, token-linked Minecraft suitability or public deployment readiness. Minecraft materials and actions remain separate from the synthetic blockchain demonstration.
