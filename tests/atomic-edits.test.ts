import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AtomicEditPlanner,
  NodeEditFileSystem,
  diffLines,
  type EditFileSystem,
} from '../src/editing/atomic-edit-planner.js';
import {
  EditPreviewSession,
  renderPlanSummary,
  renderSideBySide,
  renderUnifiedDiff,
} from '../src/editing/edit-preview.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capix-atomic-edits-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Wraps the real FS but throws when writing/deleting a chosen path. */
function failableFs(failPath: string): EditFileSystem {
  const inner = new NodeEditFileSystem();
  return {
    readFile: (p) => inner.readFile(p),
    writeFile: async (p, c) => {
      if (p === failPath) throw new Error('disk full');
      return inner.writeFile(p, c);
    },
    deleteFile: async (p) => {
      if (p === failPath) throw new Error('disk full');
      return inner.deleteFile(p);
    },
  };
}

describe('diffLines', () => {
  it('returns no hunks for identical text', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('computes a hunk with context, add and remove lines', () => {
    const hunks = diffLines('one\ntwo\nthree\nfour\nfive', 'one\nTWO\nthree\nfour\nfive\nsix');
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0];
    expect(hunk.oldStart).toBe(1);
    const kinds = hunk.lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'remove', 'add', 'context', 'context', 'context', 'add']);
    expect(hunk.lines[1]).toMatchObject({ kind: 'remove', text: 'two', oldLine: 2 });
    expect(hunk.lines[2]).toMatchObject({ kind: 'add', text: 'TWO', newLine: 2 });
  });

  it('splits distant changes into separate hunks', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const next = old.replace('line2', 'LINE2').replace('line19', 'LINE19');
    expect(diffLines(old, next)).toHaveLength(2);
  });

  it('diffs an empty original as a pure insertion anchored at 0', () => {
    const hunks = diffLines('', 'hello\nworld');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(0);
    expect(hunks[0].lines.every((l) => l.kind === 'add' || l.kind === 'context')).toBe(true);
  });
});

describe('AtomicEditPlanner', () => {
  it('plans create / modify / delete with diffs before applying', async () => {
    const modPath = join(dir, 'mod.ts');
    const delPath = join(dir, 'del.ts');
    await writeFile(modPath, 'const a = 1;\nconst b = 2;\n', 'utf8');
    await writeFile(delPath, 'gone soon', 'utf8');
    const newPath = join(dir, 'nested', 'new.ts');

    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([
      { path: modPath, newContent: 'const a = 1;\nconst b = 3;\n' },
      { path: delPath, newContent: null },
      { path: newPath, newContent: 'export {};\n' },
    ]);

    expect(plan.status).toBe('awaiting-review');
    const byPath = new Map(plan.files.map((f) => [f.path, f]));
    expect(byPath.get(modPath)).toMatchObject({ kind: 'modify', added: 1, removed: 1 });
    expect(byPath.get(delPath)).toMatchObject({ kind: 'delete', removed: 1 });
    expect(byPath.get(newPath)).toMatchObject({ kind: 'create', originalContent: null });
    expect(plan.files.every((f) => f.decision === 'pending')).toBe(true);
    // Nothing on disk yet — planning must not touch the tree.
    expect(await readFile(modPath, 'utf8')).toBe('const a = 1;\nconst b = 2;\n');
    expect(await exists(newPath)).toBe(false);
  });

  it('applies only accepted files', async () => {
    const keep = join(dir, 'keep.ts');
    const skip = join(dir, 'skip.ts');
    await writeFile(keep, 'old\n', 'utf8');
    await writeFile(skip, 'old\n', 'utf8');

    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([
      { path: keep, newContent: 'new\n' },
      { path: skip, newContent: 'new\n' },
    ]);
    planner.accept(plan.id, keep);
    planner.reject(plan.id, skip);
    const result = await planner.apply(plan.id);

    expect(result.status).toBe('applied');
    expect(result.appliedPaths).toEqual([keep]);
    expect(await readFile(keep, 'utf8')).toBe('new\n');
    expect(await readFile(skip, 'utf8')).toBe('old\n');
  });

  it('marks the plan rejected when nothing is accepted', async () => {
    const planner = new AtomicEditPlanner();
    const target = join(dir, 'x.ts');
    const plan = await planner.plan([{ path: target, newContent: 'x\n' }]);
    planner.rejectAll(plan.id);
    const result = await planner.apply(plan.id);
    expect(result.status).toBe('rejected');
    expect(await exists(target)).toBe(false);
  });

  it('rolls back every applied file when any write fails', async () => {
    const first = join(dir, 'first.ts');
    const boom = join(dir, 'boom.ts');
    await writeFile(first, 'original\n', 'utf8');

    const planner = new AtomicEditPlanner(failableFs(boom));
    const plan = await planner.plan([
      { path: first, newContent: 'changed\n' },
      { path: boom, newContent: 'never lands\n' },
    ]);
    planner.acceptAll(plan.id);
    const result = await planner.apply(plan.id);

    expect(result.status).toBe('rolled-back');
    expect(result.errors).toEqual([{ path: boom, message: 'disk full' }]);
    // The earlier successful write was undone.
    expect(await readFile(first, 'utf8')).toBe('original\n');
    expect(await exists(boom)).toBe(false);
  });

  it('rollback removes created files and recreates deleted ones', async () => {
    const created = join(dir, 'created.ts');
    const deleted = join(dir, 'deleted.ts');
    await writeFile(deleted, 'precious\n', 'utf8');

    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([
      { path: created, newContent: 'brand new\n' },
      { path: deleted, newContent: null },
    ]);
    planner.acceptAll(plan.id);
    await planner.apply(plan.id);
    expect(await exists(created)).toBe(true);
    expect(await exists(deleted)).toBe(false);

    const rolled = await planner.rollback(plan.id);
    expect(rolled.status).toBe('rolled-back');
    expect(await exists(created)).toBe(false);
    expect(await readFile(deleted, 'utf8')).toBe('precious\n');
  });

  it('rejects decisions for unknown plans and paths', async () => {
    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([{ path: join(dir, 'a.ts'), newContent: 'a\n' }]);
    expect(() => planner.accept(plan.id, 'nope.ts')).toThrow(/no file/);
    expect(() => planner.accept('bad-id', 'a.ts')).toThrow(/unknown edit plan/);
  });
});

describe('edit preview rendering', () => {
  it('renders unified diffs with @@ headers and -/+ markers', async () => {
    const target = join(dir, 'u.ts');
    await writeFile(target, 'a\nb\nc', 'utf8');
    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([{ path: target, newContent: 'a\nB\nc' }]);
    const out = renderUnifiedDiff(plan.files[0]);
    expect(out).toContain(`--- a/${target}`);
    expect(out).toMatch(/@@ -1,3 \+1,3 @@/);
    expect(out).toContain('-b');
    expect(out).toContain('+B');
  });

  it('renders a side-by-side view pairing remove/add rows', async () => {
    const target = join(dir, 's.ts');
    await writeFile(target, 'left\n', 'utf8');
    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([{ path: target, newContent: 'right\n' }]);
    const out = renderSideBySide(plan.files[0], 80);
    expect(out).toContain('modify, +1 -1');
    const changeRow = out.split('\n').find((l) => l.includes('-left'));
    expect(changeRow).toContain('+right');
    expect(changeRow).toContain('│');
  });

  it('renders a plan summary with per-file decision markers', async () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([
      { path: a, newContent: 'a' },
      { path: b, newContent: 'b' },
    ]);
    planner.accept(plan.id, a);
    const out = renderPlanSummary(plan);
    expect(out).toContain(`✓ ${a} (create, +1 -0)`);
    expect(out).toContain(`? ${b} (create, +1 -0)`);
    expect(out).toContain('1 accepted, 0 rejected, 1 pending');
  });
});

describe('EditPreviewSession', () => {
  it('walks pending files, supports bulk decisions and applies atomically', async () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    await writeFile(a, '1\n', 'utf8');
    await writeFile(b, '2\n', 'utf8');

    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([
      { path: a, newContent: 'one\n' },
      { path: b, newContent: 'two\n' },
    ]);
    const session = new EditPreviewSession(planner, plan);

    expect(session.current()?.path).toBe(a);
    session.accept();
    expect(session.current()?.path).toBe(b);
    session.reject(b);
    expect(session.current()).toBeUndefined();

    const result = await session.apply();
    expect(result.status).toBe('applied');
    expect(await readFile(a, 'utf8')).toBe('one\n');
    expect(await readFile(b, 'utf8')).toBe('2\n');
  });

  it('throws when accepting with no pending files left', async () => {
    const planner = new AtomicEditPlanner();
    const plan = await planner.plan([{ path: join(dir, 'x.ts'), newContent: 'x\n' }]);
    const session = new EditPreviewSession(planner, plan);
    session.acceptAll();
    expect(() => session.accept()).toThrow(/no pending files/);
    const result = await session.apply();
    expect(result.status).toBe('applied');
  });
});
