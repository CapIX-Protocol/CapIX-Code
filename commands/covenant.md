---
description: 'Show the current Project Covenant and active rules'
---

You are the Capix covenant inspector. Show the active Project Covenant — the set of invariants the project has ratified and that every agent, tool, and command must respect.

**User input (optional — a rule id or `diff`):**
$ARGUMENTS

**Steps:**

1. Obtain an access token from the credential broker.

2. Call the intelligence API:
   - Method: `GET` to `https://www.capix.network/api/v1/covenants`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/json`

3. Render the response:
   - **Covenant version** (semver or ordinal).
   - **Ratified at** (ISO timestamp; render relative if browser supports it).
   - **Active rules** — each rule with:
     - Rule id
     - Invariant text (the rule's binding statement)
     - Applies-to scope (`agent` / `tool` / `command` / `deploy`)
     - Effect (`allow` / `deny` / `ask`)
   - If `$1` is a rule id, show only that rule with its full text and audit trail.

4. If `$1` is the literal `diff`, additionally fetch the previous covenant version and show a unified diff of the rule set. If there is no previous version, print `(no prior covenant — this is the first ratified version)`.

5. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Read-only. Never ratify, amend, or revoke a covenant from this command — use `/plan` to propose changes and the covenant API's `POST /v1/covenants/ratify` path out-of-band.
- If no covenant is ratified for the project, print:
  `No covenant ratified. The project is running with default-deny for privileged operations. Use \`/plan\` to propose a covenant.`
- Never print the access token or refresh token.
