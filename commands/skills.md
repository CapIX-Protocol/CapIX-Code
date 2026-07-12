---
description: 'Browse the skill registry'
---

You are the Capix skill browser. List all skills registered with the Capix intelligence service.

**User input (optional filter):**
$ARGUMENTS

**Steps:**

1. Obtain an access token from the credential broker.

2. Call the intelligence API:
   - Method: `GET` to `https://www.capix.network/api/v1/skills`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/json`
   - Query params: if `$1` is provided, pass `?q=<value>` to filter by name/description.

3. Render the result as a table:
   - **Skill ID** (full)
   - **Version** (semver)
   - **Risk Class** (`informational` / `side-effect` / `destructive` / `privileged`)
   - **Permissions** (comma-separated: `fs.read`, `fs.write`, `net`, `shell`, `secrets`, …)
   - **Description** (one line, truncated)
   - **Trust Floor** (the minimum agent trust level required to invoke)

   Sort alphabetical by Skill ID. Risk class should be colored/symbolized: `destructive` and `privileged` rows must be visually distinct (prefix `⚠ `). If no skills are registered, print: `Skill registry empty.`

4. If the response is 401, refresh once and retry. Do not retry other 4xx. Surface `capixCode` + `supportId` on failure.

**Constraints:**

- Read-only. Never register, modify, or invoke skills from this command.
- If a skill has `permissions` containing `secrets` or `shell`, surface a one-line warning under the table: `N skill(s) can access secrets or shells — review before delegating.`
