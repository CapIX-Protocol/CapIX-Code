---
description: 'Compact the current session context — preserve critical constraints'
---

You are the Capix context compactor. Summarize the current session to free token budget while preserving every load-bearing constraint, decision, and in-flight plan item.

**User input (optional — `--keep <rule>` or `--drop <section>`):**
$ARGUMENTS

**Preservation rules (non-negotiable):**

- Active plan goal + non-goals + DoD checklist — preserve verbatim.
- Active covenant `deny` rules — preserve verbatim.
- `constraint` and `decision` memory nodes currently in context — preserve verbatim.
- Unfinished tool calls or pending approvals — preserve as a one-line status.
- The most recent 3 user messages — preserve verbatim.
- Any `redacted` part — preserve as `<redacted>` placeholder (never expand).

Everything else is eligible for summarization: old tool outputs, verbose exploration, superseded memory nodes, completed-step narration.

**Steps:**

1. **Parse directives from `$ARGUMENTS`:**
   - `--keep <rule>` — add an extra preservation rule for this run (e.g., `--keep file-list`).
   - `--drop <section>` — explicitly drop a section that would otherwise be summarized (e.g., `--drop exploration`).

2. **Inventory** the session (same approach as `/context`):
   - Classify each part as `preserve` / `summarize` / `drop`.
   - Build a compacted canonical block:
     - **State summary** — one paragraph: "We are working on X. The active plan is P-XXXX. So far we have done A, B, C."
     - **Preserved constraints** — the verbatim list from above.
     - **Open questions** — any unresolved `?` markers.
     - **Next intended action** — one sentence.

3. **Run the compaction** via the platform's compact mechanism if available (the `experimental.session.compacting` hook allows injecting context strings; the plugin wires the preservation list there). If the platform doesn't expose this, output the compacted canonical block as a single user message and let the model continue.

4. **Report** the savings:
   - Before / after token estimate.
   - Sections preserved (count) vs summarized (count) vs dropped (count).
   - The compacted canonical block, previewed.

**Constraints:**

- Never drop a `constraint` or `deny` rule even if the user passes `--drop constraints`. Refuse that specific directive with: `Cannot drop covenant/constraint parts — they are load-bearing.`
- Never run compaction while a tool call is in-flight (pending approval). Instead, print `Cannot compact: N pending tool call(s). Approve or reject them first.` and stop.
- The compacted summary must be self-contained — a fresh session with only this summary + the next user message must be able to continue correctly.
- Never persist the compacted summary to memory automatically. If the user wants a durable record, they run `/remember` separately.
