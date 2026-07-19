/**
 * Edit preview — terminal rendering and review session for atomic edit plans.
 *
 * Renders the `AtomicEditPlan` produced by `AtomicEditPlanner` as a
 * side-by-side diff (one file at a time) plus a plan-wide summary, and drives
 * the review loop: per-file accept/reject, bulk accept/reject, then a single
 * atomic apply. The TUI renders `renderCurrent()` and maps keybindings to
 * `accept()` / `reject()` / `acceptAll()` / `rejectAll()` / `apply()`.
 */

import type { AtomicEditPlan, AtomicEditPlanner, FileEditPlan } from './atomic-edit-planner.js';

const SIDE_BY_SIDE_WIDTH = 160;
const GUTTER = ' │ ';

/** Unified-diff rendering of one file's hunks (standard @@ headers, -/+ lines). */
export function renderUnifiedDiff(file: FileEditPlan): string {
  const header = `--- a/${file.path}\n+++ b/${file.path}`;
  if (file.hunks.length === 0) return `${header}\n(no changes)`;
  const hunks = file.hunks.map((hunk) => {
    const body = hunk.lines
      .map(
        (line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`
      )
      .join('\n');
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${body}`;
  });
  return `${header}\n${hunks.join('\n')}`;
}

/**
 * Side-by-side rendering of one file: original on the left, proposed on the
 * right, paired by diff op. Changed rows are marked `-`/`+`, context rows ` `.
 */
export function renderSideBySide(file: FileEditPlan, width = SIDE_BY_SIDE_WIDTH): string {
  const colWidth = Math.max(20, Math.floor((width - GUTTER.length) / 2));
  const clip = (text: string) =>
    text.length > colWidth ? `${text.slice(0, colWidth - 1)}…` : text.padEnd(colWidth);
  const title = `${file.path} (${file.kind}, +${file.added} -${file.removed})`;
  const divider = '─'.repeat(colWidth);
  const rows: string[] = [title, `${divider}${GUTTER}${divider}`];
  for (const hunk of file.hunks) {
    rows.push(`${'@@'.padEnd(colWidth)}${GUTTER}${'@@'.padEnd(colWidth)}`);
    // Pair remove/add ops: a remove followed by an add shares one row.
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.kind === 'remove' && lines[i + 1]?.kind === 'add') {
        rows.push(`${clip(`-${line.text}`)}${GUTTER}${clip(`+${lines[i + 1].text}`)}`);
        i++;
      } else if (line.kind === 'remove') {
        rows.push(`${clip(`-${line.text}`)}${GUTTER}${''.padEnd(colWidth)}`);
      } else if (line.kind === 'add') {
        rows.push(`${''.padEnd(colWidth)}${GUTTER}${clip(`+${line.text}`)}`);
      } else {
        rows.push(`${clip(` ${line.text}`)}${GUTTER}${clip(` ${line.text}`)}`);
      }
    }
  }
  if (file.hunks.length === 0) rows.push(`${clip('(no changes)')}${GUTTER}${clip('(no changes)')}`);
  return rows.join('\n');
}

/** One line per file: decision marker, path, kind, and +/- counts. */
export function renderPlanSummary(plan: AtomicEditPlan): string {
  const marker = (file: FileEditPlan) =>
    file.decision === 'accepted' ? '✓' : file.decision === 'rejected' ? '✗' : '?';
  const lines = plan.files.map(
    (file) => ` ${marker(file)} ${file.path} (${file.kind}, +${file.added} -${file.removed})`
  );
  const accepted = plan.files.filter((f) => f.decision === 'accepted').length;
  const rejected = plan.files.filter((f) => f.decision === 'rejected').length;
  const pending = plan.files.length - accepted - rejected;
  return [
    `Edit plan ${plan.id} — ${plan.status}`,
    ...lines,
    `${accepted} accepted, ${rejected} rejected, ${pending} pending`,
  ].join('\n');
}

/**
 * Review session over a plan. `current()` returns the first file still
 * pending review; the per-file and bulk decision methods delegate to the
 * planner; `apply()` performs the atomic apply (with automatic rollback on
 * failure) once review is done.
 */
export class EditPreviewSession {
  constructor(
    private readonly planner: AtomicEditPlanner,
    readonly plan: AtomicEditPlan
  ) {}

  /** First file awaiting a decision, or undefined when review is complete. */
  current(): FileEditPlan | undefined {
    return this.plan.files.find((f) => f.decision === 'pending');
  }

  /** Side-by-side diff for the current (or a named) file. */
  renderCurrent(width?: number, path?: string): string {
    const file = path ? this.plan.files.find((f) => f.path === path) : this.current();
    if (!file) return this.summary();
    return renderSideBySide(file, width);
  }

  /** Unified diff for the current (or a named) file. */
  renderUnified(path?: string): string {
    const file = path ? this.plan.files.find((f) => f.path === path) : this.current();
    if (!file) return this.summary();
    return renderUnifiedDiff(file);
  }

  /** Accepts the current file, or a named file. */
  accept(path?: string): void {
    this.planner.accept(this.plan.id, path ?? this.requireCurrent().path);
  }

  /** Rejects the current file, or a named file. */
  reject(path?: string): void {
    this.planner.reject(this.plan.id, path ?? this.requireCurrent().path);
  }

  acceptAll(): void {
    this.planner.acceptAll(this.plan.id);
  }

  rejectAll(): void {
    this.planner.rejectAll(this.plan.id);
  }

  summary(): string {
    return renderPlanSummary(this.plan);
  }

  /** Applies accepted files atomically; returns the updated plan. */
  async apply(): Promise<AtomicEditPlan> {
    return this.planner.apply(this.plan.id);
  }

  /** Restores originals for everything applied so far. */
  async rollback(): Promise<AtomicEditPlan> {
    return this.planner.rollback(this.plan.id);
  }

  private requireCurrent(): FileEditPlan {
    const file = this.current();
    if (!file) throw new Error('edit preview: no pending files left to review');
    return file;
  }
}
