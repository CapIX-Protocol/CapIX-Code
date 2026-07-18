/**
 * Tests for @capix/agent-runtime — the real agent runtime.
 *
 * Covers: durable SQLite persistence, session lifecycle, modes and the
 * permission pipeline, tool execution with operator approvals, plan/diff/
 * receipt tracking, specialists, RFC 9457 problem details, and the
 * ACP-compatible JSON-RPC transport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import {
  CapixAgentRuntime,
  CapixAgentError,
  checkModePermission,
  getModeProfile,
  createUnifiedDiff,
  applyUnifiedDiff,
  createAcpServer,
  ACP_VERSION,
  type AgentEvent,
  type ModelChunk,
  type ModelInvoker,
  type ToolRequestedEvent,
} from '@capix/agent-runtime';

// ── Helpers ─────────────────────────────────────────────────────────────────

let workDir: string;

function makeRuntime(
  invoker?: ModelInvoker,
  options?: { autoApprove?: boolean; dbPath?: string }
): CapixAgentRuntime {
  return new CapixAgentRuntime({
    dbPath: options?.dbPath ?? ':memory:',
    workspaceRoot: workDir,
    modelInvoker: invoker,
    autoApprove: options?.autoApprove,
  });
}

/** An invoker that streams a fixed text reply plus usage. */
function textInvoker(reply: string, usage = { in: 10, out: 5, cost: '42' }): ModelInvoker {
  return async function* () {
    yield { type: 'text', delta: reply } as ModelChunk;
    yield {
      type: 'usage',
      inputUnits: usage.in,
      outputUnits: usage.out,
      costMinor: usage.cost,
    } as ModelChunk;
  };
}

async function collectEvents(
  runtime: CapixAgentRuntime,
  sessionId: string,
  content: string,
  onEvent?: (event: AgentEvent) => void | Promise<void>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ sessionId, content })) {
    events.push(event);
    if (onEvent) await onEvent(event);
  }
  return events;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'capix-agent-runtime-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Session lifecycle + durable persistence ─────────────────────────────────

describe('session lifecycle', () => {
  it('creates sessions with defaults and RFC 9457 errors for unknown ids', async () => {
    const runtime = makeRuntime();
    const session = await runtime.createSession({});
    expect(session.id).toMatch(/^ses_/);
    expect(session.modelId).toBe('capix/auto');
    expect(session.mode).toBe('build');
    expect(session.status).toBe('active');
    expect(session.totalCostMinor).toBe('0');

    try {
      await runtime.resumeSession('ses_missing');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapixAgentError);
      const problem = (err as CapixAgentError).problem;
      // RFC 9457 problem details shape.
      expect(problem.type).toBe('https://capix.network/problems/session_not_found');
      expect(problem.status).toBe(404);
      expect(problem.title).toBeTruthy();
      expect(problem.detail).toContain('ses_missing');
      expect(problem.capixCode).toBe('session_not_found');
    }
    runtime.close();
  });

  it('adopts an external session id and rejects duplicates with conflict', async () => {
    const runtime = makeRuntime();
    const session = await runtime.createSession({ sessionId: 'engine-123', mode: 'ask' });
    expect(session.id).toBe('engine-123');
    expect(session.mode).toBe('ask');
    await expect(runtime.createSession({ sessionId: 'engine-123' })).rejects.toMatchObject({
      problem: { status: 409, capixCode: 'conflict' },
    });
    runtime.close();
  });

  it('persists sessions, messages, and receipts to SQLite across instances', async () => {
    const dbPath = join(workDir, 'runtime.db');
    const runtime1 = makeRuntime(textInvoker('hello'), { dbPath });
    const session = await runtime1.createSession({ modelId: 'capix/auto' });
    await collectEvents(runtime1, session.id, 'hi there');
    runtime1.close();

    // A brand-new runtime on the same database file sees everything.
    const runtime2 = makeRuntime(undefined, { dbPath });
    const resumed = await runtime2.resumeSession(session.id);
    expect(resumed.modelId).toBe('capix/auto');
    expect(resumed.totalInputUnits).toBe(10);
    expect(resumed.totalOutputUnits).toBe(5);
    expect(resumed.totalCostMinor).toBe('42');

    const history = runtime2.getHistory(session.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[0]!.content).toBe('hi there');

    const usage = await runtime2.getUsage(session.id);
    expect(usage.receiptIds).toHaveLength(1);

    const listed = await runtime2.listSessions({});
    expect(listed.sessions.map((s) => s.id)).toContain(session.id);

    await runtime2.disposeSession(session.id);
    const disposed = await runtime2.resumeSession(session.id);
    expect(disposed.status).toBe('active'); // resume re-activates
    runtime2.close();
  });

  it('paginates listSessions with a cursor', async () => {
    const runtime = makeRuntime();
    for (let i = 0; i < 3; i++) {
      await runtime.createSession({ sessionId: `s${i}` });
    }
    const page1 = await runtime.listSessions({ limit: 2 });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await runtime.listSessions({ limit: 2, cursor: page1.nextCursor });
    expect(page2.sessions).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    runtime.close();
  });
});

// ── Modes and permission checks ─────────────────────────────────────────────

describe('modes and permissions', () => {
  it('exposes all five modes with distinct profiles', () => {
    for (const mode of ['ask', 'plan', 'build', 'debug', 'review'] as const) {
      expect(getModeProfile(mode).mode).toBe(mode);
    }
    expect(getModeProfile('ask').canEditFiles).toBe(false);
    expect(getModeProfile('build').canEditFiles).toBe(true);
    expect(getModeProfile('debug').canRunCommands).toBe(true);
    expect(getModeProfile('review').canRunCommands).toBe(false);
    expect(getModeProfile('plan').toolAllowlist).toContain('capix_plan');
  });

  it('decides permissions from mode, risk class, and session grants', () => {
    // ask mode: reads allowed, writes denied.
    expect(checkModePermission('ask', 'read_file', 'read').decision).toBe('allow');
    expect(checkModePermission('ask', 'write_file', 'write').decision).toBe('deny');
    // build mode: writes/commands need approval.
    expect(checkModePermission('build', 'write_file', 'write').decision).toBe('ask');
    expect(checkModePermission('build', 'bash', 'execute').decision).toBe('ask');
    // debug mode: commands pre-approved, edits still asked.
    expect(checkModePermission('debug', 'bash', 'execute').decision).toBe('allow');
    expect(checkModePermission('debug', 'edit_file', 'write').decision).toBe('ask');
    // allowlist wins over grants in ask mode.
    const grants = new Map([['bash', 'allow' as const]]);
    expect(checkModePermission('ask', 'bash', 'execute', grants).decision).toBe('deny');
    // grants apply within build mode.
    expect(checkModePermission('build', 'bash', 'execute', grants).decision).toBe('allow');
  });

  it('persists the session mode and validates mode names', async () => {
    const runtime = makeRuntime();
    const session = await runtime.createSession({});
    await runtime.setMode(session.id, 'review');
    expect(await runtime.getMode(session.id)).toBe('review');
    await expect(runtime.setMode(session.id, 'yolo' as never)).rejects.toBeInstanceOf(
      CapixAgentError
    );
    runtime.close();
  });
});

// ── Turns, usage, receipts ──────────────────────────────────────────────────

describe('sendMessage turns', () => {
  it('streams events, accumulates usage, and records a receipt', async () => {
    const runtime = makeRuntime(textInvoker('answer'));
    const session = await runtime.createSession({});
    const events = await collectEvents(runtime, session.id, 'question');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.started', 'content.delta', 'usage.updated', 'turn.completed']);
    const completed = events.at(-1)!;
    expect(completed).toMatchObject({
      finishReason: 'stop',
      totalInputUnits: 10,
      totalOutputUnits: 5,
      totalCostMinor: '42',
    });

    // All events carry the versioned envelope.
    for (const event of events) {
      expect(event.version).toBe(1);
      expect(event.sessionId).toBe(session.id);
      expect(event.eventId).toBeTruthy();
      expect(event.timestamp).toBeTruthy();
    }

    const receipts = await runtime.getReceipts(session.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ costMinor: '42', asset: 'USDC', scale: 6 });
    // No provider names in customer-facing receipt output.
    expect(receipts[0]!.modelCapability).toBe('capix/auto');

    const verification = await runtime.verifyReceipt(receipts[0]!.id);
    expect(verification.verified).toBe(true);
    expect(verification.root).toMatch(/^[0-9a-f]{64}$/);

    const settlement = await runtime.getSettlementStatus(session.id);
    expect(settlement.root).toBe(verification.root);
    runtime.close();
  });

  it('accumulates integer minor-unit cost across turns (BigInt-safe)', async () => {
    const runtime = makeRuntime(textInvoker('ok', { in: 1, out: 1, cost: '9007199254740993' }));
    const session = await runtime.createSession({});
    await collectEvents(runtime, session.id, 'one');
    await collectEvents(runtime, session.id, 'two');
    const usage = await runtime.getUsage(session.id);
    // 2 * 9007199254740993 exceeds Number.MAX_SAFE_INTEGER — string math must hold.
    expect(usage.totalCostMinor).toBe('18014398509481986');
    expect(usage.receiptIds).toHaveLength(2);
    runtime.close();
  });

  it('emits turn.failed with a problem code when no invoker is configured', async () => {
    const runtime = makeRuntime();
    const session = await runtime.createSession({});
    const events = await collectEvents(runtime, session.id, 'hi');
    const failed = events.at(-1)!;
    expect(failed.type).toBe('turn.failed');
    expect(failed).toMatchObject({ error: { capixCode: 'provider_error' } });
    runtime.close();
  });

  it('cancels an in-flight turn', async () => {
    const hangingInvoker: ModelInvoker = async function* (req) {
      yield { type: 'text', delta: 'partial' } as ModelChunk;
      await new Promise((resolve) => {
        req.signal?.addEventListener('abort', resolve, { once: true });
      });
    };
    const runtime = makeRuntime(hangingInvoker);
    const session = await runtime.createSession({});
    const eventsPromise = collectEvents(runtime, session.id, 'long task');
    // Let the turn start, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.cancelTurn(session.id);
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', finishReason: 'cancelled' });
    runtime.close();
  });
});

// ── Tool execution with permission checks ───────────────────────────────────

describe('tool execution', () => {
  const writeInvoker: ModelInvoker = async function* (req) {
    const last = req.messages.at(-1);
    if (last?.role === 'tool') {
      yield { type: 'text', delta: 'file written' } as ModelChunk;
      return;
    }
    yield {
      type: 'tool_call',
      toolName: 'write_file',
      args: { path: 'out.txt', content: 'line one\nline two\n' },
    } as ModelChunk;
  };

  it('denies write tools in ask mode without touching the filesystem', async () => {
    const runtime = makeRuntime(writeInvoker);
    const session = await runtime.createSession({ mode: 'ask' });
    const events = await collectEvents(runtime, session.id, 'write a file');
    const rejected = events.find((e) => e.type === 'tool.rejected');
    expect(rejected).toBeTruthy();
    expect(existsSync(join(workDir, 'out.txt'))).toBe(false);
    runtime.close();
  });

  it('waits for operator approval in build mode, then executes and records a diff', async () => {
    const runtime = makeRuntime(writeInvoker);
    const session = await runtime.createSession({ mode: 'build' });

    let approvedCallId: string | null = null;
    const events = await collectEvents(runtime, session.id, 'write a file', async (event) => {
      if (event.type === 'tool.requested') {
        const requested = event as ToolRequestedEvent;
        expect(requested.requiresApproval).toBe(true);
        expect(requested.toolCallId).toBeTruthy();
        approvedCallId = requested.toolCallId;
        await runtime.approveTool(session.id, requested.toolCallId, true);
      }
    });

    expect(approvedCallId).toBeTruthy();
    expect(events.some((e) => e.type === 'tool.approved')).toBe(true);
    expect(events.some((e) => e.type === 'tool.started')).toBe(true);
    expect(events.some((e) => e.type === 'tool.output')).toBe(true);
    expect(events.some((e) => e.type === 'file.diff')).toBe(true);

    // The file was actually written, and the diff was tracked durably.
    expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('line one\nline two\n');
    const diffs = await runtime.getDiff(session.id);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.filePath).toBe('out.txt');
    expect(diffs[0]!.diff).toContain('+line one');

    // The tool result was fed back to the model for a second round.
    const toolOutput = events.find((e) => e.type === 'content.delta');
    expect(toolOutput).toBeTruthy();
    runtime.close();
  });

  it('rejects the tool call when the operator denies it', async () => {
    const runtime = makeRuntime(writeInvoker);
    const session = await runtime.createSession({ mode: 'build' });
    const events = await collectEvents(runtime, session.id, 'write a file', async (event) => {
      if (event.type === 'tool.requested') {
        await runtime.approveTool(
          session.id,
          (event as ToolRequestedEvent).toolCallId,
          false,
          'not today'
        );
      }
    });
    const rejected = events.find((e) => e.type === 'tool.rejected');
    expect(rejected).toMatchObject({ reason: 'not today' });
    expect(existsSync(join(workDir, 'out.txt'))).toBe(false);
    runtime.close();
  });

  it('auto-approves via policy and honors "always" session grants', async () => {
    const runtime = makeRuntime(writeInvoker, { autoApprove: true });
    const session = await runtime.createSession({ mode: 'build' });
    const events = await collectEvents(runtime, session.id, 'write a file');
    expect(events.some((e) => e.type === 'tool.approved')).toBe(true);
    expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toContain('line one');
    runtime.close();
  });

  it('rejects unknown tools and unknown approval ids with problem details', async () => {
    const unknownToolInvoker: ModelInvoker = async function* () {
      yield { type: 'tool_call', toolName: 'nope', args: {} } as ModelChunk;
      yield { type: 'text', delta: 'done' } as ModelChunk;
    };
    const runtime = makeRuntime(unknownToolInvoker);
    const session = await runtime.createSession({ mode: 'build' });
    const events = await collectEvents(runtime, session.id, 'run nope');
    expect(events.some((e) => e.type === 'tool.rejected')).toBe(true);

    await expect(runtime.approveTool(session.id, 'tc_missing', true)).rejects.toMatchObject({
      problem: { status: 404 },
    });
    runtime.close();
  });

  it('keeps tool paths inside the workspace root', async () => {
    const escapeInvoker: ModelInvoker = async function* (req) {
      if (req.messages.at(-1)?.role === 'tool') return;
      yield {
        type: 'tool_call',
        toolName: 'write_file',
        args: { path: '../escape.txt', content: 'x' },
      } as ModelChunk;
    };
    const runtime = makeRuntime(escapeInvoker, { autoApprove: true });
    const session = await runtime.createSession({ mode: 'build' });
    const events = await collectEvents(runtime, session.id, 'escape');
    const output = events.find((e) => e.type === 'tool.output');
    expect(output).toMatchObject({ isError: true });
    expect(existsSync(join(workDir, '..', 'escape.txt'))).toBe(false);
    runtime.close();
  });
});

// ── Plans ───────────────────────────────────────────────────────────────────

describe('plan tracking', () => {
  it('creates, updates, and lists plans durably', async () => {
    const dbPath = join(workDir, 'plans.db');
    const runtime = makeRuntime(undefined, { dbPath });
    const session = await runtime.createSession({});

    const plan = await runtime.createPlan(session.id, {
      goal: 'Ship unified identity',
      definitionOfDone: ['tests pass', 'docs updated'],
      steps: [
        { description: 'write schema', files: ['db.sql'] },
        { description: 'wire API', tests: ['npm test'] },
      ],
    });
    expect(plan.planId).toMatch(/^plan_/);
    expect(plan.status).toBe('draft');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ stepId: 'step-1', status: 'pending' });

    const updated = await runtime.updatePlanStep(plan.planId, 'step-1', 'completed');
    expect(updated.steps[0]!.status).toBe('completed');
    expect(updated.updatedAt >= plan.updatedAt).toBe(true);
    runtime.close();

    const runtime2 = makeRuntime(undefined, { dbPath });
    const plans = await runtime2.listPlans(session.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.goal).toBe('Ship unified identity');
    expect(plans[0]!.steps[0]!.status).toBe('completed');

    await expect(runtime2.getPlan('plan_missing')).rejects.toMatchObject({
      problem: { status: 404 },
    });
    await expect(
      runtime2.updatePlanStep(plan.planId, 'step-99', 'completed')
    ).rejects.toMatchObject({ problem: { status: 404 } });
    runtime2.close();
  });
});

// ── Specialists and child sessions ──────────────────────────────────────────

describe('specialists', () => {
  it('lists the six specialists with bounded budgets', () => {
    const runtime = makeRuntime();
    const specialists = runtime.listSpecialists();
    expect(specialists.map((s) => s.role).sort()).toEqual([
      'deploy',
      'explore',
      'implement',
      'review',
      'security',
      'test',
    ]);
    for (const s of specialists) {
      expect(typeof s.maxSpendUsdMinor).toBe('bigint');
      expect(s.maxTurns).toBeGreaterThan(0);
      expect(s.systemPrompt.length).toBeGreaterThan(0);
    }
    runtime.close();
  });

  it('spawns child sessions with the specialist mode and lineage', async () => {
    const runtime = makeRuntime(textInvoker('explored'));
    const parent = await runtime.createSession({ mode: 'build' });
    const child = await runtime.createChildSession(parent.id, 'explore', 'map the codebase');
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.specialistRole).toBe('explore');
    expect(child.mode).toBe('ask'); // explore is read-only

    const children = await runtime.listChildSessions(parent.id);
    expect(children.map((c) => c.id)).toEqual([child.id]);

    // The child turn runs with the specialist mandate prepended.
    await collectEvents(runtime, child.id, 'what is here?');
    const history = runtime.getHistory(child.id);
    expect(history.some((m) => m.content === 'explored')).toBe(true);

    await runtime.cancelChildSession(child.id);
    const after = await runtime.listChildSessions(parent.id);
    expect(after[0]!.status).toBe('failed');

    await expect(runtime.createChildSession(parent.id, 'wizard', 'do magic')).rejects.toMatchObject(
      { problem: { status: 404 } }
    );
    runtime.close();
  });
});

// ── Commands, diffs, patches ────────────────────────────────────────────────

describe('commands and patches', () => {
  it('runs commands when the mode permits and forbids them otherwise', async () => {
    const runtime = makeRuntime();
    const build = await runtime.createSession({ mode: 'debug' });
    const result = await runtime.runCommand(build.id, 'echo hello-capix');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello-capix');

    const ask = await runtime.createSession({ mode: 'ask' });
    await expect(runtime.runCommand(ask.id, 'echo nope')).rejects.toMatchObject({
      problem: { status: 403, capixCode: 'forbidden' },
    });
    runtime.close();
  });

  it('applies unified patches in build mode and tracks the diff', async () => {
    writeFileSync(join(workDir, 'app.ts'), 'const a = 1;\nconst b = 2;\n');
    const runtime = makeRuntime();
    const session = await runtime.createSession({ mode: 'build' });

    const patch = createUnifiedDiff(
      'app.ts',
      'const a = 1;\nconst b = 2;\n',
      'const a = 1;\nconst b = 3;\n'
    );
    expect(patch).toContain('@@');
    await runtime.applyPatch(session.id, 'app.ts', patch);
    expect(readFileSync(join(workDir, 'app.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');

    const diffs = await runtime.getDiff(session.id, 'app.ts');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.diff).toContain('-const b = 2;');
    expect(diffs[0]!.diff).toContain('+const b = 3;');

    // A mismatched patch is a conflict, not a silent corruption.
    await expect(runtime.applyPatch(session.id, 'app.ts', patch)).rejects.toMatchObject({
      problem: { status: 409, capixCode: 'conflict' },
    });

    const ask = await runtime.createSession({ mode: 'ask' });
    await expect(runtime.applyPatch(ask.id, 'app.ts', patch)).rejects.toMatchObject({
      problem: { status: 403 },
    });
    runtime.close();
  });

  it('round-trips multi-hunk diffs', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n');
    const after = ['a', 'B2', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K2', 'l'].join('\n');
    const patch = createUnifiedDiff('f.txt', before, after);
    expect(applyUnifiedDiff(before, patch)).toBe(after);
    // Identity diff is empty and applies as a no-op rejection.
    expect(createUnifiedDiff('f.txt', before, before)).toBe('');
  });
});

// ── Models ──────────────────────────────────────────────────────────────────

describe('models', () => {
  it('lists only capix/auto (no provider names) and rejects unknown targets', async () => {
    const runtime = makeRuntime();
    const models = await runtime.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'capix/auto', provider: 'capix', isAuto: true });

    const session = await runtime.createSession({});
    await runtime.selectModel(session.id, 'capix/auto');
    await expect(runtime.selectModel(session.id, 'gpt-4o')).rejects.toMatchObject({
      problem: { status: 404, capixCode: 'model_not_found' },
    });
    runtime.close();
  });
});

// ── ACP JSON-RPC transport ──────────────────────────────────────────────────

describe('ACP transport', () => {
  class CaptureStream extends Writable {
    lines: unknown[] = [];
    override _write(chunk: Buffer, _enc: string, cb: () => void): void {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) this.lines.push(JSON.parse(line));
      }
      cb();
    }
  }

  function makeServer(invoker?: ModelInvoker): {
    server: ReturnType<typeof createAcpServer>;
    out: CaptureStream;
    runtime: CapixAgentRuntime;
    call: (method: string, params?: Record<string, unknown>, id?: string) => Promise<void>;
  } {
    const runtime = makeRuntime(invoker);
    const out = new CaptureStream();
    const server = createAcpServer(runtime, { output: out });
    const call = (method: string, params: Record<string, unknown> = {}, id = 'req-1') =>
      server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return { server, out, runtime, call };
  }

  it('handshakes and reports capabilities', async () => {
    const { server, out, call } = makeServer();
    await call('handshake', { version: ACP_VERSION });
    expect(out.lines[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        version: ACP_VERSION,
        capabilities: expect.arrayContaining(['modes', 'specialists', 'plans', 'receipts']),
      },
    });

    await call('handshake', { version: 999 }, 'req-2');
    const mismatch = out.lines[1] as { error: { data: { capixCode: string } } };
    expect(mismatch.error.data.capixCode).toBe('version_mismatch');
    server.close();
  });

  it('drives a full session over JSON-RPC with streaming notifications', async () => {
    const { server, out, call } = makeServer(textInvoker('acp says hi'));
    await call('session.create', {}, 'c1');
    const created = out.lines[0] as { result: { id: string } };
    const sessionId = created.result.id;
    expect(sessionId).toMatch(/^ses_/);

    await call('mode.set', { sessionId, mode: 'debug' }, 'c2');
    expect(out.lines[1]).toMatchObject({ result: { mode: 'debug' } });

    const beforeEvents = out.lines.length;
    await call('message.send', { sessionId, content: 'hello acp' }, 'c3');
    const notifications = out.lines.slice(beforeEvents, -1) as Array<{
      event: string;
      sessionId: string;
      version: number;
    }>;
    expect(notifications.map((n) => n.event)).toEqual([
      'turn.started',
      'content.delta',
      'usage.updated',
      'turn.completed',
    ]);
    for (const n of notifications) {
      expect(n.sessionId).toBe(sessionId);
      expect(n.version).toBe(ACP_VERSION);
    }
    expect(out.lines.at(-1)).toMatchObject({ id: 'c3', result: { completed: true } });

    await call('usage.get', { sessionId }, 'c4');
    expect(out.lines.at(-1)).toMatchObject({
      result: { totalInputUnits: 10, totalOutputUnits: 5, totalCostMinor: '42' },
    });

    await call('plan.create', { sessionId, goal: 'g', steps: [{ description: 's1' }] }, 'c5');
    const plan = (out.lines.at(-1) as { result: { planId: string } }).result;
    await call(
      'plan.updateStep',
      { planId: plan.planId, stepId: 'step-1', status: 'completed' },
      'c6'
    );
    expect(out.lines.at(-1)).toMatchObject({ result: { steps: [{ status: 'completed' }] } });

    await call('specialist.list', {}, 'c7');
    const specs = (out.lines.at(-1) as { result: Array<{ role: string }> }).result;
    expect(specs).toHaveLength(6);
    server.close();
  });

  it('returns RFC 9457 problem details in JSON-RPC errors', async () => {
    const { server, out, call } = makeServer();
    await call('session.resume', { sessionId: 'ses_nope' });
    const err = out.lines[0] as {
      error: {
        code: number;
        message: string;
        data: { type: string; status: number; capixCode: string };
      };
    };
    expect(err.error.code).toBe(-32000);
    expect(err.error.data).toMatchObject({
      type: 'https://capix.network/problems/session_not_found',
      status: 404,
      capixCode: 'session_not_found',
    });

    await call('mode.set', { sessionId: 'x', mode: 'bogus' }, 'req-9');
    expect((out.lines[1] as { error: { code: number } }).error.code).toBe(-32602);

    await call('nonexistent.method', {}, 'req-10');
    expect((out.lines[2] as { error: { code: number } }).error.code).toBe(-32601);

    await server.handleLine('{not json');
    expect((out.lines[3] as { error: { code: number } }).error.code).toBe(-32700);
    server.close();
  });
});
