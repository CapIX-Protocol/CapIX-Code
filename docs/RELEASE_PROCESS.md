# Release Process

## Versioning

Capix Code follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **MAJOR** — incompatible API changes (renamed env vars, removed models)
- **MINOR** — new features (new routing modes, new config options) — backwards compatible
- **PATCH** — bug fixes, dependency bumps, security patches

The product-coupled release version lives in:

- `package.json` and `package-lock.json`
- `config/runtime-package.json`
- `packages/runtime-provider/package.json`
- `packages/agent-runtime/package.json` and `packages/agent-runtime/src/runtime.ts`
- `launcher/Cargo.toml`, `launcher/Cargo.lock`, and the launcher fallback release id
- `release/version.json`, `src/plugin.ts`, and `src/ai-sdk-provider.ts`

`node scripts/check-release-consistency.mjs X.Y.Z` fails if any identity drifts.

## Release Flow

```
1. Update customer release notes and install documentation.
2. Bump every product-coupled identity and run the consistency gate.
3. Run compile, lint, tests, native launcher tests, and packaging checks.
4. Commit the release candidate.
5. Create a new annotated tag: `git tag -a vX.Y.Z -m "Capix Code vX.Y.Z"`.
6. Push the commit and immutable tag. Never move or recreate an existing tag.
7. The native matrix builds the exact peeled tag commit on all five targets.
8. Review the checksums, manifest, SBOM, provenance, native install smokes, and source SHA.
9. Publish npm only after the matching GitHub release exists.
```

## CI Release Pipeline

`.github/workflows/build.yml` is the tag-triggered native build and GitHub
release pipeline. `.github/workflows/release-binaries.yml` is the controlled
release/publish pipeline for an already-created tag and additionally publishes
the npm installer. Every job checks out that tag and proves
`HEAD^{commit} == refs/tags/<tag>^{commit}` before building or publishing.

### Steps

1. **Prove immutable source** — checkout the tag with full tag history and
   compare the checked-out commit with the annotated/lightweight tag's peeled
   commit.
2. **Verify overlay** — locked install, typecheck, lint, unit tests, and release
   identity consistency.
3. **Build natively** — macOS arm64/x64, Linux arm64/x64, and Windows x64.
4. **Verify runtime** — artifact structure/branding, launcher `doctor`, MCP
   initialize/tool inventory both authenticated and signed out.
5. **Verify customer npm path** — install the final npm meta tarball with CI's
   normal postinstall skip explicitly overridden, download the staged native
   archive, verify its adjacent checksum, and run `--version` plus `doctor`.
6. **Package unsigned artifacts** — this release line intentionally uses the
   `-unsigned` filename on every platform.
7. **Generate evidence** — five-platform release manifest, portable checksum
   sidecars, SBOM, provenance, NOTICE, and exact source SHA.
8. **Publish** — GitHub release first; npm trusted publishing only after that
   immutable release is visible.

## Pre-release Checklist

Before tagging a release:

- [ ] All tests pass (`npm test`)
- [ ] `npm run compile` passes (tsc --noEmit)
- [ ] `npm run lint` passes (eslint)
- [ ] `npm run format:check` passes (prettier)
- [ ] CHANGELOG.md is updated with all notable changes
- [ ] `node scripts/check-release-consistency.mjs X.Y.Z` passes
- [ ] The annotated tag peels to the exact reviewed release commit
- [ ] No secrets or API keys in the diff
- [ ] The bootstrap SHA pin in `scripts/bootstrap.sh` is current (if upgrading upstream)

## Checklist Verification (for the upcoming release)

The `../scripts/build.sh` no longer suppresses compilation errors. If the build fails, CI will fail and the release will not proceed.

## Rollback

To roll back a bad release:

1. Mark the bad GitHub release as a prerelease/non-latest so installers stop
   selecting it.
2. Restore the previous verified release as latest.
3. Fix forward with a new patch version and new immutable tag. Never move or
   delete/recreate a customer release tag.
