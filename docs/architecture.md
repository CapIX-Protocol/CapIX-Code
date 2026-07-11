# Architecture

## Overview

Capix Code is an AI coding agent — not a standalone thin wrapper. The repo contains ~640 lines of original TypeScript (a Smart Router plugin and its plugin entry point) plus configuration, theming, and build scripts that build and package the standalone `capix-code` binary.

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

## SmartRouter Plugin

### Architecture

```
src/plugin.ts          → Plugin entry point (registers with the plugin system)
src/smartRouter.ts     → SmartRouter class — routing logic + persistent memory
src/logger.ts          → Structured JSON logger for observability
```

The `capixSmartRoute` plugin (in `src/plugin.ts`) hooks into the message pipeline via the `onMessage` lifecycle hook. When the active model is `capix/auto`, it intercepts the message and delegates to `SmartRouter` to pick the best model for the task.

### SmartRouter Internals

**Memory hierarchy:**

1. **Short-term (in-memory, per process):**
   - Catalog cache — fetched from the Capix trading board API, cached for 5 minutes
   - Classification cache — per session, cached for 1 minute

2. **Long-term (persisted to disk):**
   - Path: `~/.config/capix-code/smart-router-memory.json` (platform-specific)
   - Contents: learned model ratings, blocked models, favored models, preferred provider, last private endpoint
   - Loaded on construction — the router is "born with memory"

**Scoring formula (`pickBestModel`):**

Each candidate model receives a composite score:

| Factor                                      | Impact            |
| ------------------------------------------- | ----------------- |
| Keyword match (reasoning/coding keywords)   | +2 per match      |
| Favored model                               | +3                |
| Preferred provider match                    | +1                |
| Price > $0.01/1k                            | -1                |
| Price > $0.05/1k                            | -2                |
| Learned rating (selections - overrides * 2) | ×0.5              |
| Blocked model                               | excluded entirely |

Models are sorted by score (descending) then price (ascending). The top model wins. If no models are available, a hardcoded fallback is used.

### Routing Modes

Controlled by `CAPIX_ROUTE_MODE` environment variable.

| Mode             | Behavior                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Classifies the task (reasoning vs coding), fetches the live model catalog, scores models using keywords + learned memory, routes to the best match |
| `private`        | Uses a deployed private LLM endpoint. If none exists, signals `_capixDeployPrivate` for the MCP server to deploy one                               |
| `loop`           | Same as `private` but the agent continues building until the task is complete                                                                      |

### Classification

The classifier sends the first 500 chars of the user's message to `capix/supergemma-gemma3-4b` on the Capix gateway with a 3-second timeout. It responds with "reasoning" or "coding". Results are cached per session for 1 minute. On failure (timeout, network error), it defaults to "coding".

### Learning

When a user manually overrides the router's choice and picks a different model:

1. The rejected model's `overrides` count is incremented (penalty)
2. The chosen model's `selections` count is incremented (boost)

These ratings persist to disk and influence future routing decisions. Users can also explicitly `blockModel` or `favorModel` to control routing permanently.

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
