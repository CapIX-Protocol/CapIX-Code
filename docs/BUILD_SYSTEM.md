# Capix Build System

The Capix build system produces reproducible, verified release artifacts for
every Capix package from locked dependencies, on native runners for each
supported platform.

## Components

| Component          | Location                      | Purpose                                                                                                    |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CI/CD pipeline     | `.github/workflows/build.yml` | Test matrix, native binary builds, optional signing, release manifest, publish, rollback                   |
| Unified build      | `scripts/build-all.sh`        | Build all packages (code, MCP, protocol, IDE), checksums, release manifest, optional GitHub release upload |
| Build verification | `scripts/verify-build.sh`     | Verify checksums, smoke test every binary, validate manifest JSON                                          |
| Packaging          | `scripts/package-customer.sh` | Archive + checksum the assembled customer runtime                                                          |

## Platforms

Every artifact is built and smoke-tested on a **native runner** — no
cross-compilation:

- macOS arm64 (`macos-14`), macOS x64 (`macos-15-intel`)
- Linux x64 (`ubuntu-latest`), Linux arm64 (`ubuntu-24.04-arm`)
- Windows x64 (`windows-latest`)

## Reproducible builds

All dependency inputs are locked and pinned:

- npm packages install with `npm ci` against `package-lock.json`.
- The Rust launcher builds with `cargo build --locked` against
  `launcher/Cargo.lock`; CI fails if the lockfile is missing.
- The engine builds with Bun pinned to `1.3.14`
  (`oven-sh/setup-bun@v2`, enforced by `scripts/build.sh`).
- Release metadata generation pins `npm@10.9.4` so SBOM output stays stable.

## CI/CD pipeline (`build.yml`)

Jobs run in order; a red job blocks everything downstream.

1. **test** — on every push/PR, all five platforms: `npm ci`, `tsc --noEmit`,
   `eslint`, `vitest run`, `cargo test --locked`.
2. **build** — on version tags (`v*`) and manual dispatch only: bootstrap the
   pinned engine, build the customer runtime (`scripts/build.sh`), run the
   packaged MCP protocol smoke test and `capix-code doctor`, package with
   `scripts/package-customer.sh`, then verify with `scripts/verify-build.sh`.
3. **manifest** — on tags: merges all platform artifacts, generates the
   immutable `release-manifest.json` (validated by
   `scripts/validate-manifest.mjs`), SPDX SBOM, `provenance.json`, and SHA-256
   sidecars for every file.
4. **publish** — on tags (or dispatch with `publish=true` on a tag): uploads
   the verified release directory to the GitHub release.
5. **rollback** — manual dispatch only, see below.

## Signing

Artifacts are signed **when certificates are provisioned** as repository
secrets; otherwise they ship with the explicit `-unsigned` flavor in the file
name (`CAPIX_ARTIFACT_FLAVOR` in `scripts/package-customer.sh`).

- **macOS**: set `APPLE_CERTIFICATE` (base64 `.p12`),
  `APPLE_CERTIFICATE_PASSWORD`, and `KEYCHAIN_PASSWORD` to enable Developer ID
  codesigning. Additionally set `APPLE_ID`, `APPLE_TEAM_ID`, and
  `APPLE_APP_PASSWORD` to enable notarization.
- **Windows**: set `WINDOWS_CERTIFICATE` (base64 `.pfx`) and
  `WINDOWS_CERTIFICATE_PASSWORD` to enable `signtool` signing with
  SHA-256 timestamping.
- **Linux**: no signing; verify via SHA-256 sidecars.

Unsigned macOS builds are still ad-hoc signed by `scripts/build.sh` so library
validation does not kill the binaries — that is not a release identity.

## Unified local build (`build-all.sh`)

Builds every package and produces one `release-artifacts/` directory:

```bash
scripts/build-all.sh                     # everything
scripts/build-all.sh --skip-ide          # skip the heavy IDE build
scripts/build-all.sh --upload v2.4.15    # upload to the GitHub release
```

Package checkouts resolve from `CAPIX_CODE_DIR`, `CAPIX_MCP_DIR`,
`CAPIX_PROTOCOL_DIR`, `CAPIX_IDE_DIR`, falling back to sibling directories
(`../mcp`, `../protocol`, `../ide`, …). Per package:

- **capix-code** — `scripts/build.sh` + `scripts/package-customer.sh`
- **capix-mcp** — `npm ci`, `npm run build`, `npm test`, `npm pack`
- **capix-protocol** — `npm ci`, `npm run typecheck`, `npm run build`
  (Next.js), archive of `.next` + runtime files
- **capix-ide** — `scripts/build.sh` + `scripts/package.sh`
  (requires Node 20.18.2)

Outputs: distributable archives, a `.sha256` sidecar per archive, and
`build-manifest.json` recording each package's version, source commit, and
artifact digests.

## Verification (`verify-build.sh`)

```bash
scripts/verify-build.sh [release-artifacts]
```

1. Recomputes the SHA-256 of every archive and compares it to the sidecar.
2. Smoke tests each binary: `capix-code doctor` on matching-platform archives,
   compiled-entry presence for `capix-mcp`, `.next/BUILD_ID` for
   `capix-protocol`. Foreign-platform binaries are checksum-verified and
   reported as execution-skipped.
3. Parses every manifest/provenance/SBOM JSON file.

Exits non-zero if anything fails; both CI and `build-all.sh` run it before any
upload.

## Rollback

To yank a bad published release:

```bash
gh workflow run build.yml -f rollback_tag=v2.4.15
```

The rollback job marks the bad release as a pre-release with a `YANKED` note
(so installers stop selecting it) and restores the newest remaining stable
release as `latest`. Rollback never deletes artifacts — the yanked release
stays available for forensics.

To roll forward instead, fix the source, bump the version, and tag a new
release; the pipeline republishes from the tag.
