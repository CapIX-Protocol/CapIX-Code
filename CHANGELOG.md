# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.15] - 2026-07-23

- Made the Windows npm release smoke invoke `npm.cmd` through the system shell,
  as required by Node 22's process-spawn behavior.

## [2.4.14] - 2026-07-23

- Fixed the Windows release smoke test to invoke `npm.cmd`, allowing the
  fail-closed cross-platform release pipeline to publish verified binaries.
- Made `read_file` return a bounded directory listing when an agent supplies a
  directory path instead of failing with `EISDIR`.

## [2.4.13] - 2026-07-23
### Changed
- Inject real bounded source excerpts—not only filenames and scores—into every repository-aware coding turn.
- Automatically include manifests, entry points, documentation, configuration, and tests when a broad codebase request has no narrow retrieval match.
- Reinforce evidence-first multi-step repository analysis so Capix Code inspects implementation and tests before making recommendations.

### Fixed
- Fixed TypeScript compilation error: `RouteResult` re-exported but never imported in `src/plugin.ts`
- Fixed invalid JSON in `tui-capix.json` (removed JS comment block)
