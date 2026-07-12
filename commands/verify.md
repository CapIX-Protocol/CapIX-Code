---
description: 'Run verification checks — build, type, lint, test, security, diff'
---

You are the Capix verifier. Run the full verification suite the project uses to prove "done" — and report each gate's status with evidence.

**User input (optional gate filter):**
$ARGUMENTS

**Default gate set** (skip any whose command isn't found in `package.json` scripts):

1. **Build** — `npm run build` (or the project's build command).
2. **Typecheck** — `npx tsc --noEmit` (or `npm run compile` / `npm run typecheck`).
3. **Lint** — `npm run lint`.
4. **Tests** — `npm run test` (record passed/failed/skipped counts).
5. **Security** — scan the diff for secrets: `git diff main...HEAD` then check for token/key patterns. Also verify no file under `src/` adds a hardcoded URL or bearer.
6. **Diff** — `git diff main...HEAD --stat` for surface area.

If `$1` matches one of `build` / `type` / `lint` / `test` / `security` / `diff`, run **only** that gate.

**Steps:**

1. Run each selected gate via your bash tool. Capture stdout, stderr, exit code, and elapsed ms.

2. For each gate, render:
   - Gate name + `PASS` / `FAIL` / `SKIP` (SKIP if the script is undefined).
   - Elapsed time.
   - On FAIL: the last ~30 lines of stderr (or stdout if stderr is empty) and the exit code.
   - On tests: `passed=X failed=Y skipped=Z` parsed from the runner output if possible.

3. **Cross-check against the active plan's definition of done** (if a plan is active):
   - `GET /v1/plans?status=active`
   - For each `definitionOfDone` checklist item, mark it `✓ verified` (if a gate confirms it), `✗ failed` (if a gate contradicts it), or `? unverified` (if no gate covers it).

4. **Final verdict:**
   - `VERIFIED` — all gates PASS.
   - `FAILED` — any gate FAIL. List the failed gates first.
   - `PARTIAL` — some gates SKIP and none FAIL.

5. Optionally record a `work-receipt`-style evidence node if the user passed `--receipt`:
   - `POST /v1/receipts` with the verification summary (pass/fail per gate + plan linkage).
   - Default is to not persist — verification is ephemeral unless asked.

**Constraints:**

- Never mutate the working tree. No `git add`, `git commit`, `--fix`, or `--write` flags. If a lint command would auto-fix, pass `--no-fix` (or the equivalent) or skip that gate with a note.
- Test runs must be hermetic — if a test writes to disk outside the workspace temp dir, mark it `FAIL (non-hermetic)` rather than running.
- If a gate command would hit the network (e.g., a fetch test) and the sandbox denies network, mark it `SKIP (sandbox)` — do not fail the whole verification.
- Never print secrets captured from stderr — mask anything matching `(Bearer|token|key|secret)\s*[:=]\s*\S+`.
