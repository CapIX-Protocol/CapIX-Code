# Capix Code

Capix Code is an AI coding agent with the Capix provider pre-configured as the default, adding a Smart Router plugin, brand theming, and Capix network integration. Bundled inside Capix IDE, or installable standalone.

## About

Capix Code is a complete AI coding agent built on TypeScript/Bun (~640 lines of original TypeScript for the Smart Router plugin, plus configuration, theming, and build scripts). It ships with:

- **Capix branding** — the TUI shows the Capix ASCII art banner on launch with brand colors (neon teal `#3DCED6`, green `#14F195`), the Capix brand mark logo, and a full TUI color theme using the brand palette (deep slate-navy canvas, teal accents, green success states)
- **Built-in Capix provider** — the native Capix runtime provider is the default and routes authenticated requests through the canonical Capix inference gateway. No manual API configuration is needed.
- **Smart Route (auto mode)** — when using `capix/auto` (the default), a mini-AI classifier analyzes each request and routes it to the best model for the task: a strong reasoning model (Llama 3.3 70B, Gemma 3 27B) for planning/analysis, and a strong coding model (Qwen2.5-Coder, CodeGemma) for writing code. The classifier runs on `capix/supergemma-gemma3-4b` via the Capix gateway (~200ms, cached per session) — imperceptible to the user. Results are cached per session so similar consecutive requests skip the classifier entirely.
- **Capix model catalog** — 8 pre-listed models including auto-routing (cheapest), Gemma 3 variants (27B/12B/4B), CodeGemma 7B, Qwen2.5-Coder 7B/32B, and Llama 3.3 70B
- **Auto-connect** — Capix IDE sets `CAPIX_BASE_URL` and `CAPIX_API_KEY` env vars in launched terminals from its SecretStorage, so `capix-code` works with zero additional setup
- **Dev Token rewards** — every commit you make with Capix Code mints DEV tokens to your wallet. Complete a session, deploy, or record a decision → more tokens. On-chain proof of useful development, exchangeable for SOL or CPX in the future.
- **Covenant governance** — safe defaults: edit/bash actions require approval, autoupdate disabled (IDE manages updates)

## Install

Use **[INSTALL.md](INSTALL.md)** for exact checksum and installation commands for
macOS arm64/x64, Linux arm64/x64, and Windows x64. Customer builds are unsigned;
always compare the archive against its adjacent SHA-256 file before installation.

### Bundled in Capix IDE

Capix IDE ships `capix-code` in its PATH. When you click "Capix: Launch Capix Code", the IDE opens a terminal with `CAPIX_BASE_URL`, `CAPIX_API_KEY`, and `CAPIX_MODEL` env vars pre-set from your auto-connected LLM endpoint, then runs `capix-code`.

## Quick start

```bash
capix-code login
capix-code doctor
capix-code llm-run "Reply with exactly: CAPIX_REMOTE_OK"
capix-code
```

## Dev Tokens

Every time you do verifiable development with Capix Code, DEV tokens are minted to your wallet:

| Action                                    | Reward  |
| ----------------------------------------- | ------- |
| Commit code                               | +1 DEV  |
| Deploy an app/agent/LLM                   | +5 DEV  |
| Complete a productive session (50+ turns) | +10 DEV |
| Record an architectural decision          | +2 DEV  |
| Ship a complete product                   | +50 DEV |

Tokens are on-chain proof of useful work (Solana devnet pre-mainnet). In the future, DEV tokens will be exchangeable for SOL or CPX at launch — rewarding developers who built real products with Capix tools.

## How it works

Capix Code is a complete AI coding agent built on TypeScript/Bun. The `scripts/bootstrap.sh` clones the full source, then `scripts/rebrand.sh` applies:

- Binary name: → `capix-code`
- Config dirs: `~/.config/capix-code/`
- Env var prefixes: `CAPIX_CODE_`
- The Capix provider config (`config/defaults.json`) as the bundled default
- The Capix TUI theme (`themes/capix.toml`) with brand colors
- The Capix launch banner (`brand/banner.ts`) with ASCII art + ANSI brand colors

## Building from source

Requires Node.js 20 or newer, Rust stable, and Bun `1.3.14` exactly. Install the
pinned Bun release before building and confirm its version.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
git clone https://github.com/CapIX-Protocol/Capix-Code.git
cd CapIX-Code
test "$(bun --version)" = "1.3.14"
./scripts/bootstrap.sh
./scripts/rebrand.sh
BUN_BIN="$(command -v bun)" ./scripts/dev.sh
```

To build a standalone binary:

```bash
BUN_BIN="$(command -v bun)" ./scripts/build.sh
# verified customer runtime: dist/customer/bin/capix-code
dist/customer/bin/capix-code --version
dist/customer/bin/capix-code doctor
```

For CI/cross-platform release builds, tag a version:

```bash
git tag v1.2.1
git push origin v1.2.1
# The CI release job builds the native launcher binary (ubuntu-latest) and
# packages a source tarball with SHA-256 checksums and SBOM (UNSIGNED draft).
```

## Config

The default config (`config/defaults.json`) registers:

| Setting                 | Value                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| Provider ID             | `capix` (via `@ai-sdk/openai-compatible`)                                       |
| Base URL                | `CAPIX_BASE_URL` env var (defaults to `https://capix.network/api/v1`)           |
| API Key                 | `CAPIX_API_KEY` env var                                                         |
| Default Model           | `CAPIX_MODEL` env var (defaults to `capix/auto` — smart route)                  |
| Smart Route: Classifier | `capix/supergemma-gemma3-4b` via Capix gateway (cached per session)             |
| Smart Route: Reasoning  | Live catalog (keyword + memory-matched), fallback `capix/supergemma-gemma3-27b` |
| Smart Route: Coding     | Live catalog (keyword + memory-matched), fallback `capix/supergemma-gemma3-4b`  |
| Small Model             | `capix/supergemma-gemma3-4b` (for lightweight tasks like titles)                |
| Permission Mode         | `edit: ask`, `bash: ask` (safe defaults)                                        |
| Autoupdate              | Disabled (IDE manages updates)                                                  |

Override anything in `~/.config/capix-code/capix-code.json` or the project-level `capix-code.json`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and PR workflow.

## Security

If you discover a security vulnerability, please see [SECURITY.md](SECURITY.md) for reporting instructions. **Do not open a public issue.**

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

Copyright 2026 Capix.

## Links

- **Capix Protocol** — [capix.network](https://capix.network) · [github.com/Ritzky/Capix-Protocol](https://github.com/Ritzky/Capix-Protocol)
- **Capix IDE** — [github.com/Ritzky/CapIX-IDE](https://github.com/Ritzky/CapIX-IDE)
