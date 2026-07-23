# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.13] - 2026-07-23
### Changed
- Inject real bounded source excerpts—not only filenames and scores—into every repository-aware coding turn.
- Automatically include manifests, entry points, documentation, configuration, and tests when a broad codebase request has no narrow retrieval match.
- Reinforce evidence-first multi-step repository analysis so Capix Code inspects implementation and tests before making recommendations.

### Fixed
- Fixed TypeScript compilation error: `RouteResult` re-exported but never imported in `src/plugin.ts`
- Fixed invalid JSON in `tui-capix.json` (removed JS comment block)
