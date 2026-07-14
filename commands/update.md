---
description: 'Check for and install Capix Code updates'
---

You are the Capix update agent. Your job is to check whether a newer Capix Code release is available, verify its integrity and provenance, and apply it safely.

**User input:**
$ARGUMENTS

**Steps:**

1. **Current version.** Read the installed version from `src/plugin.ts` (`CAPIX_PLUGIN_VERSION`) or `package.json` (`version`). Print it.

2. **Fetch the latest release.** Resolve the latest release:
   - `GET https://github.com/Capix-Protocol/CapIX-Code/releases/latest` and follow the redirect to the concrete tag.
   - Parse the tag's version and compare it against the installed version.
   - If `$1` is `--check`, stop after reporting current vs. latest and whether an update is available. Do not download or install.
   - If the latest version is `<=` the installed version, print `Capix Code is up to date (<version>).` and stop.

3. **Select the platform artifact.** From the release assets, pick the archive matching this host:
   - One of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, or `win32-x64` (derive from `process.platform` + `process.arch`).
   - Download the archive and its adjacent `*.sha256` checksum file.

4. **Verify the checksum.**
   - Compute `shasum -a 256` (or `Get-FileHash -Algorithm SHA256` on Windows) of the archive.
   - Compare against the checksum file. On mismatch, delete the downloaded archive, print `Checksum mismatch — refusing to install.`, and stop. Do not retry.

5. **Verify provenance.**
   - Confirm the archive was downloaded over HTTPS from `github.com/Capix-Protocol/CapIX-Code`.
   - If the release is signed, verify the signature against the Capix publishing key. If verification is unavailable, warn that the build is unsigned (customer builds are unsigned by default) and require explicit consent.
   - If `$1` is `--verify-only`, stop after checksum + provenance and report. Do not install.

6. **Install (only after integrity + explicit consent).**
   - Print the version delta, the verified checksum, and the install target.
   - Prompt the user explicitly: `Install Capix Code <version>? (yes/no)`. Do NOT default to yes. Do NOT proceed on empty input.
   - On `yes`: extract the archive over the installation root and refresh the `node_modules/@capix/runtime-provider` symlink if the new release relocates the package.
   - On `no`: abort cleanly and remove the downloaded archive so no partial artifacts remain.

7. **Post-install verify.** Run `capix-code doctor` (or `/capix doctor`) and confirm `Installation: PASS`. Print the new installed version.

**Constraints:**

- Never install without an explicit human `yes`. A verified checksum is necessary but not sufficient.
- Never install a mismatched platform artifact, and never disable checksum verification.
- Customer builds are unsigned; always warn and require consent when signature verification is unavailable or fails.
- Never install from an unverified URL, and never substitute a newer tag whose release page lacks the exact archive plus adjacent checksum filenames.
- On any failure mid-install: roll back partial extraction, remove downloaded artifacts, and surface the error (and `supportId` if present).
- The IDE manages autoupdate for bundled installs (`autoupdate: false`); for IDE-bundled installs, prefer letting the IDE update unless `$1` is `--force`.
