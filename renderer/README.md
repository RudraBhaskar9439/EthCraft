# Native actual-world images

This service uses MIT-licensed Prismarine Viewer 1.33.0, Three.js, node-canvas-webgl, Mesa and Xvfb. It uses no browser or browser profile. Xvfb is the native OpenGL display backend, not browser automation. The service has no Minecraft connection, server commands, credentials, Discord token or Docker socket.

`backend/src/playable/world-screenshot.mjs` reads an existing Mineflayer bot's loaded client cache synchronously. The caller supplies its registered plot bounds and optional real task target, never paths or coordinates accepted directly from model output. Missing chunks/blocks fail closed. It sends exact semantic block names/properties and a bounded grid to the renderer, alongside the actual loaded-column hashes, agent, world, observation time and camera. The renderer returns a PNG plus hashes and timing. Nothing moves or edits the game world.

Viewer 1.33.0's latest asset set is 1.21.4. It otherwise interprets 1.21.11 state IDs as older IDs, so this adapter explicitly maps observed semantic block states to 1.21.4 models. Unsupported block states fail rather than silently substituting another block. Images show only the observed bounded region from an independent overview camera; they are rendered world observations, not screenshots of the user's Minecraft framebuffer. Label the observation time, world and this distinction when sharing. Never substitute generated imagery or a planned blueprint when capture fails.

```sh
docker build -t agentcity-world-renderer:1.33.0 renderer
docker run -d --init --name agentcity-world-renderer --label agentcity.owner=native-world-renderer \
  --read-only --user 10002:10002 --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 2g --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,uid=10002,gid=10002,mode=0700 \
  -p 127.0.0.1:8793:8793 agentcity-world-renderer:1.33.0
```

The host launcher must refuse an occupied/unowned port or changed container identity. The native service accepts one capture at a time, no browser-origin requests, no file-serving paths, and at most 32×32×32 observed cells. It returns a 960×640 PNG. Its renderer URL is fixed to loopback. Keep it private. Do not mount secrets or world files.

`node renderer/fixture.cjs` checks a clearly labelled synthetic geometry fixture. It does not establish a live Minecraft capture. Real verification requires a snapshot from the already-owned live bot, with root coordination, followed by visual inspection of the resulting PNG. No new player/client login is needed. Existing renderer build dependencies include npm advisories in the node-gyp/tar toolchain; the capture API has no archive extraction operation. This isolated local renderer is not production-qualified by a fixture or container build.

Upstream references: https://github.com/PrismarineJS/prismarine-viewer (MIT), its `lib/headless.js` and `viewer/lib/viewer.js`; https://github.com/stackgl/headless-gl . Native canvas/gl versions are explicitly pinned separately because the optional upstream node-canvas-webgl defaults target older Node ABIs.
