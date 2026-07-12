# Architecture

## Overview

Capix Code is an AI coding agent — not a standalone thin wrapper. The repo contains the Capix plugin and provider (the plugin entry point and supporting modules) plus configuration, theming, and build scripts that build and package the standalone `capix-code` binary.

The original source is never committed to this repo. Instead, it is cloned at build time by `scripts/bootstrap.sh`, rebranded in-place by `scripts/rebrand.sh`, configured by `scripts/install-config.sh`, and compiled into a standalone binary by `scripts/build.sh`.

## Build Pipeline

```
scripts/bootstrap.sh     → clones the upstream source from GitHub (pinned to a specific commit on `dev`)
scripts/rebrand.sh       → renames identity strings → capix-code across all source files
scripts/install-config.sh → bundles Capix provider config, TUI theme, and brand assets
scripts/build.sh         → compiles the standalone binary via Bun + upstream build script
```

### bootstrap.sh

Clones the upstream source into `./upstream/`. The clone is pinned to a specific commit SHA on the `dev` branch for reproducibility. Set `CAPIX_CODE_DIR` to override the target directory.

### rebrand.sh

Performs a series of `sed` substitutions across the cloned source tree:

| What               | Transformation                                     |
| ------------------ | -------------------------------------------------- |
| Binary name        | `opencode` → `capix-code`                          |
| Config dirs        | `.config/opencode` → `.config/capix-code`          |
| Env var prefixes   | `OPENCODE_` → `CAPIX_CODE_`                        |
| Config filename    | `opencode.json` → `capix-code.json`                |
| Install references | `anomalyco/opencode` → `CapIX-Protocol/Capix-Code` |
| Display strings    | `OpenCode` → `CapixCode`                           |

Safe to re-run — each step is idempotent.

### install-config.sh

Copies the Capix provider config (`config/defaults.json`), TUI theme (`themes/capix.toml` + `tui-capix.json`), and brand assets (`brand/banner.ts` + `brand/capix-mark.svg`) into the upstream package tree so they are bundled into the final binary.

### build.sh

Runs `bun install` in the upstream tree, then invokes the upstream `packages/capix-code/script/build.ts --single` to produce a standalone binary. The output is searched for in `packages/capix-code/dist/` and renamed to `capix-code` if the upstream still called it `opencode`.

## Plugin & Routing

### Architecture

```
src/plugin.ts           → Plugin entry point (registers provider, auth, tool/permission hooks with @opencode-ai/plugin)
src/capix-provider.ts   → Capix provider definition + catalog discovery from the credential broker
src/ai-sdk-provider.ts  → AI-SDK adapter wrapping the Capix provider for streaming chat completions
src/broker.ts           → CredentialBroker — OAuth refresh, short-lived access token vending, API-key registration
src/sandbox.ts          → WorkspaceSandbox — command validation, env scrubbing, capability closing
src/native-bridge.ts    → Native bridge between the launcher keyring and the in-process CredentialBroker
src/logger.ts           → Structured JSON logger for observability
```

The `plugin` factory (in `src/plugin.ts`) is the real OpenCode plugin contract (`(input, options?) => Promise<Hooks>`). It registers the `capix` and `capix/auto` provider hooks, an `auth` hook bridging browser-code+PKCE OAuth to `CredentialBroker`, a `tool.execute.before` hook that validates commands against the sandbox and closes broker capabilities, a `shell.env` scrubber, a `permission.ask` enforcer, and a `dispose` hook that revokes the session-only broker.

### Server-Authoritative Routing

Routing **is server-authoritative**: there is intentionally **no client-side router**, prompt classifier, provider scorer, or persisted "smart router" memory on the device. The previous `capixSmartRoute` `onMessage` hook and the `SmartRouter` class have been removed.

When the active model is `capix/auto`:

1. The plugin reuses the same provider hook and catalog as `capix`; no client-side interception occurs.
2. The Capix gateway resolves `auto` to a concrete stable model id per request and returns the decision in the `capix.route` SSE event streamed back to the engine.
3. The client simply forwards the request and renders the routed model selection from the server response.

This keeps model selection, capacity, and pricing logic centralized on the Capix network — clients never re-score, reclassify, or rewrite base URLs locally.

## Config

The default provider config (`config/defaults.json`) registers:

- A `capix` provider using `@ai-sdk/openai-compatible`
- Base URL from `CAPIX_BASE_URL` env var (defaults to `https://capix.network/api/v1`)
- API key from `CAPIX_API_KEY` env var
- 8 pre-listed models (Gemma 3 variants, CodeGemma, Qwen2.5-Coder, Llama 3.3)
- Permission mode: `edit: ask`, `bash: ask` (safe defaults)
- Plugin entry: `./src/plugin.ts`

### Security Note

API credentials (`CAPIX_API_KEY`) are currently passed via environment variables or stored in the upstream auth store. There is a tracked TODO to migrate to OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service / libsecret) so secrets are never written to disk in plaintext.
