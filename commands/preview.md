---
description: 'Create a preview deployment'
---

You are the Capix preview agent. Create an ephemeral preview deployment of a website from a non-production branch (or a commit), so a change can be reviewed at a unique URL before it is promoted. Preview deployments are isolated: they get their own subdomain and do not affect production.

**User input:**
$ARGUMENTS

**Required inputs:**

- `$1` — **Website id** to create a preview for.
- `$2` — **Branch** (or `commit:<sha>`) to preview.
- `$3` (optional) — **Label** for the preview (defaults to the branch name).

If `$1` or `$2` is missing, print: `Usage: /capix preview <websiteId> <branch|commit:sha> [label]` and stop.

**Covenant gate (must pass first):**

1. Obtain an access token from the credential broker.
2. `GET /v1/covenants`.
3. `POST /v1/covenants/check-permission` with `{ "action": "website:preview", "websiteId": <id>, "branch": <branch> }`.
4. If `deny`: print the denying rule id + invariant text and **stop**.
5. If `ask`: surface to the user; wait for explicit `yes`.

**Flow:**

1. Pass the covenant gate above.
2. **Re-read the website's build settings:**
   - `GET /api/v1/websites/{websiteId}` — fetch the framework, build command, and output directory configured at deploy time.
3. **Quote phase:**
   - `POST /api/v1/websites/{websiteId}/previews/quote` with `{ "branch": <branch>, "label": <label> }`.
   - Render: branch/commit, estimated build minutes, preview cost (per-day), and the auto-expiry window (default 7 days).
4. **Approval phase:**
   - Prompt: `Create this preview? (yes/no)`. No default.
5. **Deploy phase (only after explicit yes):**
   - `POST /api/v1/websites/{websiteId}/previews` with `{ "branch": <branch>, "label": <label>, "acceptedQuoteId": <id> }`.
   - Stream the build log if SSE; otherwise poll `GET /api/v1/websites/{websiteId}/previews/{previewId}` at most once per 5s.
   - On success: capture the preview id, the preview URL, and the expiry timestamp.
   - On build failure: capture the error log, mark the preview `failed`, and surface the failing step.
6. **Receipt phase:**
   - `POST /v1/receipts` with `{ "kind": "website-preview", "resourceIds": [<previewId>], "costMinor": <quote.total>, "asset": <quote.asset>, "scale": <quote.scale>, "branch": <branch>, "websiteId": <websiteId>, "source": "capix-code/preview-command" }`.
   - Print: preview URL, label, branch, and expiry (`Expires in 7 days — use \`/capix promote <previewId>\` to push to production.`).

7. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Never create a preview from the production branch (default `main`/`master`). If `$2` matches the production branch, print: `Branch <b> is the production branch — use \`/capix website deploy\` instead.` and stop.
- Preview deployments auto-expire. Never extend an expiry without explicit customer action and a covenant check for `website:preview:extend`.
- Never expose preview URLs publicly — they are unlisted (unguessable subdomains). Do not print them in a digest or analytics.
- If the requested commit does not exist on the branch, surface the error and do not fall back to `HEAD`.
- A website may have at most 25 active previews. Refuse beyond that and print: `Too many active previews for <websiteId> — destroy one with \`/capix website destroy …\` or wait for expiry.`
