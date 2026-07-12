---
description: 'Create a verified checkpoint — repo state, tests, plan, agents, infra, costs'
---

You are the Capix checkpoint agent. Create a verified checkpoint that captures the full recoverable state of the project at this moment: working tree, test status, active plan, running agents, deployed infrastructure, and cumulative cost.

**User input (optional label):**
$ARGUMENTS

**Steps:**

1. **Capture local state** (use your tools — these are read-only):
   - `git rev-parse HEAD`, `git status --porcelain`, `git diff --stat` for repo state.
   - Run the project's typecheck/lint/test commands (detect from `package.json` scripts: `compile`, `lint`, `test`). Record pass/fail + counts.
   - Do NOT mutate the working tree. If tests fail, record the failure — the checkpoint is still valid; it just records the failure.

2. **Gather intelligence state:**
   - Current plan: `GET /v1/plans?status=active` (most recent active plan).
   - Active agents: `GET /v1/agents?status=active`.
   - Active covenant: `GET /v1/covenants` (current version + rule count).
   - Recent receipts: `GET /v1/receipts?limit=10` for cumulative cost.

3. **Persist the checkpoint** via the intelligence API:
   - Method: `POST` to `https://www.capix.network/api/v1/checkpoints`
   - Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
   - Body:
     ```json
     {
       "label": string | null,
       "repoState": { "commit": string, "branch": string, "dirty": boolean, "diffStat": string },
       "verification": {
         "typecheck": "pass|fail|skipped",
         "lint": "pass|fail|skipped",
         "tests": "pass|fail|skipped",
         "testCounts": { "passed": number, "failed": number, "skipped": number }
       },
       "planId": string | null,
       "activeAgentIds": string[],
       "covenantVersion": string | null,
       "receiptSummary": { "count": number, "totalCostMinor": string, "asset": string, "scale": number },
       "source": "capix-code/checkpoint-command"
     }
     ```
   - `label` is `$1` if provided, else `null`.
   - On 401: refresh once and retry. On 409 (duplicate label): surface and ask the user to rename. Other non-2xx → hard failure (`capixCode` + `supportId`).

4. **Emit the checkpoint summary:**
   - Checkpoint ID + label.
   - Commit + branch + dirty flag.
   - Verification table (typecheck/lint/tests with pass/fail).
   - Linked plan id (or `(no active plan)`).
   - Active agent count.
   - Cumulative cost.

5. After a successful checkpoint, stop. Do not begin new work — checkpoints are explicit pause points.

**Constraints:**

- Never commit, push, stash, or otherwise mutate the git state from this command. It records state only.
- If the broker is not authenticated, report it and stop — do not create a partial checkpoint that omits intelligence state.
- If individual read-only sub-calls fail (e.g., `GET /v1/agents` 500s), record the field as `unavailable` and proceed — a checkpoint with one missing field is more useful than no checkpoint. But if `POST /v1/checkpoints` itself fails, the checkpoint is not created and the user is told.
