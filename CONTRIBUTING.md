# Contributing to Capix Code

Thank you for your interest in contributing to Capix Code! This document covers the developer workflow.

## Quick Reference

- **Branch from:** `main`
- **PR target:** `main`
- **Commit style:** [Conventional Commits](https://www.conventionalcommits.org/)
- **CI must pass** before merge
- **One approval** required (two for larger changes)

## Development Setup

### Prerequisites

- Bun `1.3.14` exactly (runtime and bundler)
- [Node.js 20+](https://nodejs.org) (standalone TypeScript tooling)
- [Rust stable](https://www.rust-lang.org/tools/install) (native customer launcher)
- [Git](https://git-scm.com)

### Get the code

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
git clone https://github.com/CapIX-Protocol/Capix-Code.git
cd CapIX-Code
npm install
test "$(bun --version)" = "1.3.14"
./scripts/bootstrap.sh
./scripts/rebrand.sh
BUN_BIN="$(command -v bun)" ./scripts/dev.sh
```

Set your Capix env vars before running:

```bash
export CAPIX_BASE_URL=https://capix.network/api/v1
export CAPIX_API_KEY=cpk_...
export CAPIX_MODEL=capix/auto
```

### Run the tests

```bash
npm test                # run all vitest unit tests
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report (80% line threshold)
```

### Lint and format

```bash
npm run lint            # eslint on src/
npm run format          # prettier --write (fixes)
npm run format:check    # prettier --check (CI gate)
npm run compile         # tsc --noEmit (type check)
```

### Pre-commit hooks

On `npm install`, Husky sets up pre-commit and commit-msg hooks:

- **pre-commit:** runs `lint-staged` (prettier + eslint on staged files)
- **commit-msg:** runs `commitlint` (validates conventional commit format)

## Commit Message Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/). Each commit message must be:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | Use for                                |
| ---------- | -------------------------------------- |
| `fix`      | Bug fixes                              |
| `feat`     | New features                           |
| `docs`     | Documentation only                     |
| `style`    | Formatting, no code change             |
| `refactor` | Code restructuring, no behavior change |
| `test`     | Adding or fixing tests                 |
| `chore`    | Build, deps, tooling, CI               |
| `ci`       | CI/CD changes                          |
| `perf`     | Performance improvements               |

### Examples

```
feat(router): add loop mode auto-deploy handling
fix(plugin): correctly re-export RouteResult type
docs(README): clarify this is an AI coding agent
chore(deps): bump vitest to 2.1.0
```

## Pull Request Process

1. **Branch** from `main`: `git checkout -b feat/my-feature`
2. **Write tests** for new functionality (aim for 80%+ coverage)
3. **Run locally**: `npm run compile && npm run lint && npm test`
4. **Push** and open a PR against `main`
5. **Describe** what changed and why
6. **CI runs** automatically — all checks must pass
7. **Review**: one reviewer for small PRs, two for larger changes
8. **Squash merge** — the PR title becomes the commit message

## Release Process

See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) for the full semver → tag → CI → release flow.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
