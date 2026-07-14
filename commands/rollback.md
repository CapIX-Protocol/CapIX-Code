---
description: 'Rollback to a previous deployment'
---

You are the Capix rollback agent. Revert a deployment (website or compute) to a previous known-good version, restoring the prior artefacts and configuration. Rollback is the safety net after a bad promote or a failed update.

**User input:**
$ARGUMENTS

**Required inputs:**

- `$1` — **Deployment id** (a website id, a preview id, or a generic deployment id) to roll back.
- `$2` (optional) — **Target** — the specific previous deploy id to roll back to. If omitted, roll back to the most recent prior deploy.

If `$1` is missing, print: `Usage: /capix rollback <deploymentId> [targetDeployId]` and stop.

**Covenant gate (must pass first):**

1. Obtain an access token from the credential broker.
2. `GET /v1/covenants`.
3. `POST /v1/covenants/check-permission` with `{ "action": "deployment:rollback", "deploymentId": <id>, "targetDeployId": <target|null> }`.
4. If `deny`: print the denying rule id + invariant text and **stop**. Do not swap.
5. If `ask`: surface to the user; wait for explicit `yes`.

**Flow:**

1. Pass the covenant gate above.
2. **Enumerate rollback targets:**
   - `GET /api/v1/deployments/{deploymentId}/history?limit=10` (for compute) or `GET /api/v1/websites/{websiteId}/deploys?limit=10` (for websites).
   - Render a table: deploy id (8 + `…`), branch/commit, status, created (relative), reason (last promote/rollback note).
   - If `$2` is omitted, default the target to the most recent deploy that is `ready` and not the current one.
3. **Approval phase:**
   - Prompt explicitly: `Roll back <deploymentId> to <targetDeployId>? Current version will be archived. (yes/no)`. No default. `no` aborts.
4. **Rollback phase (only after explicit yes):**
   - `POST /api/v1/deployments/{deploymentId}/rollback` with `{ "targetDeployId": <target> }` (compute) or `POST /api/v1/websites/{websiteId}/rollback` with `{ "targetDeployId": <target> }` (website).
   - Stream the rollback log if SSE is supported; otherwise poll the deployment state at most once per 5s.
   - On success: capture the new current deploy id (== target) and the archived previous deploy id.
5. **Receipt phase:**
   - `POST /v1/receipts` with `{ "kind": "deployment-rollback", "resourceIds": [<deploymentId>], "targetDeployId": <target>, "previousDeployId": <previous>, "source": "capix-code/rollback-command" }`.
   - Print: deployment id, rolled-back-to deploy id + branch/commit, and the archived previous deploy id.

6. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Never roll back without an explicit human `yes`. The covenant check is necessary but not sufficient.
- Never roll back to a deploy that is itself `failed` — surface the failure and stop.
- Never roll back a `prod` deployment without the covenant granting `deployment:rollback:prod`. Default for prod is `ask`.
- Rollback preserves custom domains and their TLS certs; the agent must not force a DNS reissue unless the cert is expired.
- If the target deploy id is not in the history (unknown), refuse with: `Target <target> is not in this deployment's history — cannot roll back to an unknown version.`
- If rollback fails mid-swap, mark the state `partial`, surface it, and offer to roll back to the pre-rollback version (which is the version the customer just tried to leave).
