---
description: 'Clean up task resources — destroy infra, reconcile, capture billing'
---

You are the Capix cleanup agent. Tear down infrastructure provisioned for a completed (or abandoned) task, reconcile the resource graph, and capture final billing so there's no orphaned spend.

**User input:**
$ARGUMENTS

**Required input:**

- `$1` — **Task / agent ID or deployment label** whose resources should be cleaned up. Resolve via `GET /v1/agents/{id}` or `GET /v1/receipts?label=<label>` if it's a label.

If `$1` is missing, print: `Usage: /cleanup <agentId|label>` and stop.

**Covenant gate (must pass first):**

1. Obtain an access token from the credential broker.
2. `GET /v1/covenants`.
3. `POST /v1/covenants/check-permission` with `{ "action": "infra:destroy", "target": <id-or-label> }`.
4. If `deny`: print the denying rule + invariant and **stop**. Do not enumerate resources, do not destroy.
5. If `ask`: surface to the user. Wait for explicit `yes`.

**Steps:**

1. **Enumerate resources** tied to the target:
   - `GET /v1/graph` query `{ "start": { "id": "<agentOrLabel>" }, "relationship": "provisioned-for|owns|created", "depth": 3 }`.
   - Fetch each resource's current state via `GET /v1/infra/resources/{id}`.
   - Render a table: resource id, type, region, current state, monthly cost, last touched.

2. **Approval phase:**
   - Print the resource list + estimated final cost + which resources will be destroyed vs kept (e.g., persistent volumes may be kept by policy).
   - Prompt explicitly: `Destroy these N resources? (yes/no)`. No default. `no` aborts without changes.

3. **Destroy phase (only after explicit yes):**
   - For each resource to be destroyed: `DELETE /v1/infra/resources/{id}` or `POST /v1/infra/destroy` with the batch.
   - Stream the destroy log if SSE is supported.
   - On partial failure: re-query survivors and report which failed. Retry once per failed resource if the error class is `retry`.

4. **Reconcile:**
   - Re-enumerate via the graph query above. Confirm all targeted resources are gone.
   - If any survive due to partial failure, list them as `orphaned` with their resource ids and monthly cost — these need manual follow-up.

5. **Capture billing:**
   - `GET /v1/receipts?agentId=<id>` — fetch all receipts tied to this task.
   - Compute the cumulative cost (sum `costMinor` across receipts, preserving `asset`/`scale`).
   - `POST /v1/receipts` with `{ "kind": "infra-destroy", "destroyedResourceIds": [...], "finalCostMinor": <total>, "asset": <asset>, "scale": <scale>, "orphanedResourceIds": [...], "source": "capix-code/cleanup-command" }`.
   - Print the receipt id + final cost.

6. **Supersede the task's plan** if the task is `completed` (not `abandoned`):
   - `PATCH /v1/memory/{planNodeId}` with `{ "status": "superseded", "reason": "task completed and resources cleaned up" }`.

**Constraints:**

- Never destroy without an explicit human `yes`. The covenant check is necessary but not sufficient.
- Never destroy resources that weren't provisioned by this task. If the graph query returns resources owned by other tasks/agents, exclude them and note: `N resources skipped — owned by other tasks.`
- Never destroy `prod` resources without the covenant granting `infra:destroy:prod`. Default for prod is `deny`.
- If the broker is `session-only`, refuse prod destruction with the same warning as `/deploy`.
- Always capture a final receipt even if destruction failed — the receipt records `outcome: "partial"` with the orphan list. No-free-lunch on accounting.
