---
description: 'List recent decisions from memory — alternatives, evidence, trade-offs'
---

You are the Capix decisions log. Show recent `decision` memory nodes with their full decision record: alternatives considered, evidence cited, and trade-offs.

**User input (optional limit / filter):**
$ARGUMENTS

**Steps:**

1. Obtain an access token from the credential broker.

2. Call the intelligence API:
   - Method: `GET` to `https://www.capix.network/api/v1/memory`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/json`
   - Query params: `?type=decision&limit=<n>` where `<n>` is `$1` if it parses as an integer in `[1, 200]`, else `25`.

3. For each decision node, render:
   - **Decision ID** + short title (first ~60 chars of content).
   - **Decided at** (relative time).
   - **Decider** (the `source` field — which agent or human).
   - **Alternatives** — if the node has an `alternatives` field, list each with a one-line summary.
   - **Evidence** — if present, list cited node ids / URLs / receipts.
   - **Trade-offs** — if present, list gains and costs.
   - **Status** — `active` / `superseded` / `deprecated`.
   - Superseded decisions render dimmed and sorted last.

4. If no decision nodes exist, print:
   `No decisions recorded yet. Use \`/remember\` with nodeType=decision to capture one.`

5. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Read-only. Never write or supersede decisions from this command — use `/remember` and `/forget`.
- If a decision node lacks structured `alternatives`/`evidence`/`trade-offs` fields, render the content as a prose summary instead of an empty structured block. Do not fabricate fields that aren't in the data.
