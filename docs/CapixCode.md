# Capix Code — Feature Documentation

> **Version:** 1.3.0 · **Plugin:** 1.2.7 · **ACP version:** 1  
> **License:** Apache-2.0 · **Repository:** [CapIX-Protocol/CapIX-Code](https://github.com/CapIX-Protocol/CapIX-Code)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [CLI Commands](#3-cli-commands)
4. [Plugin System](#4-plugin-system)
5. [Codebase Indexer](#5-codebase-indexer)
6. [Context Retriever](#6-context-retriever)
7. [Planner](#7-planner)
8. [Subagents](#8-subagents)
9. [Skills](#9-skills)
10. [Provider](#10-provider)
11. [Credential Broker](#11-credential-broker)
12. [Sandbox](#12-sandbox)
13. [Configuration](#13-configuration)
14. [Architecture](#14-architecture)

---

## 1. Overview

Capix Code is a decentralized AI coding agent that combines the **Capix agent engine** with its native network runtime to deliver a fully branded, authenticated, sandboxed coding experience on the Capix network.

### What it is

| Aspect | Detail |
|---|---|
| **Engine** | Capix agent engine — the bundled TypeScript/Bun coding runtime |
| **Plugin** | The Capix plugin (`src/plugin.ts`), ~1,050 lines of original TypeScript that registers the provider, broker, sandbox, tools, planner, subagents, and skills |
| **Launcher** | A Rust native binary (`launcher/`) that manages the OS keyring, OAuth PKCE flow, environment scrubbing, model catalog discovery, and engine spawning |
| **Default model** | `capix/auto` — server-authoritative smart routing that delegates model selection to the Capix gateway per-request |
| **Branding** | Capix ASCII art banner, neon teal (`#3DCED6`) + green (`#14F195`) brand palette, deep slate-navy TUI canvas |

### Key capabilities

- **Server-authoritative routing** — no client-side classifier, prompt scorer, or router memory. The `capix/auto` model target is resolved by the server and returned in the `capix.route` SSE event.
- **Local codebase intelligence** — a TypeScript AST + Python/Rust regex indexer builds a symbol and import graph in memory, powering semantic search, find-references, and context retrieval with zero external dependencies.
- **Model-driven planning** — a `Planner` decomposes natural-language requests into checkpointable steps with file lists, test commands, dependencies, and estimated turns.
- **Isolated subagents** — plan steps delegate to child agents in isolated git worktrees, bounded by turns, elapsed time, and spend ceiling.
- **Built-in skills** — six first-party skills (orientation, TDD, refactor, debug, review, deploy) auto-selected by trigger regex on each turn.
- **Credential broker** — OAuth PKCE S256 with refresh-token rotation, reuse detection, and OS-secure-storage enforcement. Refresh tokens never touch the engine, plugins, shell, config, env, or logs.
- **Workspace sandbox** — three profiles (restricted, developer, host) enforcing path-traversal protection, secret-path blocking, environment scrubbing, and command approval.
- **DEV token rewards** — verifiable development work mints on-chain DEV tokens (Solana devnet pre-mainnet).

### Bundled in Capix IDE

When launched from Capix IDE, the IDE sets `CAPIX_BASE_URL`, `CAPIX_API_KEY`, and `CAPIX_MODEL` env vars from its SecretStorage, so `capix-code` works with zero additional setup.

---

## 2. Installation

Capix Code ships as unsigned customer builds. **Always verify the SHA-256 checksum** of every downloaded artifact against its adjacent `.sha256` file before installation.

### 2.1 Curl install (shell installer)

The `scripts/install.sh` installer resolves a pinned version, downloads the platform-appropriate tarball, verifies the SHA-256 checksum, and stages the runtime:

```bash
CAPIX_STABLE_VERSION=v2.4.8 bash scripts/install.sh latest
```

Or pin a specific version:

```bash
bash scripts/install.sh v2.4.8
```

The installer:
1. Resolves `latest` to an immutable version via `CAPIX_STABLE_VERSION` (fails closed without it).
2. Detects OS (`darwin`/`linux`) and architecture (`arm64`/`x64`).
3. Downloads the tarball and its adjacent SHA-256 from `https://github.com/CapIX-Protocol/CapIX-Code/releases/download/<version>/`.
4. Verifies exactly one checksum line matching the artifact name and a 64-char hex digest.
5. Extracts `customer/bin/capix-code` into `~/.local/share/capix-code/` and symlinks it to `~/.local/bin/capix-code`.
6. Never invokes `sudo` — installs to user-owned directories only.

Environment overrides:

| Variable | Default | Description |
|---|---|---|
| `CAPIX_CODE_VERSION` / `$1` | — | Version to install |
| `CAPIX_STABLE_VERSION` | — | Immutable pin for `latest` |
| `CAPIX_INSTALL_DIR` | `~/.local/bin` | Symlink target directory |
| `CAPIX_CODE_RUNTIME_DIR` | `~/.local/share/capix-code` | Runtime extraction directory |
| `CAPIX_RELEASE_BASE_URL` | `https://github.com/CapIX-Protocol/CapIX-Code/releases/download` | Release download base |

### 2.2 Homebrew

Homebrew support is planned but not yet available. Use the checksum-verified release installer until the Capix Homebrew tap is published.

### 2.3 npm

The npm distribution is not the authoritative customer channel until its
`latest` tag matches the release documented here. Use the verified GitHub
release installer above; it installs the exact native launcher and runtime for
the current platform without requiring Node.js.

### 2.4 GitHub releases

Direct download from [GitHub Releases](https://github.com/CapIX-Protocol/CapIX-Code/releases). Each release provides:

- `capix-code-<version>-<os>-<arch>-unsigned.tar.gz` — the runtime bundle
- `capix-code-<version>-<os>-<arch>-unsigned.tar.gz.sha256` — adjacent checksum

**macOS (Apple silicon):**

```bash
set -euo pipefail
CODE_VERSION=v2.4.8
CODE_ARCH=arm64
CODE_NAME="capix-code-${CODE_VERSION#v}-darwin-${CODE_ARCH}-unsigned"
CODE_URL="https://github.com/CapIX-Protocol/CapIX-Code/releases/download/${CODE_VERSION}"

cd ~/Downloads
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz"
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz.sha256"

ACTUAL="$(shasum -a 256 "${CODE_NAME}.tar.gz" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "${CODE_NAME}.tar.gz.sha256")"
test "${ACTUAL}" = "${EXPECTED}" || { echo "Checksum mismatch — do not install"; exit 1; }

tar -xzf "${CODE_NAME}.tar.gz"
rm -rf "${HOME}/.local/share/capix-code"
mkdir -p "${HOME}/.local/share/capix-code" "${HOME}/.local/bin"
ditto customer "${HOME}/.local/share/capix-code"
ln -sfn "${HOME}/.local/share/capix-code/bin/capix-code" "${HOME}/.local/bin/capix-code"
export PATH="${HOME}/.local/bin:${PATH}"

capix-code --version
capix-code doctor
capix-code login
```

For Intel Mac, use `CODE_ARCH=x64`. For Linux, use `sha256sum` instead of `shasum -a 256` and `cp -a customer/.` instead of `ditto`. Windows downloads a `.zip` and uses `Get-FileHash -Algorithm SHA256` in PowerShell.

### 2.5 Build from source

Requires Node.js 20+, Rust stable, C/C++ build tools, and Bun `1.3.14` exactly:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
git clone https://github.com/CapIX-Protocol/CapIX-Code.git
cd CapIX-Code
test "$(bun --version)" = "1.3.14"
./scripts/bootstrap.sh          # hydrates the pinned agent-engine source
./scripts/rebrand.sh            # rebrands identity strings → capix-code
BUN_BIN="$(command -v bun)" ./scripts/build.sh
./dist/customer/bin/capix-code --version
```

### 2.6 Post-install verification

```bash
capix-code --version       # print version
capix-code doctor          # verify installation completeness
capix-code login           # OAuth PKCE browser login
capix-code llm-run "Reply with exactly: CAPIX_REMOTE_OK"  # test inference
capix-code                 # launch the interactive TUI
```

---

## 3. CLI Commands

The Rust launcher (`launcher/src/main.rs`) is the entry point. It parses subcommands, manages the OS keyring, and either delegates to native functions or launches the Bun engine with the Capix config injected.

### 3.1 `capix-code` (run)

```bash
capix-code [engine-args...]
```

Launches the interactive TUI coding agent. The launcher:
1. Locates the bundled engine at `<install_root>/engine/capix-engine`.
2. Scrubs all secret-looking env vars from the process environment (see [§12 Sandbox](#12-sandbox)).
3. Obtains a fresh short-lived access token from the keyring via refresh-token rotation.
4. Fetches the live model catalog and billing status from the Capix API.
5. Builds a config with the live models merged into the provider entry, the plugin path pointing to the Capix runtime, and `capix/auto` as the default model.
6. Injects env vars: `CAPIX_CODE_BUNDLED_RUNTIME`, `CAPIX_CODE_PLUGIN`, `CAPIX_CODE_DEFAULT_CONFIG`, `CAPIX_CODE_CONFIG_CONTENT`, `CAPIX_BASE_URL`, `CAPIX_INFERENCE_BASE_URL`, `CAPIX_API_KEY`, `CAPIX_RELEASE_ID`.
7. Spawns the engine as a child process.

### 3.2 `capix-code llm-run`

```bash
capix-code llm-run "<prompt>"
```

Runs a single streaming inference request through the Capix compute network without launching the full TUI. Key characteristics:

- **Streaming:** uses SSE (`text/event-stream`) via `POST /api/v1/chat/completions`.
- **Max tokens:** `max_tokens: 4096` (hard-coded in the launcher's `llm_run()` function at `launcher/src/main.rs:719`).
- **Model:** `"auto"` (server-authoritative routing).
- **Idempotency key:** derived from a nanosecond timestamp.
- **Output rendering:** streams `choices[0].delta.content` to stdout. Displays `[routed to <model> in <region>]` from `capix.route` events, usage tokens from each chunk's `usage` object, and cost from `capix.costMinor`.
- **Receipt:** prints the `capix.receiptId` to stderr on completion or `[DONE]`.

### 3.3 `capix-code doctor`

```bash
capix-code doctor
```

Verifies the installation is complete by checking that all required runtime files exist:

| Required path (relative to install root) |
|---|
| `engine/capix-engine` (or `engine/capix-engine.exe`) |
| `runtime/src/plugin.ts` |
| `runtime/src/native-bridge.ts` |
| `runtime/src/capix-provider.ts` |
| `runtime/src/broker.ts` |
| `runtime/src/sandbox.ts` |
| `runtime/src/ai-sdk-provider.ts` |
| `runtime/node_modules/@capix/runtime-provider/package.json` |
| `config/capix-defaults.json` |

Outputs the installation root and engine path if all files are present.

### 3.4 `capix-code login`

```bash
capix-code login
```

Runs the interactive OAuth PKCE browser flow (see [§11 Credential Broker](#11-credential-broker)):
1. Generates a PKCE verifier (32 random bytes, base64url) and challenge (SHA-256, base64url).
2. Generates a 24-byte random state token.
3. Binds an ephemeral loopback TCP port on `127.0.0.1`.
4. Opens the system browser to `https://www.capix.network/oauth/authorize` with `response_type=code`, `client_id=capix-code`, `code_challenge_method=S256`, and the redirect URI.
5. Waits for the browser callback (180s read timeout).
6. Validates the OAuth state matches.
7. Exchanges the authorization code for tokens at `https://www.capix.network/oauth/token`.
8. Stores the refresh token in the OS keyring (macOS Keychain / Windows Credential Manager / Linux Secret Service) via the `keyring` crate.
9. Also writes the refresh token to `~/.capix-code/credentials.json` (mode `0600`) so the in-process `CredentialBroker` can read it via `globalThis.capixSecureStore`.

### 3.5 `capix-code models`

```bash
capix-code models
```

Fetches and pretty-prints the live model catalog from `GET /api/v1/models` using the authenticated access token.

### 3.6 `capix-code new`

```bash
capix-code new                          # list templates
capix-code new <template> [name]        # scaffold into ./<name>
capix-code new <template> [name] --deploy
```

One-command MVP scaffolding. Template resolution is API-first: the list comes
from `GET /api/v1/templates` (public route). The API catalog is a *deployment
spec* catalog — it carries stack/features/customization metadata and a
workload spec for the quote → deployment pipeline, but no local file tree — so
local scaffolding uses the built-in file trees (`static-site`, `next-saas`).
The listing marks which templates came from the API and which are built in;
asking to scaffold an API-only template fails with an explicit explanation.

Scaffolding writes the template's file tree into `./<name>` (default: the
template id), substituting the project name for `{{PROJECT_NAME}}` in every
file. It fails if the target directory exists and is non-empty. Names must
match the control-plane deployment-name rule (`^[a-z0-9][a-z0-9-]{1,62}$`).

With `--deploy`: if `./<name>` has a git remote `origin` (detected via
`git remote get-url origin`), the CLI POSTs `{name, sourceRef, buildCommand}`
to `/api/v1/websites` with an idempotency key and prints the resulting website
id / status / preview URL. Without a remote it prints the exact
`git init` / `remote add` / `push` steps and exits 0 — no deploy is claimed.
If the API is unreachable or returns an error, the failure is reported; the
scaffolded files remain on disk.

The API base is `WEB_ORIGIN`, overridable via `CAPIX_WEB_ORIGIN` (used by the
launcher's mock-server tests).

### 3.7 Other CLI commands

| Command | Description |
|---|---|
| `capix-code logout` | Deletes the keyring entry and removes the file-based credentials store |
| `capix-code new [template] [name] [--deploy]` | Lists templates or scaffolds a new project; `--deploy` POSTs to `/api/v1/websites` when a git remote exists (see §3.6) |
| `capix-code auth status` | Shows sign-in status and fetches `/api/v1/me` account info |
| `capix-code auth reset` | Clears all credentials (keyring + file store) |
| `capix-code account` | Fetches and prints `/api/v1/me` |
| `capix-code project` | Renders project-scoped context (project ID, role) from `/api/v1/me` |
| `capix-code balance [--asset CPX]` | Fetches billing; `--asset CPX` renders CPX balance with integer formatting |
| `capix-code billing history [--asset CPX]` | Billing history with optional CPX filtering |
| `capix-code quote "<prompt>" [--asset USDC\|CPX] [--model <model>]` | Requests a price quote from `POST /api/v1/quotes` |
| `capix-code status` / `usage` | Fetches billing from `GET /api/v1/billing` |
| `capix-code operations` / `instances` | Lists deployments from `GET /api/v1/deployments` |
| `capix-code gpu-status` | Fetches `/api/v1/gpu` |
| `capix-code deploy llm --model <id> --quote <quoteId>` | Deploys a one-click LLM via `POST /api/v1/llm/deploy` |
| `capix-code destroy <id>` | Destroys a deployment or GPU asset via `DELETE` |
| `capix-code invoices` | Fetches `/api/v1/invoices` |
| `capix-code receipts list` | Lists route receipts from deployments |
| `capix-code receipts verify <receiptId>` | Fetches + locally verifies a Merkle proof for a receipt |
| `capix-code settlement status` | Settlement epoch / root / cluster / paused |
| `capix-code settlement epochs` | Lists recent settlement epochs |
| `capix-code settlement proof-balance` | Fetches + locally verifies a Merkle balance proof |
| `capix-code settlement proof-usage <receiptId>` | Fetches + locally verifies a Merkle usage proof |
| `capix-code dev proof <awardId>` | Fetches and displays a DEV-token work proof |
| `capix-code solana transaction <signature>` | Read-only Solana transaction inspection (never holds keypairs) |

All API commands:
- Connect to `https://www.capix.network` (configurable via `WEB_ORIGIN` compile-time constant).
- Use a bounded HTTPS client (5s connect timeout, 20s total timeout).
- Strip all secret-looking env vars before any subprocess launch.

---

## 4. Plugin System

The Capix plugin (`src/plugin.ts`) implements the engine hook contract: `(input, options?) => Promise<Hooks>`. It is the single integration point between the Capix network and the agent engine.

### 4.1 Plugin factory

```typescript
export const plugin: Plugin = async (input, options?) => Promise<Hooks>
```

The plugin factory (`src/plugin.ts:407`):
1. Resolves release ID, client version, and plugin metadata.
2. Instantiates the `CredentialBroker` and `WorkspaceSandbox` (singletons).
3. Wires the broker accessor and inference base URL resolver into the provider module.
4. Wires the intelligence client (context injection, covenant gate) to the same broker.
5. Starts the `CodebaseIndexer` (background, non-blocking).
6. Instantiates `Planner`, `SubagentManager`, `ContextCompactor`, and `SkillsRuntime`.
7. Installs all 6 built-in skills.
8. Registers 5 tools and returns the `Hooks` object.

### 4.2 Registered hooks

The `Hooks` object registers the following engine hooks:

| Hook | Purpose |
|---|---|
| `provider` | Registers the `capix` provider ID with model discovery from the broker-backed catalog |
| `config` | Zero-config MCP registration — injects the Capix MCP server programmatically (never writes to the user's config file) |
| `tool` | Registers 5 Capix tools (see below) |
| `auth` | Bridges browser OAuth code+PKCE and API-key registration to the `CredentialBroker` |
| `tool.execute.before` | Validates bash/task commands against the sandbox; closes broker capabilities before tool launch; gates `/deploy` and `/cleanup` via covenant |
| `chat.params` | Injects intelligence context, codebase context, skill system-prompt, and compaction summary into each turn |
| `chat.message` | Captures user-authored text into a rolling transcript for skills auto-select and loss-aware compaction |
| `shell.env` | Scrubs secrets from the environment before tool processes inherit it |
| `permission.ask` | Enforces sandbox profile (deny network in restricted, deny secret-path reads, default to `ask`) |
| `dispose` | Stops the codebase watcher, nulls the broker and sandbox singletons |

### 4.3 The 5 Capix tools

Each tool is registered under `Hooks.tool` using the bundled tool factory with a Zod schema:

#### `capix_search_codebase`

Searches the workspace codebase for files and symbols relevant to a natural-language query, symbol name, or path fragment.

| Parameter | Type | Description |
|---|---|---|
| `query` | `string` | Natural-language query, symbol name, or path fragment |
| `limit` | `number?` | Maximum files to return (default 10) |

Returns matching files ranked by relevance (score 0–1) with human-readable reasons. Delegates to `ContextRetriever.findRelevantFiles()`.

#### `capix_find_references`

Finds the definition and all references to a named symbol across the workspace.

| Parameter | Type | Description |
|---|---|---|
| `symbol` | `string` | Exact symbol name (function, class, variable, etc.) |

Returns `definition: <type> <name> — <filePath>:<line>` plus a list of reference locations. Delegates to `CodebaseIndexer.findDefinition()` and `findReferences()`.

#### `capix_get_orientation`

Returns a compact project summary: detected frameworks, entry points, key modules, and notable exports. No arguments. The recommended first call when the model needs a high-level understanding of the codebase.

#### `capix_plan`

Creates a structured, checkpointable plan from a natural-language request.

| Parameter | Type | Description |
|---|---|---|
| `request` | `string` | The user request to decompose into a plan |

Returns the rendered plan (goal, non-goals, assumptions, security/billing implications, rollback strategy, definition of done, and ordered steps with file lists and estimated turns). Delegates to `Planner.plan()`.

#### `capix_delegate`

Delegates a plan step to an isolated subagent in its own git worktree, bounded by turns/time/spend.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `stepDescription` | `string` | — | Description of the step to delegate |
| `filesToRead` | `string[]?` | `[]` | Files the subagent should read first |
| `filesToEdit` | `string[]?` | `[]` | Files the subagent will modify |
| `filesToCreate` | `string[]?` | `[]` | New files the subagent will create |
| `testsToRun` | `string[]?` | `[]` | Test commands to run after the step |
| `maxTurns` | `number?` | `8` | Hard turn limit |
| `maxElapsedMs` | `number?` | `120000` | Hard time limit in ms |
| `maxSpendUsdMinor` | `string?` | `"500"` | Hard spend limit in USD minor units |
| `model` | `string?` | `capix/auto` | Model target |

Returns changed files, completion status, duration, turns, and cost. Delegates to `SubagentManager.spawn()`.

---

## 5. Codebase Indexer

**Source:** `src/codebase-index/indexer.ts`

The `CodebaseIndexer` parses the project into an in-memory symbol and import graph. It uses **only Node.js built-ins** plus the TypeScript compiler API — no external embedding model or database.

### 5.1 Parsers

| Language | Parser | File extensions |
|---|---|---|
| **TypeScript / JavaScript** | TypeScript compiler API (`ts.createSourceFile`, real AST) | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` |
| **Python** | Regex (line-based) | `.py` |
| **Rust** | Regex (line-based) | `.rs` |
| **Config files** | Detected by name (always a `config` symbol) | `package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc. |

#### TS/JS AST capabilities

The TypeScript AST visitor (`parseTsJs`) extracts:
- Functions (declarations, arrow functions, function expressions) with `async` flag, parameter names, return type
- Classes and their methods (including getters/setters)
- Variables (including arrow-function initializers)
- Interfaces and type aliases
- Enums
- Imports (default, named, namespace) with spec-to-file resolution
- Export declarations and re-exports
- Next.js App Router route handlers (`GET`, `POST`, etc. exported functions)
- Express/Next.js `app.get()`/`router.post()` call expressions as `route` symbols
- NestJS-style HTTP decorator routes (`@Get()`, `@Post()`, etc.)

#### Python parser

Regex-based extraction of:
- `def` / `async def` functions (with parameter names, excluding `self`/`cls`)
- `class` declarations
- `from X import Y` statements with relative-path resolution
- `import X` statements

#### Rust parser

Regex-based extraction of:
- `fn` / `pub fn` / `async fn` (with parameters excluding `self`/`&self`/`mut`, return type)
- `struct` / `pub struct`
- `impl` blocks
- `use` statements

### 5.2 Import resolution

The indexer resolves relative imports to absolute file paths:

- **TS/JS:** Tries the specifier with `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` extensions, and `index.*` variants in the directory. Bare specifiers (e.g., `react`, `node:fs`) are left unresolved (`toFile: ''`).
- **Python:** Resolves `from .pkg.mod import x` by counting leading dots for relative path depth, then trying `<mod>.py` and `<mod>/__init__.py`.

### 5.3 Index structure

The `CodebaseIndex` (`src/codebase-index/indexer.ts:70`) contains:

| Field | Type | Description |
|---|---|---|
| `rootPath` | `string` | Canonical project root |
| `files` | `Map<string, FileIndex>` | Absolute file path → file index |
| `symbols` | `Map<string, SymbolNode>` | Symbol name → canonical definition |
| `importGraph` | `Map<string, string[]>` | File → files it imports (forward graph) |
| `reverseImportGraph` | `Map<string, string[]>` | File → files that import it (reverse graph) |
| `updatedAt` | `number` | Last update timestamp |

Each `FileIndex` holds: `path`, `language`, `lineCount`, `symbols[]`, `imports[]`, `exports[]`, `lastModified`, `contentHash` (SHA-256).

Each `SymbolNode` has: SHA-256 prefix `id`, `name`, `type` (`function` | `class` | `variable` | `import` | `export` | `interface` | `type` | `route` | `config`), `filePath`, `line`, `column`, `exported`, `async?`, `parameters?`, `returnType?`.

### 5.4 Limits

| Constant | Value | Description |
|---|---|---|
| `MAX_FILES` | 5,000 | Hard cap on indexed files; `walkDir` and `indexAll` stop at this limit |
| `MAX_INDEX_BYTES` | 50 MB | Serialization cap for the persistent cache; persist is skipped if exceeded |
| `DEBOUNCE_MS` | 500 | Debounce window for fs.watch re-indexing |

### 5.5 File walking

`walkDir(root)` recursively walks the project directory, skipping:
- `node_modules`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.next`, `out`, `.cache`, `.turbo`, `coverage`
- Hidden directories (starting with `.`)

A file is indexable if `detectLanguage()` returns anything other than `'other'`, or if it's a recognized config file.

### 5.6 Persistent cache

The index is persisted to `~/.capix-code/cache/index.json` as JSON. On startup, `load()` reads this file and hydrates the `Map`-based index. The cache is keyed by `rootPath` — if the saved root doesn't match the current project, the cache is discarded.

### 5.7 File watching

`startWatch()` registers a recursive `fs.watch` on the project root. Changes trigger a debounced `indexChanged()` call (500ms) that:
1. Re-walks the directory.
2. For each existing file, computes a SHA-256 content hash and skips unchanged files.
3. Parses changed/new files and updates the index.
4. Deletes entries for removed files.
5. Rebuilds derived maps (symbols, import graph, reverse import graph).
6. Persists the updated index.
7. Emits an `onIndexUpdated` event (which triggers cross-surface context sync).

### 5.8 API

| Method | Description |
|---|---|
| `indexAll()` | Full parse of the project directory |
| `indexChanged()` | Incremental re-index of changed files only |
| `indexFile(path)` | Index a single file |
| `getIndex()` | Return the current `CodebaseIndex` (or `null` if not indexed) |
| `findReferences(symbolName)` | All symbols + imports matching a name |
| `findDefinition(symbolName)` | The canonical definition node for a symbol name |
| `getDependents(filePath)` | Files that import this file (reverse graph) |
| `getDependencies(filePath)` | Files this file imports (forward graph) |
| `startWatch()` / `stopWatch()` | Manage the recursive fs watcher |
| `onIndexUpdated(handler)` | Register a callback for index updates |
| `getRelativePath(absPath)` | Convert an absolute path to a project-relative path |

---

## 6. Context Retriever

**Source:** `src/codebase-index/retriever.ts`

The `ContextRetriever` selects the most relevant files and symbols for a given request within a token budget. It uses **plain-text pattern matching** — no ML embeddings (those live server-side with pgvector). The retriever extracts query tokens (whole words + camelCase/snake_case sub-parts, minus stop words) and scores files across five phases.

### 6.1 Retrieval pipeline

```
retrieve(request, options?) → RetrievalResult
```

#### Phase 1 — Cheap scoring (path + symbols, no disk reads)

Every indexed file is scored by:
- **Path match** (weight 0.4): `tokenMatchScore` of the relative file path against query tokens. Exact word match = 1.0, substring match = 0.5, reverse inclusion = 0.3.
- **Symbol name match** (weight 0.6): `tokenMatchScore` of each symbol name in the file.
- **Exports match** (weight 0.3): bonus if file exports match query tokens.

Files with score > 0 (or the active file) become candidates. Matched symbol names are collected for phase 5.

#### Phase 2 — Content scoring (read + exact word match)

The top `CANDIDATE_READ_LIMIT` (40) candidates are sorted by phase-1 score, then their content is read from disk. Each candidate gets a content score: fraction of query tokens found as substrings in the lowercased file content. Content score (weight 1.0) is added to phase-1 score.

#### Phase 3 — Import-graph expansion

The top `IMPORT_EXPANSION_SEEDS` (8) files by combined score become seeds. For each seed, the retriever walks both forward and reverse import graph edges. Neighboring files receive a **decayed boost** of `seedScore * IMPORT_EXPANSION_DECAY` (0.3), but only if it exceeds their current score. This brings in files that are structurally related even if they didn't textually match.

#### Phase 4 — Boosts

Two multiplicative boosts are applied:
- **Active file boost** (`ACTIVE_FILE_BOOST = 2.0`): the file open in the editor gets its score doubled.
- **Recent edit boost** (`RECENT_EDIT_BOOST = 1.5`): files modified within `RECENT_EDIT_WINDOW_MS` (1 hour), detected via `lastModified` mtime or explicit `recentEdits` option.

#### Phase 5 — Sort + truncate to token budget

All files with score > 0 are sorted descending. Files are packed into the result until the token budget is exhausted. For files too large to fit, a `bestSlice()` extracts the most relevant ±`SLICE_WINDOW_LINES` (80) line window centered on the best-matching line. Token estimation uses `CHARS_PER_TOKEN = 4`.

### 6.2 Retrieval sources

Each retrieval records its evidence sources for transparency:

| Source type | When present |
|---|---|
| `exact` | Files whose content contained query token text |
| `symbol-graph` | Files defining symbols that matched query tokens |
| `import-graph` | Files reached via forward/reverse import graph expansion |
| `active-file` | The currently open editor file (if it scored > 0) |
| `recent-edit` | (Recorded as a reason, not a source type) Files modified in the last hour |

### 6.3 Token budget

| Constant | Value | Description |
|---|---|---|
| `DEFAULT_MAX_TOKENS` | 4,000 | Default token budget for `retrieve()` |
| `CHARS_PER_TOKEN` | 4 | Token estimation ratio |
| `CANDIDATE_READ_LIMIT` | 40 | Maximum files whose content is read per retrieval |
| `IMPORT_EXPANSION_SEEDS` | 8 | Top-scored seeds for import-graph expansion |
| `IMPORT_EXPANSION_DECAY` | 0.3 | Decay factor for boosted neighbors |
| `ACTIVE_FILE_BOOST` | 2.0 | Active file score multiplier |
| `RECENT_EDIT_BOOST` | 1.5 | Recently edited score multiplier |
| `RECENT_EDIT_WINDOW_MS` | 3,600,000 (1 hour) | Recent edit detection window |
| `SLICE_WINDOW_LINES` | 80 | ± lines around best matching region for large-file slices |

### 6.4 Supplementary methods

| Method | Description |
|---|---|
| `getOrientation()` | Returns a cached 2-paragraph project summary (frameworks, entry points, key modules, notable exports). Cache invalidated on index update. |
| `findRelevantFiles(topic, limit)` | Convenience wrapper around `retrieve()` returning `{path, score, reason}[]` |
| `answerQuestion(question)` | Retrieves context at 6,000-token budget and returns a text answer + evidence snippets (file:line) |
| `buildOrientation(index)` | Internal: detects frameworks from `package.json` deps, lists top-level modules, identifies entry points, collects notable exports |

### 6.5 Chat integration

The `chat.params` hook (`src/plugin.ts:854`) retrieves codebase context on every turn:
- If the user message has body text, `retrieve()` is called at a 2,000-token budget.
- Results are injected as `capixCodebaseContext` on `chatOutput.options` — either as `{ type: 'retrieval', files, symbols, sources, totalTokens }` or a fallback `{ type: 'orientation', summary }`.
- All failures are **non-blocking**: if the index isn't ready or retrieval fails, the hook logs and continues with no injection.

---

## 7. Planner

**Source:** `src/planner/planner.ts`

The `Planner` decomposes a natural-language request into a structured, checkpointable plan using a **fixed text protocol** (not free-form chat). It stays decoupled from transport details via an injected `ModelInvoker`.

### 7.1 Plan structure

```typescript
interface Plan {
  id: string;                    // UUID
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  steps: PlanStep[];
  securityImplications: string[];
  billingImplications: string[];
  rollbackStrategy: string;
  definitionOfDone: string[];
  status: 'drafting' | 'awaiting-approval' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;             // ISO 8601
  updatedAt: string;
}

interface PlanStep {
  id: string;                    // step number ("1", "2", ...)
  description: string;
  filesToRead: string[];
  filesToEdit: string[];
  filesToCreate: string[];
  testsToRun: string[];
  estimatedTurns: number;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  dependsOn?: string[];          // step IDs this depends on
}
```

### 7.2 Planning pipeline

`plan(request)` executes:

1. **Get project orientation** — calls `contextRetriever.getOrientation()`.
2. **Find relevant files** — calls `contextRetriever.findRelevantFiles(request, 20)` to identify the 20 most relevant file paths.
3. **Build the prompt** — assembles a system prompt with the fixed text protocol + project orientation + relevant file list + the user request.
4. **Invoke the model** — calls `modelInvoker(prompt)`, which streams through the Capix provider's `stream()` generator (default model: `capix/auto` or `CAPIX_PLANNER_MODEL` env var).
5. **Parse the response** — `parsePlanResponse()` extracts structured fields from the model's text-protocol output.

### 7.3 Fixed text protocol

The model is instructed to emit a strict text protocol (case-insensitive parsing):

```
GOAL: <one-line goal>
NON_GOALS: <comma-separated>
ASSUMPTIONS: <comma-separated>
SECURITY: <security implications, or "none">
BILLING: <billing / infrastructure cost implications, or "none">
ROLLBACK: <how to roll back this change>
DOD: <comma-separated definition-of-done items>

STEP 1: <step description>
  READ: <comma-separated existing files to read first, or "none">
  CREATE: <comma-separated new files, or "none">
  EDIT: <comma-separated files to modify, or "none">
  DEPENDS_ON: <comma-separated step numbers this depends on, or "none">
  TEST: <comma-separated test commands to run after, or "none">
  TURNS: <integer estimated LLM turns>

STEP 2: ...
```

The parser is robust to whitespace/casing variations and ignores unknown lines. Lists parse `none` as empty.

### 7.4 Execute loop

```typescript
async execute(subagentManager, context, options?) → { completed, failed, results }
```

Executes the current plan step by step:
1. Iterates over steps (skipping `completed`/`skipped`).
2. Sets each step to `in-progress`.
3. Builds a `SubagentConfig` with defaults: `maxTurns: 8`, `maxElapsedMs: 120,000`, `maxSpendUsdMinor: 500n`, `model: 'capix/auto'`, `allowedTools: ['read_file', 'edit_file', 'bash']`, `approvalRules: 'auto'`.
4. Spawns a subagent via `subagentManager.spawn(config)`.
5. On success → step `completed`; on failure/exception → step `failed`.
6. Recomputes plan status: all completed/skipped → `completed`; any in-progress → `executing`; any failed → `failed`.

### 7.5 Checkpoint

```typescript
async checkpoint() → string  // checkpoint ID
```

Creates a verification checkpoint by:
1. **Gathering git repo state** — `git rev-parse HEAD`, `git branch --show-current`, `git status --porcelain`, `git diff HEAD --stat`.
2. **Running verification** — reads `package.json` scripts and runs:
   - `npm run typecheck` (pass/fail/skipped)
   - `npm run lint` (pass/fail/skipped)
   - `npm run test` (pass/fail/skipped with parsed pass/fail/skip counts)
3. **Calling `intelligence.createCheckpoint()`** with the plan ID, repo state, verification results, and a receipt summary.

Verification commands have a 120-second timeout. A `SIGTERM` result is treated as `skipped`.

---

## 8. Subagents

**Source:** `src/planner/subagent.ts`

The `SubagentManager` spawns child agents in isolated git worktrees, each bounded by a hard turn/time/spend ceiling. The manager enforces isolation, tracks real file changes, records work receipts, and can cancel running subagents.

### 8.1 Subagent configuration

```typescript
interface SubagentConfig {
  role: string;                          // e.g. 'implementation-agent'
  planStep: PlanStep;                    // the step to execute
  model: string;                         // e.g. 'capix/auto'
  maxTurns: number;                      // hard turn limit (default 8)
  maxElapsedMs: number;                  // hard time limit in ms (default 120,000)
  maxSpendUsdMinor: bigint;              // hard spend ceiling in USD minor units (default 500)
  worktreePath: string;                  // git worktree directory
  parentSessionId: string;               // parent session for approval routing
  allowedTools: string[];               // e.g. ['read_file', 'edit_file', 'bash']
  filesystemScope: string;              // workspace root for filesystem access
  approvalRules: 'auto' | 'ask-parent' | 'ask-user';
}
```

### 8.2 Git worktrees

Each subagent operates in its own `git worktree` so filesystem changes are isolated from the parent session.

`createWorktree(branchName)`:
1. Creates `.capix/worktrees/` directory if it doesn't exist.
2. Sanitizes the branch name (non-alphanumeric chars → `-`).
3. Runs `git worktree add -b <branch> <path> HEAD`.
4. If the worktree/branch already exists, reuses the existing path.

### 8.3 Engine command resolver

An optional `EngineCommandResolver` maps a subagent config to the engine command to launch:

```typescript
type EngineCommandResolver = (config: SubagentConfig) => { command: string; args: string[] } | null;
```

When a resolver returns a command (e.g., `capix-engine --non-interactive --prompt "..." --max-turns 8`), the subagent runs that engine in the worktree. When it returns `null`, the manager falls back to running the step's `testsToRun` commands through bash as a verification pass.

The plugin wires a resolver (`src/plugin.ts:518`) that:
- Returns `null` if the engine binary doesn't exist at the expected path.
- Otherwise builds a prompt from the step description, file lists, and test commands.

### 8.4 Spawn lifecycle

`spawn(config)`:
1. Creates the worktree if it doesn't exist.
2. Generates a UUID subagent ID.
3. Resolves the engine command (or falls back to test commands).
4. Spawns a child process in the worktree with `CAPIX_*` env vars: `CAPIX_SUBAGENT_ID`, `CAPIX_PARENT_SESSION`, `CAPIX_CODE_MODEL`, `CAPIX_MAX_TURNS`, `CAPIX_MAX_ELAPSED_MS`, `CAPIX_MAX_SPEND_USD_MINOR`, `CAPIX_ALLOWED_TOOLS`, `CAPIX_FILESYSTEM_SCOPE`, `CAPIX_APPROVAL_RULES`.
5. Captures `stdout` and `stderr`.
6. Enforces the elapsed-time limit via a `setTimeout` → `SIGTERM`.
7. Awaits process exit.
8. Computes `filesChanged` via `git status --porcelain` in the worktree (parsed from the status output, stripping the XY status prefix).
9. Counts turns by scanning stdout for `capix:turn` markers.
10. Determines status: `timeout` if cancel-requested, `completed` if exit code 0, else `failed`.
11. Builds a summary from the objective, status, exit code, and last 400 chars of stdout+stderr.
12. Records a best-effort work receipt via `intelligence.createWorkReceipt()` (non-blocking on auth failure).

### 8.5 Work receipts

Each subagent spawns produces a `SubagentResult`:

```typescript
interface SubagentResult {
  subagentId: string;
  stepId: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  filesChanged: string[];      // real git diff, not self-reported
  summary: string;
  workReceiptId?: string;      // from intelligence API
  costMinor: bigint;           // 0n unless engine resolver emits a receipt line
  durationMs: number;
  turns: number;
}
```

**Spend tracking is honest:** the actual model cost of a child process is not observable from the `SubagentManager`, so `costMinor` is reported as `0n` unless an engine resolver emits a receipt line. The `maxSpendUsdMinor` ceiling still bounds wall-clock spend via the elapsed-time limit.

### 8.6 Cancellation and cleanup

| Method | Description |
|---|---|
| `cancel(subagentId)` | Sets `cancelRequested`, sends `SIGTERM` to the child |
| `getActive()` | Lists configs of currently running subagents |
| `cleanupWorktree(worktreePath)` | Runs `git worktree remove --force` |

---

## 9. Skills

**Sources:** `src/skills/runtime.ts`, `src/skills/builtin.ts`

The `SkillsRuntime` manages a local registry of versioned, integrity-hashed skill bundles. Each skill is a system prompt plus optional tool additions and required permissions. The runtime installs, enables/disables, pins, auto-selects, and invokes skills.

### 9.1 Skill definition

```typescript
interface LocalSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  trigger: string;          // regex tested case-insensitive against the task string
  systemPrompt: string;
  tools?: string[];
  permissions: string[];    // e.g. ['read'], ['read', 'write', 'bash']
  enabled: boolean;
  pinned: boolean;
  installedAt: string;      // ISO 8601, stamped on install
  signature?: string;       // sha256 of definition (minus signature/installedAt), first 32 hex chars
}
```

### 9.2 The 6 built-in skills

All built-in skills are installed at plugin startup via `BUILTIN_SKILLS`:

| Skill ID | Name | Trigger regex | Permissions | Purpose |
|---|---|---|---|---|
| `capix-orientation` | Project Orientation | `understand\|orient\|analyze.*project\|architecture` | `read` | Read entry points, list key modules, identify framework, produce a 2-paragraph orientation summary |
| `capix-tdd` | Test-Driven Development | `test\|spec\|tdd\|test.driven` | `read, write, bash` | Write failing test → minimal code to pass → refactor; always run tests before and after |
| `capix-refactor` | Safe Refactoring | `refactor\|clean.*up\|simplify\|extract.*method` | `read, write, bash` | Establish baseline tests → one change at a time → run tests after each → revert on failure |
| `capix-debug` | Systematic Debugging | `bug\|debug\|error\|fail\|broken\|wrong` | `read, write, bash` | Read error precisely → find failing line → understand why → propose fix → verify no regressions |
| `capix-review` | Code Review | `review\|check.*code\|audit` | `read` | Check correctness, security, performance, readability; suggest specific improvements with code |
| `capix-deploy` | Safe Deployment | `deploy\|ship\|release\|publish` | `read, write, bash` | Run tests → typecheck → lint → fix failures → create quote → get approval → deploy → verify → cleanup |

### 9.3 Auto-selection

`autoSelect(task)` (`src/skills/runtime.ts:124`):
1. Iterates over enabled skills (insertion order).
2. Compiles each skill's `trigger` as a case-insensitive `RegExp`.
3. Returns the **first** skill whose trigger regex matches the task string, with the matched substring as the reason.
4. Returns `null` if no skill matches.

### 9.4 Integrity and versioning

- **Signature:** `sha256(JSON.stringify(definition))` (with `signature` and `installedAt` removed), truncated to 32 hex chars. Computed on install.
- **Pin:** `pin(skillId, version)` locks a skill to a specific version, sets `pinned = true`, and recomputes the signature.
- **Validation:** `install()` validates required fields (`id`, `name`, `description`, `version`, `trigger`, `systemPrompt`, `permissions`) are present and non-empty.

### 9.5 Chat integration

The `chat.params` hook (`src/plugin.ts:919`) auto-selects a skill on every turn:
1. Uses the `latestTask` captured by the `chat.message` hook.
2. Calls `skillsRt.autoSelect(task)`.
3. If a skill matches, injects `{ id, systemPrompt, reason }` as `capixSkill` on `chatOutput.options`.
4. Non-blocking — if no skill matches, nothing is injected.

---

## 10. Provider

**Source:** `src/capix-provider.ts`

The Capix provider is the real implementation against the native engine contract. It deliberately does **not** use a generic compatibility shim, because that layer would lose tool-call streaming, cancellation, typed errors, and receipt/usage metadata.

### 10.1 Architecture

The provider communicates **only** with the local `CredentialBroker` — it never holds a refresh/device token and never calls the Capix edge directly with a stored bearer. The broker hands a one-shot short-lived access token that the provider uses for a single request.

### 10.2 Streaming

```typescript
async function* stream(input: CapixStreamInput, options: CapixStreamOptions): AsyncGenerator<CapixProviderChunk>
```

Streams a chat completion from the Capix inference gateway via the local broker. Yields typed chunks until finish or error.

**URL:** `POST <inferenceBase>/inference/chat/completions` with `Accept: text/event-stream`.

**Authentication:** `Authorization: Bearer <access-token>` from the broker, plus client/release metadata headers (`X-Capix-Client`, `X-Capix-Client-Version`, `X-Capix-Release-Id`, `X-Capix-Plugin-Version`, `X-Capix-Acp-Version`, `X-Capix-Request-Id`, `X-Capix-Source`).

**AbortSignal:** Honored at every SSE boundary (checked before each `reader.read()`).

### 10.3 SSE event types (6)

The server streams Server-Sent Events. Each `data:` line is parsed as JSON and mapped to a typed `CapixProviderChunk`. The 6 inbound event types and their outbound mappings:

| Inbound SSE event type | Outbound chunk type | Fields |
|---|---|---|
| `capix.route` | `route` | `receiptId`, `model` (modelCapability), `region`, `privacyClass` |
| `content.delta` | `text` | `delta` (content string) |
| `tool.delta` | `tool` | `toolCallId`, `index`, `function` (`{ name?, arguments? }`) |
| `capix.usage` | `usage` | `input`, `output`, `cacheRead?`, `cost?` (`{ amount, asset, scale }`) |
| `capix.final` | `finish` | `finishReason`, `receiptId`, `retryCount?` |
| `capix.error` | `error` | `capixCode`, `message`, `supportId?`, `retryClass?`, `retryAfterMs?` |

The stream terminates on `finish` or `error` chunks, or on the `[DONE]` sentinel.

Payloads whose kind is carried only by the SSE `event:` line (OpenAI-style payloads have no `type` member) adopt the `event:` value. Usage is read tolerantly: the canonical flat fields (`inputUnits`/`outputUnits`/`cacheUnits`) and the gateway's `inputTokens`/`outputTokens` variant (optionally nested under `usage`) both map onto the `usage` chunk. When no `capix.usage` event arrives, the authoritative `capix.final.finalUsage` totals are emitted instead — never both, so accumulators never double-count.

### 10.4 Error handling and 401 refresh

`classifyHttpError(res)` maps non-2xx responses:

| HTTP status | capixCode source | Retry class | Behavior |
|---|---|---|---|
| **401** | `HTTP_401` or body `capixCode` | `retry` | Refresh-once: calls `broker.refreshToken()`, gets a fresh access token, retries the request. Only refreshes **once**. |
| **402** | HTTP_402 | `none` | Funds — surface top-up UI; not retryable in-band |
| **409** | HTTP_409 | `none` | Duplicate / in-flight — do not retry |
| **429** | HTTP_429 | `retry-after` | Retry after `Retry-After` header (parsed to ms), falling back to the body's `retryAfterSeconds` |
| **500+** | HTTP_5xx | body `retryClass` or `retry` | Server error — the server's own `retryClass`/`retryAfterSeconds` win when present; otherwise retryable |
| Other | HTTP_`status` | body `retryClass` or `none` | Not retryable unless the server says so |

`supportId` falls back to the problem-detail `traceId` when no explicit `supportId` is sent — `traceId` is the support handle on every error.

The stream tracks `firstOutputSeen` — text/tool/reasoning deltas set this flag. Fallback (retry on 5xx) happens **only before** first customer-visible output.

### 10.5 Model catalog

`models()` fetches the live catalog from `GET <apiBase>/models` and converts each entry into the engine `Model` shape, including:
- Capabilities: tool-call, reasoning, attachment (vision), modalities (text/audio/image/video/pdf for input and output)
- Cost: input/output/cache-read/cache-write per million tokens
- Limits: context window, max output
- Status: `alpha` | `beta` | `active` | `deprecated`

`capix/auto` is always advertised as an additional model entry with server-authoritative routing (the client keeps no model placement memory).

### 10.6 AI SDK adapter

**Source:** `src/ai-sdk-provider.ts`

`CapixLanguageModel` implements `LanguageModelV3` from `@ai-sdk/provider` (the spec the ai v6 engine consumes natively), adapting the Capix SSE stream into AI SDK stream parts:
- `capix.route` → `response-metadata` (with receiptId and modelId)
- `text` → `text-start` / `text-delta` / `text-end`
- `tool` → `tool-input-start` / `tool-input-delta` / `tool-input-end` / `tool-call`
- `usage` → finish `usage` (nested v3 shape: inputTokens.total/cacheRead, outputTokens.total) plus the receipt's provisional cost as `providerMetadata.capix.costUsd`
- `finish` → finish with `{ unified, raw }` `finishReason`, `usage`, `providerMetadata.capix.receiptId`
- `error` → re-thrown as `CapixHttpError` so supportId/traceId and capixCode survive into the session.error payload

`createCapix(options?)` returns a provider factory that creates `CapixLanguageModel` instances on demand.

### 10.7 Auth hook

`capixAuthLoader` (`src/capix-provider.ts:594`) bridges the engine auth hook to the credential broker:
- OAuth type → `Authorization: Bearer <access>`, `X-Capix-Account: <accountId>`
- API key type → `Authorization: Bearer <key>`

### 10.8 Server-authoritative routing

There is **deliberately no** client-side router, prompt classifier, provider scorer, or persisted router memory. When the active model is `capix/auto`:
1. The plugin reuses the same provider hook and catalog — no client-side interception.
2. The Capix gateway resolves `auto` to a concrete stable model id per request, returned in the `capix.route` SSE event.
3. The client forwards the request and renders the routed model from the server response.

---

## 11. Credential Broker

**Source:** `src/broker.ts`

The `CredentialBroker` is the privileged local identity boundary. It keeps refresh tokens out of the agent engine, plugins, shell tools, args, config, environment, logs, and crash bundles. This is the TypeScript reference implementation; the canonical native broker ships in the Rust launcher.

### 11.1 Security obligations

- The provider receives **only** short-lived, audience/project-scoped access tokens — it never sees the refresh token.
- Refresh tokens are stored in OS secure storage (macOS Keychain, Windows Credential Manager, Linux Secret Service) via the `keyring` crate.
- If secure storage is unavailable, the broker degrades to **session-only** in-memory mode with a strong warning. It **never** falls back to plaintext on disk.
- Broker capabilities are closed before any tool process starts (see [§12 Sandbox](#12-sandbox)).

### 11.2 OAuth PKCE S256 flow

`login()` (`src/broker.ts:197`):
1. **Generate PKCE pair:** verifier = 64 random bytes → base64url; challenge = SHA-256(verifier) → base64url.
2. **Generate state:** 24 random bytes → base64url.
3. **Bind ephemeral loopback port:** create a TCP server on `127.0.0.1:0`, obtain the assigned port, set `redirectUri = http://127.0.0.1:<port>/callback`.
4. **Build authorize URL:** `https://www.capix.network/oauth/authorize` with `response_type=code`, `client_id=capix-code`, `code_challenge=<challenge>`, `code_challenge_method=S256`, `state=<state>`, `redirect_uri=<redirectUri>`.
5. **Open browser** and wait for the callback.

`exchangeCode()` (`src/broker.ts:252`):
1. Awaits the authorization code from the native OAuth callback bridge (`globalThis.capixOAuth.awaitCallback()`).
2. Validates the OAuth state matches.
3. Exchanges the code at `https://www.capix.network/oauth/token` with `grant_type=authorization_code`, `code`, `code_verifier`, `client_id=capix-code`, `redirect_uri`.
4. Stores the refresh token in secure storage.
5. Caches the access token with its expiry.
6. Returns `{ type: 'success', provider, refresh, access, expires, accountId }`.

### 11.3 Refresh-token rotation

`refreshToken()` (`src/broker.ts:145`):
1. Loads the current refresh token.
2. **Reuse detection:** if the same refresh token is presented twice in a row after a successful rotation, this is a reuse signal — `TokenReuseError` is thrown and the device is revoked immediately (`revokeDevice()`).
3. POSTs to `https://www.capix.network/oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id=capix-code`.
4. **Rotation:** the server issues a new refresh token. The broker stores the new one and remembers the one it just used (`lastRefreshSeen`) so a replay is detectable.
5. Caches the new access token with its expiry.
6. On 401 from the token endpoint, clears the refresh token (caller must re-login).

### 11.4 Access token vending

`getAccessToken(opts?)` (`src/broker.ts:121`):
1. If the cached access token has > 60 seconds remaining, return it.
2. Otherwise, call `refreshToken()` to rotate and obtain a fresh one.
3. The real native broker mints audience/project-scoped tokens here.

### 11.5 API key registration

`registerApiKey(key)` (`src/broker.ts:307`):
1. Hashes the key with SHA-256 (never stores the raw key in memory longer than needed).
2. Verifies with the server at `POST /api/v1/auth/api-key/verify` with the key digest.
3. API keys are session-only (15-minute expiry) — no refresh token is minted.
4. Returns `{ type: 'success', key: 'cpk_<digest[0:12]>', provider: 'capix', metadata: { project_id } }`.

### 11.6 Logout and device revocation

| Method | Description |
|---|---|
| `logout()` | Revokes the refresh token at `/oauth/revoke`, then clears all local credentials |
| `revokeDevice()` | Revokes the entire device session at `/api/v1/auth/device/revoke`, clears all tokens and session data |

### 11.7 Secure storage

The broker probes for OS secure storage via `globalThis.capixSecureStore` (injected by the Rust launcher's native bridge). If unavailable, `sessionOnly = true` and a warning is logged.

| Storage backend | Mechanism |
|---|---|
| **macOS** | Keychain (via `keyring` crate, `apple-native` feature) |
| **Windows** | Credential Manager (`windows-native` feature) |
| **Linux** | Secret Service / libsecret (`linux-native-sync-persistent` feature) |
| **In-process fallback** | `~/.capix-code/credentials.json` with mode `0600` (written by `native-bridge.ts` and synced by the Rust launcher) |

### 11.8 Native bridge

**Source:** `src/native-bridge.ts`

The native bridge preload module runs before the Capix plugin and sets up the global bridges:

1. **`globalThis.capixSecureStore`** — a file-based credential store reading/writing `~/.capix-code/credentials.json` with mode `0600`. Complements the OS keyring used by the Rust launcher.
2. **`globalThis.capixOAuth`** — a loopback HTTP callback bridge that opens the system browser and waits for the OAuth redirect on port `18765` (5-minute timeout).

Credentials file is created with `0600` permissions, only stores the refresh token (access tokens are ephemeral), and the OAuth callback binds to `127.0.0.1` only. No credentials are logged.

---

## 12. Sandbox

**Source:** `src/sandbox.ts`

The `WorkspaceSandbox` enforces explicit security profiles that gate file access, command execution, environment inheritance, process limits, and capability closure. Approval prompts alone are not a sandbox.

### 12.1 Profiles

| Profile | Description | Default CPU | RAM | PIDs | Disk | Wall time | Output |
|---|---|---|---|---|---|---|---|
| `restricted` | Default. Denies network, rejects dangerous executables, blocks all secret paths. | 50% | 1,024 MB | 64 | 512 MB | 5 min | 1 MB |
| `developer` | Broader file grants per action, still blocks secret paths. Allows network. | 80% | 4,096 MB | 256 | 2,048 MB | 30 min | 8 MB |
| `host` | Full machine access, session-only. Emits a strong warning on activation. | 100% | 16,384 MB | 1,024 | 8,192 MB | 60 min | 32 MB |

### 12.2 Path traversal protection

`canonicalizePath(input)`:
1. Resolves the input against the workspace root.
2. Checks the relative path doesn't start with `..` or contain `..${sep}`.
3. Throws `path traversal blocked` on violation.

`resolveRealPath(path)`:
1. Calls `realpathSync()` to resolve symlinks.
2. If the exact path doesn't exist, progressively resolves the deepest existing ancestor and appends the remainder — so symlinks in parent directories (including OS-level symlinks like `/tmp` → `/private/tmp` on macOS) are detected.

`isPathAllowed(path)`:
- `host` profile → always `true`.
- `restricted`/`developer` → canonicalizes the path, checks both lexical and real (symlink-free) relative paths stay under the workspace root.
- `developer` allows files outside the workspace (as long as they aren't secret paths).
- Secret paths are blocked in all profiles except `host`.

### 12.3 Secret path detection

`isSecretPath(path)` checks against `SECRET_FRAGMENTS` — a list of path fragments that are blocked unless explicitly granted:

`.env` (including `.env.local`, `.env.production`, `.envrc`), `.ssh`, `.aws`, `.azure`, `.gcloud`, `.docker`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.capix`, `.kube`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `id.json`, `credentials.json`, `service_account`, `wallet`, `keystore`, `keyring`, `secret-key`, `KnownHosts`

Matching is case-insensitive, platform-neutral (backslashes normalized to forward slashes), and checks both the full path and the basename.

### 12.4 Command approval

`shouldApproveCommand(args)`:
1. **Fail closed** if capabilities have been closed (`_closed = true`).
2. `host` profile → always approve.
3. `restricted` profile → deny network-bearing subprocesses.
4. Deny if env delta injects secret-looking material.
5. Deny if `cwd` escapes the workspace root.
6. Deny if any argument references a protected secret path.
7. `restricted` profile → reject dangerous executables: `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`, `docker`, `kubectl`.

### 12.5 Environment scrubbing

`scrubEnvironment(env)` removes secret-looking keys before a tool process inherits the environment.

**Safe keys (always kept):** `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `PWD`

**Scrubbed by prefix:** Capix, public-cloud, model-provider, SSH, wallet,
chain, private-key, secret, and compute-provider credential prefixes.

**Scrubbed by exact match:** `TOKEN`, `API_KEY`, `APIKEY`, `REFRESH_TOKEN`, `ACCESS_TOKEN`, `PASSPHRASE`, `PASSWORD`, `PRIVATE_KEY`, `BEARER`, `AUTHORIZATION`

The Rust launcher also scrubs: `CAPIX_ACCESS_TOKEN`, `CAPIX_REFRESH_TOKEN`, `CAPIX_OPERATOR_TOKEN`, `CAPIX_TREASURY_SECRET_KEY`.

### 12.6 Capability closure

| Method | Description |
|---|---|
| `closeToolCapabilities()` | Closes handles inherited by the next tool while keeping policy evaluation live. Delegates to `globalThis.capixSandbox.closeToolCapabilities()` when available. |
| `closeCapabilities()` | Closes all inherited broker capabilities and marks `_closed = true`. All subsequent approvals **fail closed** to prevent approval-after-disconnect bypass. |

The `tool.execute.before` hook (`src/plugin.ts:789`) calls `sandbox.closeToolCapabilities()` immediately before a tool process launches. This ensures the broker's inherited descriptors are closed before the tool can access them.

### 12.7 Degraded mode

If the OS native isolation layer is absent (Landlock/seccomp on Linux, AppContainer on Windows, restricted token), `degraded = true` is reported honestly. The sandbox still enforces its checks in-process, but the OS-level sandbox cannot be guaranteed.

---

## 13. Configuration

### 13.1 Config locations

| Location | Purpose |
|---|---|
| `config/defaults.json` | Bundled Capix config (provider, models, permissions, MCP, commands) |
| `config/capix-defaults.json` | Capix-specific defaults (API URLs, sandbox profile, theme, settlement) |
| `~/.config/capix-code/capix-code.json` | User-level overrides |
| `capix-code.json` (project-level) | Project-level overrides |

### 13.2 Provider config (`config/defaults.json`)

| Setting | Value |
|---|---|
| Provider ID | `capix` (via `@capix/runtime-provider`) |
| Base URL | `CAPIX_BASE_URL` env var (defaults to `https://capix.network/api/v1`) |
| API Key | `CAPIX_API_KEY` env var |
| Default Model | `CAPIX_MODEL` env var (defaults to `capix/auto`) |
| Small Model | `capix/supergemma-gemma3-4b` |
| Permission Mode | `edit: ask`, `bash: ask` (safe defaults) |
| Autoupdate | Disabled (IDE manages updates) |
| Share | `manual` |
| Plugin | `./src/plugin.ts` |
| MCP | Capix MCP server auto-registered (`npx -y @capix/mcp server --stdio`) |

### 13.3 The 8 models

| Model key | Display name | Context | Max output |
|---|---|---|---|
| `auto` | Capix Auto (smart route — picks the best model) | 128,000 | 64,000 |
| `supergemma-gemma3-27b` | SuperGemma · Gemma 3 27B | 131,072 | 32,768 |
| `supergemma-gemma3-12b` | SuperGemma · Gemma 3 12B | 131,072 | 16,384 |
| `supergemma-gemma3-4b` | SuperGemma · Gemma 3 4B | 131,072 | 8,192 |
| `supergemma-codegemma-7b` | SuperGemma · CodeGemma 7B | 8,192 | 8,192 |
| `qwen2.5-coder-7b` | Qwen2.5-Coder 7B | 131,072 | 16,384 |
| `qwen2.5-coder-32b` | Qwen2.5-Coder 32B (AWQ) | 131,072 | 32,768 |
| `llama-3.3-70b-fp8` | Llama 3.3 70B (FP8) | 131,072 | 32,768 |

The launcher (`launcher/src/main.rs:315`) fetches the live catalog at runtime and merges available models into the provider entry, so the model list reflects current network capacity.

### 13.4 Capix defaults (`config/capix-defaults.json`)

```json
{
  "provider": "capix",
  "model": "capix/auto",
  "apiBaseUrl": "https://www.capix.network/api/v1",
  "inferenceBaseUrl": "https://www.capix.network/api/v1",
  "sandbox": "restricted",
  "telemetry": false,
  "contentLogging": false
}
```

### 13.5 Theme

```json
{
  "background": "#0a0e14",
  "foreground": "#f1efe9",
  "accent": "#3DCED6",
  "success": "#14F195",
  "error": "#ff5252",
  "warning": "#FFAE00",
  "muted": "#64748b",
  "border": "#ffffff0f",
  "surface": "#070b10"
}
```

### 13.6 Slash commands

The config registers 36 slash commands, each backed by a markdown template in `commands/`. Notable commands include: `/plan`, `/delegate`, `/skills`, `/covenant`, `/memory`, `/remember`, `/forget`, `/graph`, `/decisions`, `/checkpoint`, `/review`, `/verify-checks`, `/handoff`, `/context`, `/compact`, `/deploy`, `/cleanup`, `/receipts`, `/network`, `/endpoints`, `/ssh`, `/forward`, `/logs`, `/metrics`, `/stop`, `/secure`, `/attest`, `/verify-proof`, `/proofs`, `/confidential-models`, `/website`, `/preview`, `/promote`, `/rollback`, `/domains`, `/analytics`, `/open`, `/doctor`, `/update`, `/welcome`.

### 13.7 MCP zero-config registration

The `config` hook (`src/plugin.ts:717`) programmatically injects the Capix MCP server into the runtime config without writing to the user's config file. The broker's access token is injected as `CAPIX_API_KEY` in the MCP server's environment (never persisted to the config file). If the broker isn't logged in yet, the env stays empty and is rehydrated on the next session.

---

## 14. Architecture

### 14.1 Binary layout

```
capix-code (install root)
├── bin/
│   └── capix-code                    ← Rust native launcher (the entry point)
├── engine/
│   └── capix-engine                  ← bundled Bun-based agent engine
├── config/
│   ├── defaults.json                 ← Capix provider config
│   └── capix-defaults.json           ← Capix-specific defaults
├── runtime/
│   ├── src/
│   │   ├── plugin.ts                 ← Capix plugin entry point
│   │   ├── native-bridge.ts           ← globalThis.capixSecureStore + capixOAuth
│   │   ├── capix-provider.ts          ← SSE streaming + model catalog
│   │   ├── broker.ts                  ← CredentialBroker (OAuth PKCE, rotation)
│   │   ├── sandbox.ts                 ← WorkspaceSandbox (profiles, scrubbing)
│   │   ├── ai-sdk-provider.ts         ← AI SDK LanguageModelV3 adapter
│   │   ├── url-builder.ts             ← URL contract utilities
│   │   ├── intelligence-client.ts     ← Intelligence API client
│   │   ├── logger.ts                  ← Structured JSON logger
│   │   ├── codebase-index/
│   │   │   ├── indexer.ts             ← TS AST + Python/Rust regex indexer
│   │   │   └── retriever.ts           ← 5-phase context retrieval
│   │   ├── planner/
│   │   │   ├── planner.ts             ← Model-driven decomposition
│   │   │   ├── subagent.ts            ← Git worktree bounded execution
│   │   │   └── compaction.ts          ← Loss-aware session summarization
│   │   └── skills/
│   │       ├── runtime.ts             ← Skill install/enable/invoke/auto-select
│   │       └── builtin.ts             ← 6 built-in skills
│   └── node_modules/
│       └── @capix/runtime-provider/   ← Provider runtime adapter
└── runtime-package.json
```

### 14.2 Engine vs. launcher

The **Rust launcher** (`launcher/src/main.rs`) is the signed native binary that:
- Manages the OS keyring (via the `keyring` crate with `apple-native`, `windows-native`, `linux-native-sync-persistent` features)
- Runs the OAuth PKCE S256 flow (browser open, loopback callback, token exchange)
- Performs refresh-token rotation in the keyring
- Scrubs all secret-looking env vars from the process environment before spawning the engine
- Fetches the live model catalog and billing status
- Builds a config with live models merged into the provider entry
- Launches the Bun engine as a child process with the Capix config injected via env vars

The **Bun engine** is the coding agent that:
- Runs the TUI, chat loop, tool execution, and session management
- Loads the Capix plugin (via `CAPIX_CODE_CONFIG_CONTENT` which embeds the plugin path)
- Talks to the `CredentialBroker` (in-process) for access tokens
- Streams inference through the Capix provider's SSE `stream()` generator
- Runs the codebase indexer, planner, subagents, skills, and sandbox

### 14.3 Build pipeline

```
scripts/bootstrap.sh        → Hydrates pinned agent-engine source
scripts/rebrand.sh          → Applies Capix product identity and runtime defaults
scripts/install-config.sh   → Bundles Capix provider config, TUI theme, and brand assets into the upstream tree
scripts/build.sh            → bun install + upstream build script → standalone binary
scripts/package-customer.sh  → Stages dist/customer/ with engine + runtime + config
```

| Product identity | Customer value |
|---|---|
| Binary | `capix-code` |
| Config directory | `.config/capix-code` |
| Environment prefix | `CAPIX_CODE_` |
| Config filename | `capix-code.json` |
| Repository | `CapIX-Protocol/CapIX-Code` |
| Display name | `Capix Code` |

### 14.4 Data flow summary

```
User (TUI)
  │
  ▼
Rust Launcher (keyring, OAuth, env scrub, catalog fetch)
  │
  ▼ spawns with CAPIX_CODE_CONFIG_CONTENT
Bun Engine (chat loop, tool dispatch)
  │
  ▼ loads plugin: [native-bridge.ts, plugin.ts]
Capix Plugin (Hooks)
  ├── provider hook      → capix-provider.ts → broker.getAccessToken() → SSE stream
  ├── config hook        → injects Capix MCP server into config
  ├── auth hook          → broker.login() / broker.registerApiKey()
  ├── tool hook           → 5 capix_* tools (search, references, orientation, plan, delegate)
  ├── tool.execute.before → sandbox.shouldApproveCommand() + sandbox.closeToolCapabilities()
  ├── chat.params         → intelligence context + codebase context + skill auto-select + compaction
  ├── chat.message        → transcript capture
  ├── shell.env           → sandbox.scrubEnvironment()
  ├── permission.ask      → sandbox profile enforcement
  └── dispose             → stop watcher, null singletons
```

### 14.5 Cross-surface brain sync

The plugin pushes local codebase intelligence to the server so the web chat and other surfaces can answer "what is the user working on?":

1. After indexing (and on every re-index from a file change), `pushProjectContext()` is called (debounced 1,500ms).
2. It gathers: project orientation, codebase summary (total files, languages, key modules, entry points, framework), and active files (most recently modified, up to 15).
3. Calls `intelligence.syncProjectContext()` with the structured payload.

### 14.6 Intelligence context injection

The `chat.params` hook fetches intelligence context on every turn (non-blocking, 4-second timeout per sub-call):
- **Active plan** — the most recent active plan (goal + definition of done)
- **Recent decisions** — up to 5 active decision memory nodes
- **Active covenant rules** — invariants and effects from the Project Covenant
- **Codebase context** — retrieved files + symbols (2,000-token budget) or a fallback orientation
- **Selected skill** — auto-selected skill system-prompt fragment
- **Compaction** — when transcript exceeds 6,000 tokens, a structured summary replaces the rolling transcript

All failures are non-blocking: if any sub-call fails, that section is omitted and a `warnings` entry records the failure.

---

*Copyright 2026 Capix. Licensed under the Apache License, Version 2.0.*
