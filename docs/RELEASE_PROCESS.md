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

The `.github/workflows/release.yml` workflow triggers on any `v*` tag push or manual dispatch.

### Steps

1. **create-release** — creates a draft GitHub Release
2. **build** — runs a matrix build across platforms:
   - `ubuntu-latest` (linux-x64)
   - `macos-13` (macos-x64)
   - `macos-14` (macos-arm64)
   - `windows-latest` (windows-x64)

   Each matrix job:
   1. Checks out the capix-code repo
   2. Sets up Bun
   3. Runs lint + type check + tests
   4. Clones upstream via `scripts/bootstrap.sh`
   5. Applies rebrand via `scripts/rebrand.sh`
   6. Installs config via `scripts/install-config.sh`
   7. Builds the standalone binary via `scripts/build.sh`
   8. Uploads the artifact

3. **publish** — downloads all platform artifacts and attaches them to the GitHub Release

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
