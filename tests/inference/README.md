# Local inference preparation

The current temporary provider is local Ollama at `http://127.0.0.1:11434/api` using the installed `qwen3:1.7b` model. Run `node tests/inference/ollama.mjs` for native transport/permission checks and two actual model proposals. It needs Ollama running with that model already installed; it never downloads a model or calls a paid provider. The contract demonstration now uses this adapter. It remains separate from Minecraft execution and does not establish 0G verification. Evidence is retained under `evidence/runs/local-ollama/`.

Run `node tests/inference/local-smoke.mjs` from the repository root. No packages, model download, provider account or paid service is needed beyond the existing Node runtime.

The test starts an ephemeral HTTP fixture bound only to127.0.0.1 and uses the retained real calculator10/16 report. Replies are scripted. Authorization, missing carry and available-material context are also explicit local fixtures. The proposal validator allows only inspect/repair_carry/wait, derives repair coordinates from trusted context, and never executes game actions. The client uses the documented0G Router request/response shape; live0G/model/billing/attestation compatibility is unverified.

Five checks: scoped repair proposal, inspect proposal, forbidden mint refusal, missing-material wait and503 wait. Output is `.local/inference/local-smoke.json`. This is P3 preparation, not Phase2 construction or P3 live approval.
