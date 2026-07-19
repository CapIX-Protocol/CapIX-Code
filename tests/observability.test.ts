/**
 * Tests for agent observability — the execution timeline
 * (`@capix/agent-runtime` timeline.ts + src/observability/agent-timeline.ts)
 * and the performance profiler (profiler.ts +
 * src/observability/agent-profiler.ts).
 *
 * Covers: tool-call inspection (file, command, result), decision
 * explanations, rollback of file-changing steps (including the
 * later-change conflict and created-file removal), step-by-step replay,
 * hydration from the durable store, per-tool timing, per-step token/cost
 * attribution, bottleneck identification, and the CLI text renderers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AgentProfiler,
  AgentTimeline,
  CapixAgentRuntime,
  RuntimeStore,
  type AgentEvent,
  type ModelChunk,
  type ModelInvoker,
} from '@capix/agent-runtime';
import {
  formatTimelineStep,
  hydrateTimeline,
  renderTimeline,
  teeTimeline,
} from '@/observability/agent-timeline.js';
import {
  formatCostMinor,
  hydrateProfiler,
  renderProfileReport,
  teeProfiler,
} from '@/observability/agent-profiler.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let workDir: string;

function makeRuntime(invoker: ModelInvoker, dbPath = ':memory:'): CapixAgentRuntime {
  return new CapixAgentRuntime({
    dbPath,
    workspaceRoot: workDir,
    modelInvoker: invoker,
    autoApprove: true,
  });
}

/** An invoker that plays back one chunk list per model round. */
function scriptedInvoker(rounds: ModelChunk[][]): ModelInvoker {
  let call = 0;
  return async function* () {
    const chunks = rounds[Math.min(call, rounds.length - 1)]!;
    call += 1;
    for (const chunk of chunks) yield chunk;
  };
}

const writeHelloV1: ModelChunk[] = [
  { type: 'tool_call', toolName: 'write_file', args: { path: 'hello.txt', content: 'v1' } },
  { type: 'usage', inputUnits: 10, outputUnits: 5, costMinor: '100000' },
];
const writeHelloV2: ModelChunk[] = [
  { type: 'tool_call', toolName: 'write_file', args: { path: 'hello.txt', content: 'v2' } },
  { type: 'usage', inputUnits: 20, outputUnits: 10, costMinor: '200000' },
];
const finalText: ModelChunk[] = [
  { type: 'text', delta: 'done' },
  { type: 'usage', inputUnits: 5, outputUnits: 3, costMinor: '50000' },
];

async function runTurn(
  runtime: CapixAgentRuntime,
  sessionId: string,
  tap?: (event: AgentEvent) => void
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.sendMessage({ sessionId, content: 'build it' })) {
    events.push(event);
    tap?.(event);
  }
  return events;
}

/** Run the standard two-write + text turn, tapped into a timeline/profiler. */
async function runStandardTurn(dbPath = ':memory:') {
  const runtime = makeRuntime(scriptedInvoker([writeHelloV1, writeHelloV2, finalText]), dbPath);
  const session = await runtime.createSession({});
  const timeline = new AgentTimeline({ workspaceRoot: workDir });
  const profiler = new AgentProfiler();
  const stream = teeProfiler(
    teeTimeline(runtime.sendMessage({ sessionId: session.id, content: 'build it' }), timeline),
    profiler
  );
  for await (const event of stream) void event;
  return { runtime, session, timeline, profiler };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'capix-observability-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Timeline: tool-call inspection + explanations ───────────────────────────

describe('agent timeline', () => {
  it('records every action as an inspectable step', async () => {
    const { timeline } = await runStandardTurn();
    const steps = timeline.getSteps();
    const kinds = steps.map((s) => s.kind);

    expect(kinds).toContain('turn');
    expect(kinds.filter((k) => k === 'tool_call')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'file_change')).toHaveLength(2);
    expect(kinds).toContain('content');

    const firstChange = steps.find((s) => s.kind === 'file_change')!;
    expect(firstChange.title).toContain('created hello.txt');
    expect(firstChange.fileChange?.before).toBe('');
    expect(firstChange.fileChange?.after).toBe('v1');
    expect(firstChange.fileChange?.diff).toContain('+v1');
  });

  it('inspects a tool call: what file, what result', async () => {
    const { timeline } = await runStandardTurn();
    const toolStep = timeline.getSteps().find((s) => s.kind === 'tool_call')!;
    const inspection = timeline.inspectToolCall(toolStep.toolCall!.toolCallId)!;

    expect(inspection.toolName).toBe('write_file');
    expect(inspection.filePath).toBe('hello.txt');
    expect(inspection.status).toBe('completed');
    expect(inspection.output).toContain('wrote');
    expect(inspection.isError).toBe(false);
    expect(toolStep.explanation).toContain('write_file');
  });

  it('inspects a command execution: what command, what output', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'bash', args: { command: 'echo capix' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        finalText,
      ])
    );
    const session = await runtime.createSession({});
    const timeline = new AgentTimeline({ workspaceRoot: workDir });
    await runTurn(runtime, session.id, (e) => timeline.record(e));

    const toolStep = timeline.getSteps().find((s) => s.kind === 'tool_call')!;
    expect(toolStep.toolCall?.command).toBe('echo capix');
    expect(toolStep.title).toContain('echo capix');
    expect(toolStep.toolCall?.output).toContain('capix');
  });

  it('explains rejections with the recorded reason', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'nope.txt', content: 'x' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        finalText,
      ])
    );
    const session = await runtime.createSession({});
    // ask mode denies writes outright — no operator approval involved.
    await runtime.setMode(session.id, 'ask');
    const timeline = new AgentTimeline({ workspaceRoot: workDir });
    await runTurn(runtime, session.id, (e) => timeline.record(e));

    const toolStep = timeline.getSteps().find((s) => s.kind === 'tool_call')!;
    expect(toolStep.toolCall?.status).toBe('rejected');
    expect(toolStep.toolCall?.decisionReason).toContain('ask mode');
    expect(toolStep.explanation).toContain('Rejected');
    expect(existsSync(join(workDir, 'nope.txt'))).toBe(false);
  });
});

// ── Timeline: rollback ──────────────────────────────────────────────────────

describe('timeline rollback', () => {
  it('rolls back the latest change, then removes a created file', async () => {
    const { timeline } = await runStandardTurn();
    const filePath = join(workDir, 'hello.txt');
    expect(readFileSync(filePath, 'utf8')).toBe('v2');

    const changes = timeline.getSteps().filter((s) => s.kind === 'file_change');
    expect(changes).toHaveLength(2);

    // Rolling back the older change while the newer one is active conflicts.
    await expect(timeline.rollbackStep(changes[0]!.stepId)).rejects.toMatchObject({
      problem: expect.objectContaining({ capixCode: 'conflict' }),
    });
    expect(readFileSync(filePath, 'utf8')).toBe('v2');

    // Newest first: restores the before-image, then removes the created file.
    await timeline.rollbackStep(changes[1]!.stepId);
    expect(readFileSync(filePath, 'utf8')).toBe('v1');
    expect(changes[1]!.rolledBack).toBe(true);

    await timeline.rollbackStep(changes[0]!.stepId);
    expect(existsSync(filePath)).toBe(false);
  });

  it('rolls back every change a tool call produced', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'a.txt', content: 'a' } },
          { type: 'usage', inputUnits: 1, outputUnits: 1, costMinor: '1' },
        ],
        finalText,
      ])
    );
    const session = await runtime.createSession({});
    const timeline = new AgentTimeline({ workspaceRoot: workDir });
    await runTurn(runtime, session.id, (e) => timeline.record(e));

    const toolStep = timeline.getSteps().find((s) => s.kind === 'tool_call')!;
    const rolledBack = await timeline.rollbackToolCall(toolStep.toolCall!.toolCallId);
    expect(rolledBack).toHaveLength(1);
    expect(existsSync(join(workDir, 'a.txt'))).toBe(false);
  });
});

// ── Timeline: replay ────────────────────────────────────────────────────────

describe('timeline replay', () => {
  it('replays step by step and resumes from a step', async () => {
    const { timeline } = await runStandardTurn();
    const all = timeline.getSteps();

    const replayed: string[] = [];
    for await (const step of timeline.replay()) replayed.push(step.stepId);
    expect(replayed).toEqual(all.map((s) => s.stepId));

    const midway = all[Math.floor(all.length / 2)]!;
    const resumed: string[] = [];
    for await (const step of timeline.replay({ fromStepId: midway.stepId })) {
      resumed.push(step.stepId);
    }
    expect(resumed[0]).toBe(midway.stepId);
    expect(resumed.length).toBe(all.length - all.indexOf(midway));

    await expect(timeline.replay({ fromStepId: 'missing' }).next()).rejects.toMatchObject({
      problem: expect.objectContaining({ capixCode: 'session_not_found' }),
    });
  });
});

// ── Timeline: hydration from the durable store ──────────────────────────────

describe('timeline hydration', () => {
  it('rebuilds the same timeline from the durable store', async () => {
    const dbPath = join(workDir, 'runtime.db');
    const { session, timeline } = await runStandardTurn(dbPath);

    const store = new RuntimeStore(dbPath);
    try {
      const hydrated = hydrateTimeline(store, session.id, { workspaceRoot: workDir });
      expect(hydrated.getSteps().map((s) => s.kind)).toEqual(
        timeline.getSteps().map((s) => s.kind)
      );

      // The store enriches inspections with persisted decision data.
      const toolStep = hydrated.getSteps().find((s) => s.kind === 'tool_call')!;
      expect(toolStep.toolCall?.status).toBe('completed');
      expect(toolStep.toolCall?.output).toContain('wrote');

      // Hydrated timelines roll back too.
      const change = hydrated.getSteps().filter((s) => s.kind === 'file_change').pop()!;
      await hydrated.rollbackStep(change.stepId);
      expect(readFileSync(join(workDir, 'hello.txt'), 'utf8')).toBe('v1');
    } finally {
      store.close();
    }
  });
});

// ── Profiler ────────────────────────────────────────────────────────────────

describe('agent profiler', () => {
  it('attributes tokens and cost to the action each model round triggered', async () => {
    const { profiler } = await runStandardTurn();
    const report = profiler.getReport();

    expect(report.toolCalls).toBe(2);
    expect(report.failedToolCalls).toBe(0);
    expect(report.totalInputUnits).toBe(35);
    expect(report.totalOutputUnits).toBe(18);
    expect(report.totalCostMinor).toBe('350000');

    const [first, second] = report.steps.filter((s) => s.kind === 'tool');
    expect(first!.inputUnits).toBe(10);
    expect(first!.costMinor).toBe('100000');
    expect(second!.inputUnits).toBe(20);
    expect(second!.costMinor).toBe('200000');

    // The closing round produced text, not a tool call → response step.
    const response = report.steps.find((s) => s.kind === 'model')!;
    expect(response.label).toBe('assistant response');
    expect(response.inputUnits).toBe(5);
    expect(response.costMinor).toBe('50000');

    const writeFile = report.tools.find((t) => t.toolName === 'write_file')!;
    expect(writeFile.calls).toBe(2);
    expect(writeFile.costMinor).toBe('300000');
    expect(writeFile.totalMs).toBeGreaterThanOrEqual(0);
    expect(writeFile.avgMs).toBeGreaterThanOrEqual(0);
  });

  it('measures execution time per tool and flags failures', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'bash', args: { command: 'exit 1' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        [
          { type: 'tool_call', toolName: 'bash', args: { command: 'exit 1' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        finalText,
      ])
    );
    const session = await runtime.createSession({});
    const profiler = new AgentProfiler();
    await runTurn(runtime, session.id, (e) => profiler.record(e));

    const report = profiler.getReport();
    const bash = report.tools.find((t) => t.toolName === 'bash')!;
    expect(bash.calls).toBe(2);
    expect(bash.failures).toBe(2);
    expect(report.failedToolCalls).toBe(2);

    const flaky = report.bottlenecks.find((b) => b.kind === 'flaky_tool');
    expect(flaky?.subject).toBe('bash');
    expect(flaky?.sharePct).toBe(100);
  });

  it('flags steps that dominate token and cost spend', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'big.txt', content: 'x' } },
          { type: 'usage', inputUnits: 900, outputUnits: 90, costMinor: '900000' },
        ],
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'small.txt', content: 'y' } },
          { type: 'usage', inputUnits: 5, outputUnits: 5, costMinor: '5000' },
        ],
        [
          { type: 'text', delta: 'ok' },
          { type: 'usage', inputUnits: 5, outputUnits: 5, costMinor: '5000' },
        ],
      ])
    );
    const session = await runtime.createSession({});
    const profiler = new AgentProfiler();
    await runTurn(runtime, session.id, (e) => profiler.record(e));

    const report = profiler.getReport();
    const tokenHeavy = report.bottlenecks.find((b) => b.kind === 'token_heavy');
    expect(tokenHeavy?.subject).toBe('write_file');
    expect(tokenHeavy?.sharePct).toBeGreaterThanOrEqual(90);
    const costHeavy = report.bottlenecks.find((b) => b.kind === 'cost_heavy');
    expect(costHeavy?.sharePct).toBeGreaterThanOrEqual(90);
  });

  it('hydrates the same profile from the durable store', async () => {
    const dbPath = join(workDir, 'runtime.db');
    const { session, profiler } = await runStandardTurn(dbPath);

    const store = new RuntimeStore(dbPath);
    try {
      const hydrated = hydrateProfiler(store, session.id).getReport();
      const live = profiler.getReport();
      expect(hydrated.totalCostMinor).toBe(live.totalCostMinor);
      expect(hydrated.toolCalls).toBe(live.toolCalls);
      expect(hydrated.steps.map((s) => s.stepKey)).toEqual(live.steps.map((s) => s.stepKey));
    } finally {
      store.close();
    }
  });
});

// ── CLI text renderers ──────────────────────────────────────────────────────

describe('observability CLI rendering', () => {
  it('renders the timeline as terminal text', async () => {
    const { timeline } = await runStandardTurn();
    const text = renderTimeline(timeline.getSteps());
    expect(text).toContain('created hello.txt');
    expect(text).toContain('Turn started');

    const step = timeline.getSteps().find((s) => s.kind === 'file_change')!;
    expect(formatTimelineStep(step)).toContain(step.explanation);
    expect(renderTimeline([])).toBe('(no agent activity recorded yet)');
  });

  it('renders the profile report as terminal text', async () => {
    const { profiler } = await runStandardTurn();
    const text = renderProfileReport(profiler.getReport());
    expect(text).toContain('35 in / 18 out');
    expect(text).toContain('$0.350000');
    expect(text).toContain('write_file: 2 calls');
  });

  it('formats integer minor units without floats', () => {
    expect(formatCostMinor('350000')).toBe('0.350000');
    expect(formatCostMinor('1')).toBe('0.000001');
    expect(formatCostMinor('123456789')).toBe('123.456789');
  });
});
