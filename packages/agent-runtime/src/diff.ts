/**
 * @capix/agent-runtime — unified diff generation and application.
 *
 * Self-contained line-based diff used for the runtime's diff tracking: every
 * file-writing tool records before/after plus a unified diff, and
 * `applyPatch` applies a unified diff back onto the workspace. No external
 * dependencies.
 */

const CONTEXT_LINES = 3;

interface DiffOp {
  type: 'equal' | 'delete' | 'insert';
  line: string;
}

/** Longest-common-subsequence line diff. Fine for source-file sizes. */
function lcsDiff(beforeLines: string[], afterLines: string[]): DiffOp[] {
  const m = beforeLines.length;
  const n = afterLines.length;
  // dp[i][j] = LCS length of beforeLines[i:] and afterLines[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        beforeLines[i] === afterLines[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: 'equal', line: beforeLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: 'delete', line: beforeLines[i]! });
      i++;
    } else {
      ops.push({ type: 'insert', line: afterLines[j]! });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'delete', line: beforeLines[i++]! });
  while (j < n) ops.push({ type: 'insert', line: afterLines[j++]! });
  return ops;
}

/** Create a unified diff for a single file. Returns '' when there is no change. */
export function createUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return '';
  const beforeLines = before.length ? before.split('\n') : [];
  const afterLines = after.length ? after.split('\n') : [];
  const ops = lcsDiff(beforeLines, afterLines);

  // Group change ops: two changes belong to the same hunk when the run of
  // equal ops between them is at most 2 * CONTEXT_LINES.
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== 'equal') changeIdx.push(i);
  }
  if (changeIdx.length === 0) return '';

  const groups: Array<[number, number]> = []; // [firstChangeIdx, lastChangeIdx]
  let groupStart = changeIdx[0]!;
  let prev = changeIdx[0]!;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k]!;
    if (idx - prev - 1 > CONTEXT_LINES * 2) {
      groups.push([groupStart, prev]);
      groupStart = idx;
    }
    prev = idx;
  }
  groups.push([groupStart, prev]);

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const [first, last] of groups) {
    const hunkStart = Math.max(0, first - CONTEXT_LINES);
    const hunkEnd = Math.min(ops.length - 1, last + CONTEXT_LINES);
    const hunkOps = ops.slice(hunkStart, hunkEnd + 1);

    let oldCount = 0;
    let newCount = 0;
    for (const op of hunkOps) {
      if (op.type !== 'insert') oldCount++;
      if (op.type !== 'delete') newCount++;
    }
    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < hunkStart; i++) {
      if (ops[i]!.type !== 'insert') oldStart++;
      if (ops[i]!.type !== 'delete') newStart++;
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunkOps) {
      out.push(
        op.type === 'equal' ? ` ${op.line}` : op.type === 'delete' ? `-${op.line}` : `+${op.line}`
      );
    }
  }
  return out.join('\n') + '\n';
}

interface ParsedHunk {
  oldStart: number;
  lines: Array<{ type: 'context' | 'delete' | 'insert'; text: string }>;
}

/** Parse the hunks of a single-file unified diff. */
function parseHunks(patch: string): ParsedHunk[] {
  const lines = patch.split('\n');
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  for (const line of lines) {
    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkHeader) {
      current = { oldStart: Number(hunkHeader[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith(' ')) current.lines.push({ type: 'context', text: line.slice(1) });
    else if (line.startsWith('-')) current.lines.push({ type: 'delete', text: line.slice(1) });
    else if (line.startsWith('+')) current.lines.push({ type: 'insert', text: line.slice(1) });
    else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    // A bare empty line is the patch terminator (context lines are emitted
    // with a leading space), never a context line itself — ignore it.
  }
  return hunks;
}

/**
 * Apply a single-file unified diff to `before`, returning the patched
 * content. Throws when a hunk's context does not match (the patch does not
 * apply cleanly).
 */
export function applyUnifiedDiff(before: string, patch: string): string {
  const source = before.length ? before.split('\n') : [];
  const hunks = parseHunks(patch);
  if (hunks.length === 0) throw new Error('patch contains no hunks');

  const out: string[] = [];
  let cursor = 0; // index into source
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    if (start < cursor) throw new Error('overlapping hunks in patch');
    // Copy unchanged lines before this hunk.
    while (cursor < start) {
      if (cursor >= source.length) throw new Error('patch hunk starts past end of file');
      out.push(source[cursor]!);
      cursor++;
    }
    for (const line of hunk.lines) {
      if (line.type === 'context' || line.type === 'delete') {
        if (source[cursor] !== line.text) {
          throw new Error(
            `patch does not apply: expected "${line.text}" at line ${cursor + 1}, found "${source[cursor] ?? '<eof>'}"`
          );
        }
        if (line.type === 'context') out.push(line.text);
        cursor++;
      } else {
        out.push(line.text);
      }
    }
  }
  while (cursor < source.length) out.push(source[cursor]!);
  return out.join('\n');
}
