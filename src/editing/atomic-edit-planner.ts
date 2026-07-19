/**
 * Atomic edit planner — plans multi-file edits before touching disk.
 *
 * Refs:
 * - planner/ (checkpointable plans, rollback strategy)
 * - intelligence-client `createCheckpoint`
 *
 * The planner turns a set of proposed file changes (create / modify / delete)
 * into a reviewable `AtomicEditPlan`: every change is planned up front, a
 * line-level diff is computed for each file, and the user (or the agent
 * approval gate) accepts or rejects each file individually. `apply()` writes
 * only accepted files, and if ANY write fails the planner rolls back every
 * file it already touched — the working tree is never left half-edited.
 * After a successful apply, `rollback()` restores the original contents.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { logger } from '../logger.js';

/** A single proposed change. `newContent: null` deletes the file. */
export interface ProposedFileChange {
  path: string;
  newContent: string | null;
}

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the original file (undefined for added lines). */
  oldLine?: number;
  /** 1-based line number in the new file (undefined for removed lines). */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileEditKind = 'create' | 'modify' | 'delete';
export type EditDecision = 'pending' | 'accepted' | 'rejected';

export interface FileEditPlan {
  path: string;
  kind: FileEditKind;
  /** Original file contents, or null when the file does not exist yet. */
  originalContent: string | null;
  /** Proposed contents, or null when the file will be deleted. */
  newContent: string | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  decision: EditDecision;
}

export type PlanStatus = 'awaiting-review' | 'applied' | 'rolled-back' | 'rejected' | 'failed';

export interface AtomicEditPlan {
  id: string;
  files: FileEditPlan[];
  status: PlanStatus;
  /** Paths actually written during apply(), in write order. */
  appliedPaths: string[];
  errors: Array<{ path: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Filesystem abstraction. Tests inject a failable implementation; production
 * uses `NodeEditFileSystem`. `readFile` returns null when the file is missing.
 */
export interface EditFileSystem {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export class NodeEditFileSystem implements EditFileSystem {
  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }

  async deleteFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

/** Context lines kept around each change inside a hunk. */
const HUNK_CONTEXT = 3;
/**
 * The LCS diff is O(n·m) in line counts — above this guard we fall back to a
 * single whole-file hunk instead of allocating a huge table.
 */
const LCS_CELL_GUARD = 4_000_000;

/** Line-level diff between two texts, grouped into hunks with context. */
export function diffLines(oldText: string, newText: string): DiffHunk[] {
  // Empty text has zero lines (split('\n') would invent one empty line).
  const a = oldText.length === 0 ? [] : oldText.split('\n');
  const b = newText.length === 0 ? [] : newText.split('\n');
  const ops = lcsOps(a, b);
  return groupHunks(ops, HUNK_CONTEXT);
}

/** Full op sequence (context/add/remove with line numbers) via LCS. */
function lcsOps(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > LCS_CELL_GUARD) {
    // Coarse fallback: whole-file replace.
    return [
      ...a.map((text, i) => ({ kind: 'remove' as const, text, oldLine: i + 1 })),
      ...b.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'remove', text: a[i], oldLine: i + 1 });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: 'remove', text: a[i], oldLine: ++i });
  while (j < b.length) ops.push({ kind: 'add', text: b[j], newLine: ++j });
  return ops;
}

/** Splits a full op sequence into hunks separated by > 2·context unchanged lines. */
function groupHunks(ops: DiffLine[], context: number): DiffHunk[] {
  const changed = ops
    .map((op, idx) => ({ op, idx }))
    .filter(({ op }) => op.kind !== 'context')
    .map(({ idx }) => idx);
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    const lo = changed[k] - context;
    const hi = changed[k] + context;
    if (lo <= end + 1) {
      end = Math.min(ops.length - 1, Math.max(end, hi));
    } else {
      ranges.push([start, end]);
      start = Math.max(0, lo);
      end = Math.min(ops.length - 1, hi);
    }
  }
  ranges.push([start, end]);

  return ranges.map(([lo, hi]) => {
    const lines = ops.slice(lo, hi + 1);
    const oldNums = lines.map((l) => l.oldLine).filter((n): n is number => n !== undefined);
    const newNums = lines.map((l) => l.newLine).filter((n): n is number => n !== undefined);
    // Pure-insertion hunks (no old lines) start at 0 = "insert before line 1";
    // pure-deletion hunks likewise anchor at 0 on the new side.
    return {
      oldStart: oldNums[0] ?? 0,
      oldLines: lines.filter((l) => l.kind !== 'add').length,
      newStart: newNums[0] ?? 0,
      newLines: lines.filter((l) => l.kind !== 'remove').length,
      lines,
    };
  });
}

export class AtomicEditPlanner {
  private readonly plans = new Map<string, AtomicEditPlan>();

  constructor(private readonly fs: EditFileSystem = new NodeEditFileSystem()) {}

  /**
   * Plans all changes before applying anything: reads current file contents,
   * classifies each change (create / modify / delete) and computes the diff.
   * No-op changes (identical content) are kept as `modify` with empty hunks.
   */
  async plan(changes: ProposedFileChange[]): Promise<AtomicEditPlan> {
    const files: FileEditPlan[] = [];
    for (const change of changes) {
      const original = await this.fs.readFile(change.path);
      const kind: FileEditKind =
        original === null ? 'create' : change.newContent === null ? 'delete' : 'modify';
      const hunks =
        change.newContent === null
          ? diffLines(original ?? '', '')
          : diffLines(original ?? '', change.newContent);
      files.push({
        path: change.path,
        kind,
        originalContent: original,
        newContent: change.newContent,
        hunks,
        added: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0),
        removed: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'remove').length, 0),
        decision: 'pending',
      });
    }
    const now = new Date().toISOString();
    const plan: AtomicEditPlan = {
      id: randomUUID(),
      files,
      status: 'awaiting-review',
      appliedPaths: [],
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.id, plan);
    logger.info('atomic edit plan created', {
      planId: plan.id,
      files: files.length,
      creates: files.filter((f) => f.kind === 'create').length,
      deletes: files.filter((f) => f.kind === 'delete').length,
    });
    return plan;
  }

  getPlan(planId: string): AtomicEditPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`unknown edit plan: ${planId}`);
    return plan;
  }

  accept(planId: string, path: string): void {
    this.setDecision(planId, path, 'accepted');
  }

  reject(planId: string, path: string): void {
    this.setDecision(planId, path, 'rejected');
  }

  acceptAll(planId: string): void {
    const plan = this.getPlan(planId);
    for (const file of plan.files) file.decision = 'accepted';
    plan.updatedAt = new Date().toISOString();
  }

  rejectAll(planId: string): void {
    const plan = this.getPlan(planId);
    for (const file of plan.files) file.decision = 'rejected';
    plan.updatedAt = new Date().toISOString();
  }

  private setDecision(planId: string, path: string, decision: EditDecision): void {
    const plan = this.getPlan(planId);
    const file = plan.files.find((f) => f.path === path);
    if (!file) throw new Error(`plan ${planId} has no file: ${path}`);
    file.decision = decision;
    plan.updatedAt = new Date().toISOString();
  }

  /**
   * Applies every accepted file. If any write or delete fails, all files
   * already touched are rolled back to their original state and the plan is
   * marked `rolled-back` (or `failed` when rollback itself errors).
   * A plan with no accepted files is marked `rejected` and touches nothing.
   */
  async apply(planId: string): Promise<AtomicEditPlan> {
    const plan = this.getPlan(planId);
    const accepted = plan.files.filter((f) => f.decision === 'accepted');
    if (accepted.length === 0) {
      plan.status = 'rejected';
      plan.updatedAt = new Date().toISOString();
      return plan;
    }
    for (const file of accepted) {
      try {
        if (file.newContent === null) await this.fs.deleteFile(file.path);
        else await this.fs.writeFile(file.path, file.newContent);
        plan.appliedPaths.push(file.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        plan.errors.push({ path: file.path, message });
        logger.error('atomic edit apply failed — rolling back', {
          planId,
          path: file.path,
          error: message,
        });
        await this.rollback(planId);
        return plan;
      }
    }
    plan.status = 'applied';
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /**
   * Restores every applied file to its original state: modified files get
   * their original content back, created files are removed, deleted files
   * are recreated. Marks the plan `rolled-back`, or `failed` if any restore
   * errors (original bytes are still held in the plan for manual recovery).
   */
  async rollback(planId: string): Promise<AtomicEditPlan> {
    const plan = this.getPlan(planId);
    let failed = false;
    // Restore in reverse write order so dependent paths unwind cleanly.
    for (const path of [...plan.appliedPaths].reverse()) {
      const file = plan.files.find((f) => f.path === path);
      if (!file) continue;
      try {
        if (file.originalContent === null) await this.fs.deleteFile(file.path);
        else await this.fs.writeFile(file.path, file.originalContent);
      } catch (err) {
        failed = true;
        plan.errors.push({
          path: file.path,
          message: `rollback failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    plan.status = failed ? 'failed' : 'rolled-back';
    plan.updatedAt = new Date().toISOString();
    if (failed) logger.error('atomic edit rollback incomplete', { planId, errors: plan.errors });
    return plan;
  }
}
