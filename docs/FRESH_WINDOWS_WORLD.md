# Fresh local world on Windows

This machine runs a new calculator demonstration, separate from the original Mac's
saved world and public contract history. Minecraft uses game materials only. The
contract demonstration remains separate and synthetic.

Join with Minecraft **26.3**, username **Ruddy**, at **127.0.0.1:25596**. Ruddy is a
spectator near the calculator. The three named worker/requester/inspector accounts
are disclosed local fixtures, not independently authenticated human participants.
The server and plugin control port bind to loopback only.

From Command Prompt at the repository root, the machine-specific startup shortcut is:

```bat
call .local\setup\start-world.cmd
```

The maintained-version server uses Paper 26.3 build 231, Temurin 25.0.5+8,
ViaVersion/ViaBackwards 5.12.2 and the existing Mineflayer 1.21.11 client protocol
with its tested physics-tick boundary hook. All downloaded game artifacts are
checksum-verified. Mojang's CDN alias is used because this network resets connections
to `piston-data.mojang.com`; the server JAR must still match Paper's embedded SHA256.

The helpers require the dependencies prepared during setup. They are not a portable
clean-machine installer. Run the Unix build and world helper under WSL:

```sh
python3 scripts/fresh_world.py start --visitor Ruddy
python3 scripts/fresh_world.py status
node scripts/fresh_world_build.mjs
```

The WSL Node binary must be the prepared 26.3.1 release. The existing Windows
Ollama service and `qwen3:1.7b` model are reached through a WSL loopback bridge.
This preserves the worker's Unix directory-sync checkpoints; native Windows cannot
provide the same directory-sync operation in this implementation.

Private world state and its API token stay in ignored `.local/fresh-world/`.
The active pointer pins the existing world. Restart reuses its initialization
marker and original inventories; it does not create more stock or reset the build.
Do not delete that directory or change the deployment to retry an uncertain action.

The build helper uses the existing physical construction and inspection harness.
It preserves checkpoints, operation identities and attempt reports under
`evidence/runs/fresh-world/`. An initial retry is explicit and allowed only while
the authoritative structural revision is zero; it writes a new attempt directory
and retains the previous failure. Failures after construction begins need same-job
checkpoint review before resumption. No script automatically accepts a human job.

Starting this world does not pass canonical phase gates. The fresh deployment,
changed setup code and affected dependencies require renewed evidence/review.
Independent-human acceptance, live 0G and production qualification remain pending.
