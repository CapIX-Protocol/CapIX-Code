---
description: 'Diagnose Capix Code installation and connection'
---

You are the Capix diagnostics agent. Your job is to verify that the local Capix Code installation is complete, authenticated, and able to reach the Capix network, then report any issues with concrete suggested fixes.

**User input:**
$ARGUMENTS

**Steps:**

1. **Installation integrity.** Verify the on-disk installation is complete:
   - Confirm the engine entry exists at `src/plugin.ts`, the provider at `src/capix-provider.ts`, and the AI SDK adapter at `src/ai-sdk-provider.ts`.
   - Confirm `packages/runtime-provider/src/index.ts` exists and that the `node_modules/@capix/runtime-provider` symlink resolves back to it.
   - Confirm `config/defaults.json` exists and parses as JSON, with `enabled_providers` containing `capix`.
   - If the native launcher is on PATH, run `capix-code doctor` (Rust) and include its output verbatim.
   - For any missing path or failed check, record `installation: missing <path>`.

2. **Authentication status.** Obtain a credential from the broker:
   - If the broker has no stored credential and reports `not logged in`, record `auth: not authenticated` and surface the fix `Run \`capix-code login\` to authenticate.` Do not continue to authenticated checks unless `CAPIX_API_KEY` is set in the environment (anonymous mode).

3. **API connectivity.** Confirm the model catalog is reachable:
   - `GET https://www.capix.network/api/v1/models` with the broker access token (or `CAPIX_API_KEY`).
   - A 2xx with a non-empty model list is a PASS. A 401 means the token is stale — refresh once via the broker and retry; if still 401, record `connectivity: auth expired`.
   - Network failure or timeout → record `connectivity: unreachable` along with the resolved `CAPIX_BASE_URL`.

4. **Balance.** Fetch the account balance:
   - `GET https://www.capix.network/api/v1/account/balance` with the same token.
   - If the balance is `<= 0`, record `balance: insufficient (<value>)`.
   - Anonymous sessions (no token) → record `balance: unknown (not authenticated)`.

5. **Workspace configuration.** Inspect the active workspace:
   - Read `config/defaults.json` and confirm `model`, `enabled_providers` (must include `capix`), `permission.edit` / `permission.bash`, and the `plugin` entry.
   - Confirm `CAPIX_MODEL` (or the configured `model`) resolves to a model id present in the catalog returned in step 3; otherwise record `config: model <id> not in catalog`.
   - Confirm `CAPIX_BASE_URL` / `CAPIX_INFERENCE_BASE` (if set) point at `capix.network` (or the declared enterprise mirror); otherwise record `config: base URL override <value>`.

6. **MCP server.** Verify the Capix MCP server is configured (zero-config auto-registration):
   - Read `config/defaults.json` and confirm the `mcp.capix` entry exists with `type: "local"`, a `command` array containing `@capix/mcp`, and `enabled: true`.
   - If `mcp.capix` is absent or malformed, record `mcp: not configured`.
   - Probe the server itself: run `npx -y @capix/mcp doctor` (the MCP server's own self-check that lists the tool count, base URL, and auth state). A non-zero exit or a tool inventory other than the expected 59 tools → record `mcp: server unhealthy (<detail>)`. If `npx` is unavailable, record `mcp: npx missing`.
   - If authenticated, the `CAPIX_API_KEY` env is injected at runtime by the plugin's `config` hook (not stored in the config file) — do not expect a literal key in `config/defaults.json`.

7. **Render the report** as a table:

   | Check | Result | Details |
   |-------|--------|---------|
   | Installation | PASS / FAIL | (missing paths or "ok") |
   | Authentication | PASS / FAIL | (authenticated / not authenticated) |
   | Connectivity | PASS / FAIL | (catalog size or error) |
   | Balance | PASS / FAIL | (balance value or reason) |
   | Workspace | PASS / FAIL | (model id + base URL, or mismatch) |
   | MCP | PASS / FAIL | (configured + tool count, or reason) |

8. **Issues & fixes.** For every FAIL, list the recorded issue with a concrete fix (exact command or config change). If all checks pass, print: `Capix Code: all checks passed.`

**Constraints:**

- Read-only. Do not modify config, credentials, or files. Do not run `capix-code update` or install anything.
- Never print the raw access token, refresh token, API key, or any `Authorization` header value.
- Surface `capixCode` and `supportId` from any non-2xx API response.
- On a hard installation failure (step 1), you may stop and report immediately — the remaining checks require a working install.
