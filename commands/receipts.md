---
description: 'List work receipts — useful-work evidence and anchoring status'
---

You are the Capix receipts browser. Show work receipts — the durable evidence that an agent (or human) produced useful, verified work. Receipts are the ledger the system uses for billing, anchoring, and trust scoring.

**User input (optional filters):**
$ARGUMENTS

**Filters** (parsed from `$ARGUMENTS`):

- `$1` as `agent:<id>` → filter by agent id.
- `$1` as `kind:<value>` → filter by receipt kind (`inference` / `infra-provision` / `infra-destroy` / `verification` / `review`).
- `$1` as integer N → `?limit=N` (default 50, capped at 200).
- `$1` as `unanchored` → `?anchored=false` (show only receipts not yet anchored to a checkpoint/work-batch).
- Bare prose → `?q=<text>` full-text filter on the receipt summary.

**Steps:**

1. Obtain an access token from the credential broker.

2. Call the intelligence API:
   - Method: `GET` to `https://www.capix.network/api/v1/receipts`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/json`
   - Query params assembled from the filters above.

3. Render the result as a table:
   - **Receipt ID** (first 8 chars + `…`)
   - **Kind**
   - **Agent** (the agent id or `human` if source is a human-run command)
   - **Cost** (`amount asset^scale` formatted, e.g., `0.0042 USD·6`)
   - **Timestamp** (relative)
   - **Anchored?** — `yes` if the receipt is anchored to a checkpoint/work-batch, `no` otherwise (with a `●` marker to make unanchored receipts visible at a glance).
   - **Summary** (one line, truncated to ~80 chars)

   Sort by timestamp descending. Group by kind if more than 20 receipts are returned.

4. **Summary footer:**
   - Total receipts shown.
   - Total cost (sum, preserving asset/scale).
   - Count of unanchored receipts: `N receipts not yet anchored to a checkpoint — run \`/checkpoint\` to anchor them.`

5. If `$1` is `anchor`, additionally call the anchoring endpoint:
   - `POST /v1/receipts/anchor` with the current unanchored receipt ids.
   - Print the resulting batch id + count anchored.
   - Do NOT anchor if any receipt is `outcome: "failed"` — surface those first and ask the user whether to anchor the rest.

6. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Read-only (except when `$1` is `anchor`, which performs exactly one anchoring call).
- Never print raw token values from any receipt body — mask anything matching `(token|bearer|secret|key)\s*[:=]\s*\S+`.
- Receipts tied to `redacted` resource ids show `<redacted>` for those fields, but their cost must still appear in totals.
