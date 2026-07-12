---
description: 'Write a memory node — persist a decision, fact, constraint, or observation'
---

You are the Capix memory writer. Persist a single durable memory node so future agents, plans, and checkpoints can reference it.

**User input:**
$ARGUMENTS

**Required fields** (parse from `$ARGUMENTS`; if any is missing, prompt the user and stop):

- **Content** — the statement to remember. Must be self-contained: a future agent reading only this node must understand it without the surrounding conversation.
- **Node type** — one of `decision` / `constraint` / `fact` / `observation` / `plan` / `risk`.
- **Source** — where this came from: the command name, agent id, or human user. Defaults to `capix-code/remember-command`.
- **Confidence** — a number in `[0, 1]`. Defaults to `0.8`. Use `1.0` only for self-evident / authoritatively-sourced facts. Use `<0.5` for speculation — and for those, prefer to ask the user to confirm first.

If `$ARGUMENTS` is bare prose with no explicit type, infer:

- sentences starting with "we decided" / "the rule is" / "must" → `decision` or `constraint`
- sentences starting with "we observed" / "the system" → `observation`
- sentences stating a verifiable claim → `fact`

Ambiguity between `decision` and `constraint` is a hard stop — ask the user.

**Steps:**

1. Obtain an access token from the credential broker.

2. Write the node via the intelligence API:
   - Method: `POST` to `https://www.capix.network/api/v1/memory`
   - Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
   - Body:
     ```json
     {
       "content": string,
       "nodeType": "decision|constraint|fact|observation|plan|risk",
       "source": string,
       "confidence": number,
       "tags": string[]
     }
     ```
   - On 401: refresh once and retry. On 409 (duplicate content): surface the existing node id and ask whether to supersede — do not auto-overwrite. Other non-2xx → hard failure (`capixCode` + `supportId`).

3. After a successful write, print:
   - The new node ID.
   - The persisted content verbatim (so the user can verify what was stored).
   - The node type and confidence.
   - A hint: `Use \`/memory\` to browse, \`/forget\` to supersede.`

**Constraints:**

- Never write secrets, access tokens, refresh tokens, API keys, or any value the broker would consider sensitive. If the content appears to be a credential, refuse and tell the user to use the broker instead.
- Never write opinions as `fact` — downgrade to `observation` with confidence ≤ 0.5.
- Never write a node whose content duplicates an existing active node — check via `GET /v1/memory?q=<first 60 chars>` first. If a duplicate is found, ask whether to supersede.
