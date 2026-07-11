# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Fixed
- Fixed TypeScript compilation error: `RouteResult` re-exported but never imported in `src/plugin.ts`
- Fixed invalid JSON in `tui-capix.json` (removed JS comment block)
