---
description: 'Mark a memory node as superseded'
---

You are the Capix memory manager. Mark an existing memory node as superseded — do not delete it. Superseded nodes remain queryable but are dimmed in `/memory` and excluded from context injection by default.

**User input:**
$ARGUMENTS

**Required inputs:**

- `$1` — **Node ID** to supersede (full or 8-char prefix; resolve via `GET /v1/memory` if ambiguous).
- `$2` (optional) — **Reason** the node is being superseded (e.g., "replaced by decision D-0042", "fact was incorrect"). If omitted, prompt the user once.

**Steps:**

1. Obtain an access token from the credential broker.

2. Resolve the node id:
   - If `$1` is a full id, use it directly.
   - If `$1` is an 8-char prefix, `GET /v1/memory?q=<prefix>` and match on `id.startsWith(prefix)`. If multiple match, list them and stop — ask the user to disambiguate.
   - If no match, print `No memory node matching '<id>'.` and stop.

3. Supersede via the intelligence API:
   - Method: `PATCH` to `https://www.capix.network/api/v1/memory/{id}`
   - Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
   - Body: `{ "status": "superseded", "supersededReason": string, "supersededBy": string | null }`
   - On 401: refresh once and retry. On 404: surface "node not found" with the resolved id. On 409: surface the conflicting transition (e.g., already superseded) and stop. Other non-2xx → hard failure (`capixCode` + `supportId`).

4. After success, print:
   - The node ID and the previous status → new status transition.
   - The reason verbatim.
   - A hint: `Use \`/memory\` to see the superseded node dimmed in context.`

**Constraints:**

- Never `DELETE` memory nodes. Supersede only — the audit trail must remain intact.
- Never supersede a node whose `nodeType` is `constraint` without an explicit reason; if the reason is empty, hard-stop with: `Constraints require a supersession reason.`
- Never bulk-supersede. One node per invocation.
