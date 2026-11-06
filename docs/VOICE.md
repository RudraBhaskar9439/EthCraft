# In-game voice control

EthCraft uses Simple Voice Chat for private push-to-talk, 0G `whisper-large-v3`
for transcription and 0G `minimax-speech-2.8-turbo` for spoken replies. The
transcript enters the existing owner-validated agent command service. Existing
adaptive planning, tools, progress, 0G review and purchase policy apply.

## Play on this laptop

1. Close the vanilla Minecraft client. In TLauncher select the installed
   `fabric-loader-0.20.1-1.21.11` profile and launch it as `Micro`.
2. Join `127.0.0.1:25596`. While connected, use Discord `/join` and approve the
   new Minecraft connection.
3. Press **V** for voice settings. Complete microphone setup, allow macOS
   microphone access, select **Push to Talk**, and check the microphone meter.
   In **Controls → Key Binds → Voice Chat**, bind **Push to Talk** to **G**
   (the installed version leaves this control unassigned by default).
4. Run `/voice 0g` or `/voice agent`. Hold push-to-talk, speak, then release it.
   Replies play only to you through Minecraft. Keep headphones on to avoid
   capturing the agent's reply.

Examples: “follow me,” “come here,” “wait here,” “what are you doing,” or
“craft four sticks using your source chest supplies, then put them in your
destination chest.” Prefix “Agent” or “Zero G” to select a worker in speech.
Simple Hindi/Hinglish controls include “mere peeche aao,” “idhar aao” and
“ruko.” Larger objectives use the existing planner and its supported tools;
speech does not add new game capabilities.

`/voice status` shows selection; `/voice off` disables capture. Starting a new
utterance stops the previous reply and fences stale transcription/playback.
Say “stop” to stop movement through the same command handler as typed input.
Turning voice off leaves already accepted work saved.

## macOS launcher permission error

“Your launcher does not support macOS microphone permissions” can occur when
permission is still `NOT_DETERMINED`: the launcher never requested access. This
laptop's original local TLauncher shell wrapper had no microphone declaration.
The local repair replaces only that owned wrapper with a small signed native
bootstrap that requests microphone permission before starting the same Java
launcher. It preserves the existing profile, account configuration and worlds.

After installing the repair, quit Minecraft and TLauncher. Reopen
**TLauncher from Applications or Spotlight**, click **Allow** on the macOS
microphone prompt, and launch the Fabric profile again. Opening an old JAR or
starting the old launcher through Terminal skips this bootstrap. If permission
was denied, enable TLauncher under **System Settings → Privacy & Security →
Microphone**. The permission must be granted by the user; no privacy database,
permission check or microphone protection is bypassed.

`python3 scripts/voice_setup.py mac-permissions` installs the repair only for
this project's recognized `local.tlauncher.launcher` wrapper. It rejects other
launchers, keeps private backups of changed files and verifies the signed app
before registering it. Upstream recommends Prism Launcher or GDLauncher for
general macOS support; this local repair is not an upstream TLauncher fix.

## Authority, privacy and spending

- Only the current Discord-approved owner connection can enroll or dispatch.
  Reconnecting requires a new `/join` approval and voice enrollment.
- Microphone packets are suppressed from ordinary proximity chat. Clips are
  held only in memory, limited to 12 seconds, and expire after two minutes.
  Releasing push-to-talk ends a clip; 650 ms of silence in packet delivery
  also ends it. Voice activation is not supported by this integration.
- 0G receives audio and reply text for inference. A private local journal stores
  transcripts, hashes and command outcomes, without raw audio or credentials.
  Audio is never written to Arkiv. Review 0G's service policy for its retention.
- Voice cannot approve a wallet connection or bypass receiving-tool policy.
  Existing approved agent purchasing delegation remains in effect. Speech alone
  creates no new standing spending permission.
- Speech and text compute share the existing cumulative **$5 0G allowance**.
  Advanced-model compute retains its separate cumulative **$25 allowance**.
  Whisper is bounded at $0.00013 per rounded-up second; MiniMax at $0.000108
  per character, conservatively reserved per UTF-8 byte. Live prices and
  capabilities are checked before each request. Unknown charges remain reserved.
- Ambiguous/interrupted voice requests are not automatically replayed after
  restart. Check agent status before repeating an objective.

## Local operation

The server uses the pinned Simple Voice Chat Bukkit plugin 2.6.27; the Fabric
client uses its matching Minecraft 1.21.11 release. Downloads and hashes are in
`config/voice-dependencies.json`. Upstream binaries are **All Rights Reserved**,
downloaded for local installation and excluded from Git. The API dependency is
compile-only. No third-party voice binaries are redistributed in this repository.

The owned `agentcity-voice-transport` Docker container forwards opaque UDP from
`127.0.0.1:24454` to Minecraft over `agentcity-voice-local`. It performs no speech
processing or recording. Minecraft TCP and the native control API remain on
their existing loopback ports. This offline-mode voice deployment is for this
laptop; do not expose it publicly without a separate authentication/network review.

Useful commands from the project directory:

```sh
python3 scripts/voice_setup.py status
python3 scripts/voice_setup.py client     # install verified client artifacts
python3 scripts/voice_setup.py transport  # reconcile owned local UDP transport
```

Server upgrades require an isolated qualification:

```sh
python3 scripts/voice_setup.py isolate
node tests/playable/voice-native.mjs
python3 scripts/voice_setup.py upgrade
```

Reload the Mumbai worker after changing its voice modules or ledger validator.
Stop only its recorded, identity-checked PID and preserve all journals. The
native plugin is qualified before live rollout; seven world UUIDs and the
economic namespace remain unchanged. `scripts/mumbai_city_host.py cleanup`
removes only the owned isolated container and keeps its private world copy.

## Verification and limits

Focused tests cover shared-budget accounting, audio format/price bounds,
permission checks, turn deduplication, stale-turn fencing and spoken completion
ordering. The actual Docker relay passes separate-client UDP round trips.
An isolated real Paper server verifies Voice Chat initialization and approval
guards using a disclosed vanilla Mineflayer fixture. A paid 0G probe verifies
both voices and a speech/transcription round trip without executing game actions.
Reports are under `evidence/runs/voice-native/` and `voice-provider/`.

The live API probe took about nine seconds for one speech/transcription round
trip; this is not a real-time speech-to-speech model. Actual microphone quality,
Hindi/Hinglish recognition, audible playback and task behavior still require
the human in-game acceptance check. These tests do not qualify the original
independent-human or canonical project phase gates.
