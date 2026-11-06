# Direct Anthropic personal-agent provider

Personal-agent conversation, custom-design requests and the older one-step
personal-agent planner can use Anthropic's native Messages API. OpenRouter is
not used. Existing Ollama configuration remains the default. The historical
calculator/0G inference adapter is separate and retains its existing providers.

The default private credential file is `.local/inference/anthropic.env`:

```dotenv
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY_HERE
```

Saving a key does not activate paid requests. After the owner approves an API
spending budget, add `ANTHROPIC_LIVE_ACCESS=1` to that private file and set the
host's existing `agent-settings.json` provider/model fields to:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "budgetId": "operator-approved-budget-id",
  "budgetUsd": "10.00",
  "budgetFile": "/home/ansh/.local/share/agentcity-secrets/anthropic-usage.json"
}
```

Preserve any other existing settings. An optional `credentialsFile` field can
point to an operator-protected absolute file outside the checkout; use private
WSL storage for the Windows-hosted server. Never commit the real key. Editing
the Mac's file does not update the Windows host. The standing $0 budget remains
in force until the owner authorizes spending; this change does not enable the
live host or establish a recurring API budget. The owner subsequently approved
up to $10 total for the live switch and testing on 2 November 2026. Initialize
that specific budget explicitly with `initializeAnthropicBudget`, including
the earlier test's estimated $0.010586 cost; startup refuses a missing or
mismatched ledger rather than silently granting a fresh allowance.

Every live-host generation first counts tokens and durably reserves a
conservative cost ceiling shared by all three agents. Actual usage replaces
the reservation when a receipt arrives. A restart retains spending and pending
reservations. Network errors, missing receipts or unusual usage cannot silently
free reserved credit; an operator must reconcile them. Further Claude planning
pauses when the next bounded request cannot fit the remaining allowance.
Existing game tasks and balances are preserved, with no automatic Ollama fallback.

The ledger tracks AgentCity's API calls at the pinned published model rates;
it is not an account-wide Anthropic invoice limit. Keep the latest ledger when
rolling back code or restoring other state. Never restore an older spending
ledger to obtain more credit. Paid planning is limited to supported, priced
models, 32,000 counted input tokens and 4,096 maximum output tokens per call.

Provider startup reads the selected model's capabilities before generation.
Claude Sonnet 5.5 uses `between_tools` for bounded tool-response planning;
older models such as Sonnet 4.6 use `disabled`. An unsupported mode fails
before submitting a generation request.
Claude 5.5 uses automatic tool selection. A complete `return_plan` tool input
or a complete JSON text response reaches the same existing plan validator;
malformed, incomplete and unsupported proposals never execute.

During an idle maintenance window, install the reviewed code and private host
configuration, restart only the owned worker, and verify its readiness before
sending a small owner-authorized task. Keep existing ownership, inventories,
task operations and financial approval rules. There is no silent provider
fallback or automatic retry of a failed billable request.

Run the focused local checks before a live request:

```sh
node tests/inference/anthropic.mjs
node tests/inference/anthropic-budget.mjs
node tests/playable/intent-planner.mjs
node tests/playable/agents.mjs
```

The Anthropic check uses a mocked transport. It checks native request encoding,
the explicit paid-call gate, credential isolation, unchanged plan validation,
the legacy personal-agent caller and fail-closed responses. It does not prove
real model quality, available account credit, game execution or billing.

Live acceptance needs a successful bounded model request, a valid supported
plan, a completed real build with exact material accounting, and pause/resume
verification. Keep a record of the actual provider/model used. Anthropic is
not evidence of a completed 0G integration or a passed canonical phase gate.

## Recorded planning acceptance

The [one-request acceptance report](../evidence/runs/anthropic-live-planning/83b43a59-3db9-4fe9-bf61-dcdfc1d49e71/report.json) records a real Sonnet 5.5 response for a 3 by 3 oak-plank platform: 4,933 input tokens, 72 output tokens, and an estimated $0.010586 generation cost at published standard rates. Three free preflight failures and the original tool-only parser rejection remain recorded. The final parser passed an identical-request replay of the saved real JSON response, with no second generation. No Minecraft task or live host switch was performed.
