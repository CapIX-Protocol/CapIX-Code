# Release Process

## Versioning

Capix Code follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **MAJOR** — incompatible API changes (renamed env vars, removed models)
- **MINOR** — new features (new routing modes, new config options) — backwards compatible
- **PATCH** — bug fixes, dependency bumps, security patches

The current version lives in:

- `package.json` (`"version"` field)
- `brand/banner.ts` (reads from `package.json`)

Both must always be in sync.

## Release Flow

```
1. Update CHANGELOG.md
2. Bump version in package.json
3. Commit: chore(release): vX.Y.Z
4. Tag: git tag vX.Y.Z
5. Push tag: git push origin vX.Y.Z
6. CI triggers the Release workflow automatically
7. Review the draft release on GitHub
8. Publish the release
```

## CI Release Pipeline

The `release` job inside `.github/workflows/ci.yml` triggers on any `v*` tag
push. It depends on both the `lint-typecheck-test` and `plugin-contract` jobs
passing (`needs` + `if: success()`), so a red CI job can never publish.

### Steps

1. **Checkout & install** — checks out the repo and runs `npm ci`
2. **Typecheck (release gate)** — `npx tsc --noEmit`
3. **Reject launcher placeholders** — fails if the native launcher source
   still contains stub markers (`launcher stub`, `implementation pending`,
   `engine handoff pending`)
4. **Build Rust launcher** — `cargo build --locked --release` (requires
   `launcher/Cargo.lock` to be present and up to date)
5. **Smoke test** — `launcher/target/release/capix-code doctor`
6. **Generate SBOM** — `@cyclonedx/cyclonedx-npm` (falls back to a minimal
   provenance file from `package-lock.json` if the tool is unavailable)
7. **Record source commit SHA** — writes `source-commit-sha.txt`
8. **Package source tarball** — `capix-code-source-<tag>.tar.gz` containing
   `src/`, `packages/runtime-provider/`, `package.json`, `package-lock.json`
9. **Generate SHA-256 checksums** — `CHECKSUMS.sha256` covering all artifacts
10. **Create draft release** — UNSIGNED draft GitHub release with the source
    tarball, SBOM, commit SHA, and checksums attached

> **Note:** The release job runs only on `ubuntu-latest`. There is no
> multi-platform matrix build — the artifacts are source tarballs and the
> native launcher binary, not platform-specific standalone builds.

## Pre-release Checklist

Before tagging a release:

- [ ] All tests pass (`npm test`)
- [ ] `npm run compile` passes (tsc --noEmit)
- [ ] `npm run lint` passes (eslint)
- [ ] `npm run format:check` passes (prettier)
- [ ] CHANGELOG.md is updated with all notable changes
- [ ] Version in `package.json` and `brand/banner.ts` match
- [ ] No secrets or API keys in the diff
- [ ] The bootstrap SHA pin in `scripts/bootstrap.sh` is current (if upgrading upstream)

## Checklist Verification (for the upcoming release)

The `../scripts/build.sh` no longer suppresses compilation errors. If the build fails, CI will fail and the release will not proceed.

## Rollback

To roll back a bad release:

1. Delete the GitHub Release (mark as draft or delete)
2. Delete the tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`
3. Fix forward: create a new patch release with the fix
