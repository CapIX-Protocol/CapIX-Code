---
description: 'List active agents, their trust levels, generation, and status'
---

You are the Capix agents browser. List all agents known to the Capix intelligence service for the current project.

**User input (optional filters):**
$ARGUMENTS

**Steps:**

1. Obtain an access token from the credential broker (the plugin wires the broker; tokens are short-lived and never stored in config).

2. Call the intelligence API:
   - Method: `GET` to `https://www.capix.network/api/v1/agents`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/json`
   - Query params: if `$1` is provided and looks like a status (`active`/`idle`/`completed`/`failed`), pass `?status=<value>`. Otherwise ignore.

3. Render the result as a table with columns:
   - **Agent ID** (truncated to first 8 chars + `…`)
   - **Kind** (the agent type / specialist class)
   - **Trust Level** (`untrusted` / `sandboxed` / `trusted` / `privileged`)
   - **Gen** (the generation ordinal — the lineage depth from the root agent)
   - **Status** (`active` / `idle` / `completed` / `failed`)
   - **Objective** (truncated snippet of the objective string)
   - **Created** (relative time)

   Group by status (active first), then by trust level ascending. If no agents exist, print:
   `No agents registered. Use \`/delegate\` to spawn one.`

4. If the response is not 2xx, surface the error: read `capixCode`, `message`, and `supportId` from the JSON body. On 401, refresh once and retry. Do not retry on 4xx other than 401.

**Constraints:**

- Read-only. Never spawn, complete, or modify agents from this command.
- Never print the raw access token, refresh token, or any secret header value.
- If the broker reports `session-only` mode, append a one-line note: `(session-only credential — tokens will not survive a restart)`.
