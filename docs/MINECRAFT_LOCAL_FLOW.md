# Minecraft internal construction flow

Minecraft uses its own materials, player permissions and game actions. The separate synthetic blockchain demonstration never grants Minecraft items, access, rewards or construction rights. This flow spends $0 and uses the laptop's installed Ollama model temporarily while 0G is unavailable.

The fixed calculator contains 144 placements: 65 stone bricks, four levers, 16 repeaters, 37 torches, 19 redstone dust and three lamps. An operator supplies exactly that stock in a scoped job chest. The declared glass tracks and nine bottom slabs are separate construction access fixtures; the worker cannot mine or place scaffolding to obtain circuit stock.

`backend/src/bot/proposal-gate.mjs` asks the existing inference adapter for a bounded `construct` or `inspect` proposal. The model is `qwen3:1.7b` on loopback Ollama. The gate reads the current job again after inference, rejects a changed job or revision, and applies the existing proposal validator to current authority and lock state. A proposal cannot choose coordinates, material amounts, player identities, credentials, acceptance or payment. The existing Survival worker and plugin enforce every actual operation.

Construction uses the pinned Mineflayer adapter. It observes the real world and inventory, withdraws missing materials from the job chest, follows the fixed access route, and performs native placement with the approved orientation. Each operation is written to a local durable checkpoint before transmission. The plugin records its operation receipt and checks the actual block and inventory effects. Completion alone does not grant review readiness.

Inspection runs the plugin's real 16 input combinations and reads the three lamp outputs. All 16 results must match the calculator truth table. A passing result retains a protected review lock. The requester remains responsible for final human acceptance; scripted fixture players do not prove independent participation.

Run the focused isolated demonstration from the repository root:

```sh
python3 tests/construction/run.py --self-check
python3 tests/construction/run.py --scenario build --internal
```

The demonstration uses a fresh owned container on loopback game port 25592 and control port 25593. It leaves the user's access server on port 25588 and unrelated containers untouched. The fixture freezes and retains the tested source, creates an empty circuit, supplies the exact stock, and connects disclosed scripted builder, requester and inspector players. Docker, the cached pinned Paper runtime, installed compatible Node dependencies and local Ollama must be available.

After the twelfth real native placement, the harness deliberately loses its successful reply before the worker can consume it. The first process stops with that operation still pending. A new process reconnects to the same world and carried inventory, replays the identical operation ID, reconciles the original receipt, and builds the remaining 132 placements. Verification requires 144 unique native placement events, 144 placement receipts, no duplicate effect, and empty remaining stock and builder inventory. It then runs physical inspection and verifies that another real model proposal cannot construct through the protected review lock.

Each attempt, including failures, is retained under `evidence/runs/minecraft-internal/<run-id>/`. Its owned container is stopped and removed after evidence collection; the world files remain under the ignored local runtime directory. This command verifies components in an isolated engineering fixture. It does not approve canonical phase gates, establish current production Minecraft support, replace final human acceptance or verify live 0G.

The successful fresh run is `agentcity-construction-750b0aae`. Both process segments passed six checks. It placed all 144 circuit blocks once, recovered the original uncertain placement receipt once, consumed the exact materials, and produced a real 16/16 PASS at revision 144. Real Ollama proposals selected `construct`, `construct`, `inspect`, then `wait` during protected review. The separate two-check local-model safety run verified that changed revision and review protection both prevent execution. See `evidence/runs/minecraft-internal/verification.json` for exact source and evidence hashes. Earlier failed attempts remain retained; they exposed measured-arrival, slow-reply spacing and fixture connection timing issues that were corrected before the successful fresh run.
