/**
 * Tests for the agent debugging components —
 * `src/debugging/agent-debugger.ts` (execution logs, breakpoints,
 * step-through, variable inspection, profiling) and
 * `src/debugging/session-replay.ts` (record, step-through replay, state
 * inspection at any point, export).
 *
 * Unit-level coverage uses fabricated protocol events; integration coverage
 * drives a real `CapixAgentRuntime` with a scripted model invoker, the same
 * harness the observability tests use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AGENT_EVENT_VERSION,
  CapixAgentRuntime,
  RuntimeStore,
  type AgentEvent,
  type ModelChunk,
  type ModelInvoker,
} from '@capix/agent-runtime';
import {
  AgentDebugger,
  formatBreakpoint,
  formatSnapshotCost,
  matchesBreakpoint,
  renderBreakpoints,
  renderDebugLog,
  renderSnapshot,
  snapshotEvents,
} from '@/debugging/agent-debugger.js';
import {
  SessionRecorder,
  SessionReplay,
  renderSessionMarkdown,
} from '@/debugging/session-replay.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let workDir: string;
let seq = 0;
const openRuntimes: CapixAgentRuntime[] = [];

function makeEvent(type: string, data: object, turnId = 'turn_1'): AgentEvent {
  seq += 1;
  return {
    version: AGENT_EVENT_VERSION,
    eventId: `evt_${seq}`,
    sessionId: 'ses_test',
    turnId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: 'corr_1',
    redaction: 'public',
    type,
    ...data,
  } as unknown as AgentEvent;
}

/** A standard three-event turn: write_file tool call, diff, usage, text. */
function standardEvents(): AgentEvent[] {
  return [
    makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }),
    makeEvent('tool.requested', {
      toolCallId: 'tc_1',
      toolName: 'write_file',
      args: { path: 'hello.txt', content: 'v1' },
      requiresApproval: false,
    }),
    makeEvent('tool.started', { toolName: 'write_file' }),
    makeEvent('tool.output', { toolName: 'write_file', output: 'wrote hello.txt', isError: false }),
    makeEvent('file.diff', {
      filePath: 'hello.txt',
      before: '',
      after: 'v1',
      diff: '+v1',
    }),
    makeEvent('usage.updated', {
      inputUnits: 10,
      outputUnits: 5,
      costMinor: '100000',
      asset: 'USDC',
      scale: 6,
    }),
    makeEvent('content.delta', { content: 'done' }),
    makeEvent('turn.completed', {
      finishReason: 'stop',
      totalInputUnits: 10,
      totalOutputUnits: 5,
      totalCostMinor: '100000',
    }),
  ];
}

async function* streamOf(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

function makeRuntime(invoker: ModelInvoker, dbPath = ':memory:'): CapixAgentRuntime {
  const runtime = new CapixAgentRuntime({
    dbPath,
    workspaceRoot: workDir,
    modelInvoker: invoker,
    autoApprove: true,
  });
  openRuntimes.push(runtime);
  return runtime;
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'capix-debugging-test-'));
  seq = 0;
});

afterEach(() => {
  // Close SQLite handles before deleting the workspace — Windows cannot
  // unlink an open database file (EBUSY).
  while (openRuntimes.length) openRuntimes.pop()!.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── Breakpoint matching ─────────────────────────────────────────────────────

describe('breakpoint matching', () => {
  it('matches by tool name, file path, error, and step kind', () => {
    const sessionDebugger = new AgentDebugger();
    for (const event of standardEvents()) sessionDebugger.record(event);
    const steps = sessionDebugger.getTimeline().getSteps();
    const toolStep = steps.find((s) => s.kind === 'tool_call')!;
    const fileStep = steps.find((s) => s.kind === 'file_change')!;
    const turnStep = steps.find((s) => s.kind === 'turn')!;

    expect(matchesBreakpoint(toolStep, { toolName: 'write_file' })).toBe(true);
    expect(matchesBreakpoint(toolStep, { toolName: 'bash' })).toBe(false);
    expect(matchesBreakpoint(fileStep, { filePath: 'hello.txt' })).toBe(true);
    expect(matchesBreakpoint(toolStep, { filePath: 'hello.txt' })).toBe(true); // tool arg path
    expect(matchesBreakpoint(turnStep, { kinds: ['turn'] })).toBe(true);
    expect(matchesBreakpoint(turnStep, { kinds: ['tool_call'] })).toBe(false);
    expect(matchesBreakpoint(toolStep, { onError: true })).toBe(false);
    // A condition-less breakpoint never fires.
    expect(matchesBreakpoint(toolStep, {})).toBe(false);
    expect(matchesBreakpoint(toolStep, { kinds: [] })).toBe(false);
  });

  it('matches erroring tool calls and failed turns with onError', () => {
    const events = [
      makeEvent('tool.requested', {
        toolCallId: 'tc_1',
        toolName: 'bash',
        args: { command: 'exit 1' },
        requiresApproval: false,
      }),
      makeEvent('tool.output', { toolName: 'bash', output: 'failed', isError: true }),
      makeEvent('turn.failed', {
        error: { capixCode: 'model_error', message: 'boom', retryClass: 'none' },
      }),
    ];
    const sessionDebugger = new AgentDebugger();
    for (const event of events) sessionDebugger.record(event);
    const steps = sessionDebugger.getTimeline().getSteps();

    expect(matchesBreakpoint(steps.find((s) => s.kind === 'tool_call')!, { onError: true })).toBe(
      true
    );
    expect(matchesBreakpoint(steps.find((s) => s.kind === 'error')!, { onError: true })).toBe(true);
  });
});

// ── Execution log ───────────────────────────────────────────────────────────

describe('execution log', () => {
  it('records every event with full context in order', () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    for (const event of events) sessionDebugger.record(event);

    const log = sessionDebugger.getLog();
    expect(log).toHaveLength(events.length);
    expect(log.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(log[0]!.event.type).toBe('turn.started');
    expect(log[0]!.step?.kind).toBe('turn');
    expect(log[1]!.step?.toolCall?.toolName).toBe('write_file');
    expect(log[1]!.step?.toolCall?.args).toEqual({ path: 'hello.txt', content: 'v1' });
    // Tool completion folds into the same step as the request.
    expect(log[3]!.step?.stepId).toBe(log[1]!.step?.stepId);
    expect(log[3]!.step?.toolCall?.output).toBe('wrote hello.txt');
  });

  it('flags log entries that tripped a breakpoint', () => {
    const sessionDebugger = new AgentDebugger();
    const breakpoint = sessionDebugger.addBreakpoint({ toolName: 'write_file' });
    for (const event of standardEvents()) sessionDebugger.record(event);

    const hits = sessionDebugger.getLog().filter((e) => e.hit);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hit?.id).toBe(breakpoint.id);
    expect(hits[0]!.event.type).toBe('tool.requested');
    expect(sessionDebugger.listBreakpoints()[0]!.hits).toBe(1);
  });
});

// ── Breakpoint management ───────────────────────────────────────────────────

describe('breakpoint management', () => {
  it('adds, lists, disables, and removes breakpoints', () => {
    const sessionDebugger = new AgentDebugger();
    const bp1 = sessionDebugger.addBreakpoint({ toolName: 'write_file' });
    const bp2 = sessionDebugger.addBreakpoint({ onError: true });
    expect(sessionDebugger.listBreakpoints()).toHaveLength(2);

    sessionDebugger.setBreakpointEnabled(bp1.id, false);
    expect(sessionDebugger.listBreakpoints().find((b) => b.id === bp1.id)!.enabled).toBe(false);

    // Disabled breakpoints do not fire.
    for (const event of standardEvents()) sessionDebugger.record(event);
    expect(sessionDebugger.getLog().filter((e) => e.hit)).toHaveLength(0);

    expect(sessionDebugger.removeBreakpoint(bp1.id)).toBe(true);
    expect(sessionDebugger.removeBreakpoint(bp1.id)).toBe(false);
    sessionDebugger.clearBreakpoints();
    expect(sessionDebugger.listBreakpoints()).toHaveLength(0);
    expect(bp2.hits).toBe(0);
  });
});

// ── Step-through debugging ──────────────────────────────────────────────────

describe('step-through debugging', () => {
  it('pauses at a breakpoint and resumes with continue', async () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    sessionDebugger.addBreakpoint({ filePath: 'hello.txt' });

    const gen = sessionDebugger.run(streamOf(events));
    let pauses = 0;
    let item = await gen.next(); // turn.started — no hit
    expect(item.value!.hit).toBeUndefined();
    expect(sessionDebugger.getStatus()).toBe('running');

    while (!item.done) {
      if (item.value!.hit) {
        pauses += 1;
        expect(sessionDebugger.getStatus()).toBe('paused');
        // The paused generator blocks until the operator resumes.
        sessionDebugger.resume('continue');
      }
      item = await gen.next();
    }

    // The file breakpoint trips on the tool call AND the file diff — two
    // distinct steps, one pause each (step updates never re-trip).
    expect(pauses).toBe(2);
    expect(sessionDebugger.getStatus()).toBe('idle');
    expect(sessionDebugger.getLog()).toHaveLength(events.length);
  });

  it('resume("step") pauses again at the next step', async () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    sessionDebugger.addBreakpoint({ toolName: 'write_file' });

    const gen = sessionDebugger.run(streamOf(events));
    await gen.next(); // turn.started
    const paused = await gen.next(); // tool.requested → break
    expect(paused.value!.hit).toBeDefined();

    sessionDebugger.resume('step');
    const stepped = await gen.next(); // next step-producing event pauses again
    expect(stepped.done).toBe(false);
    expect(sessionDebugger.getStatus()).toBe('paused');

    sessionDebugger.resume('continue');
    for await (const item of gen) void item;
    expect(sessionDebugger.getStatus()).toBe('idle');
  });

  it('pause() stops a running stream at the next event', async () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();

    const gen = sessionDebugger.run(streamOf(events));
    await gen.next();
    sessionDebugger.pause();
    const paused = await gen.next();
    expect(sessionDebugger.getStatus()).toBe('paused');
    expect(paused.done).toBe(false);

    sessionDebugger.resume('continue');
    for await (const item of gen) void item;
    expect(sessionDebugger.getLog()).toHaveLength(events.length);
  });

  it('runs without pausing when no breakpoints are set', async () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    const seen: AgentEvent[] = [];
    for await (const item of sessionDebugger.run(streamOf(events))) {
      seen.push(item.entry.event);
    }
    expect(seen).toHaveLength(events.length);
    expect(sessionDebugger.getStatus()).toBe('idle');
  });
});

// ── Variable inspection ─────────────────────────────────────────────────────

describe('variable inspection', () => {
  it('reports the accumulated session state', () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    for (const event of events) sessionDebugger.record(event);

    const state = sessionDebugger.inspectState();
    expect(state.eventCount).toBe(events.length);
    expect(state.content).toBe('done');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]!.toolName).toBe('write_file');
    expect(state.toolCalls[0]!.status).toBe('completed');
    expect(state.filesChanged).toEqual(['hello.txt']);
    expect(state.inputUnits).toBe(10);
    expect(state.outputUnits).toBe(5);
    expect(state.costMinor).toBe('100000');
  });

  it('inspects the state at any recorded point', () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    for (const event of events) sessionDebugger.record(event);

    // After the first two events the tool call exists but has no result yet.
    const early = sessionDebugger.inspectAt(2);
    expect(early.eventCount).toBe(2);
    expect(early.toolCalls).toHaveLength(1);
    expect(early.toolCalls[0]!.status).toBe('requested');
    expect(early.filesChanged).toEqual([]);
    expect(early.content).toBe('');
    expect(early.inputUnits).toBe(0);
  });

  it('inspects one step: log entry plus state at that point', () => {
    const events = standardEvents();
    const sessionDebugger = new AgentDebugger();
    for (const event of events) sessionDebugger.record(event);

    const fileStep = sessionDebugger
      .getTimeline()
      .getSteps()
      .find((s) => s.kind === 'file_change')!;
    const inspection = sessionDebugger.inspectStep(fileStep.stepId)!;
    expect(inspection.entry.step?.stepId).toBe(fileStep.stepId);
    expect(inspection.state.filesChanged).toEqual(['hello.txt']);
    // Content arrived after the diff — not part of the state at that step.
    expect(inspection.state.content).toBe('');

    expect(sessionDebugger.inspectStep('missing')).toBeNull();
  });

  it('folds events into snapshots with per-turn usage totals', () => {
    const events = [
      makeEvent('usage.updated', {
        inputUnits: 10,
        outputUnits: 5,
        costMinor: '100',
        asset: 'USDC',
        scale: 6,
      }),
      // Cumulative per-turn: the second event replaces the first for turn_1.
      makeEvent('usage.updated', {
        inputUnits: 30,
        outputUnits: 15,
        costMinor: '300',
        asset: 'USDC',
        scale: 6,
      }),
      makeEvent(
        'usage.updated',
        { inputUnits: 7, outputUnits: 3, costMinor: '70', asset: 'USDC', scale: 6 },
        'turn_2'
      ),
    ];
    const snapshot = snapshotEvents(events);
    expect(snapshot.inputUnits).toBe(37);
    expect(snapshot.outputUnits).toBe(18);
    expect(snapshot.costMinor).toBe('370');
  });
});

// ── Profiling integration ───────────────────────────────────────────────────

describe('profiling', () => {
  it('profiles the debugged session alongside the log', () => {
    const sessionDebugger = new AgentDebugger();
    for (const event of standardEvents()) sessionDebugger.record(event);

    const profile = sessionDebugger.getProfile();
    expect(profile.toolCalls).toBe(1);
    expect(profile.failedToolCalls).toBe(0);
    expect(profile.totalCostMinor).toBe('100000');
    expect(profile.tools.find((t) => t.toolName === 'write_file')!.calls).toBe(1);
  });
});

// ── Live runtime integration ────────────────────────────────────────────────

describe('live runtime debugging', () => {
  it('debugs a real runtime turn end to end', async () => {
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'hello.txt', content: 'v1' } },
          { type: 'usage', inputUnits: 10, outputUnits: 5, costMinor: '100000' },
        ],
        [
          { type: 'text', delta: 'done' },
          { type: 'usage', inputUnits: 15, outputUnits: 8, costMinor: '150000' },
        ],
      ])
    );
    const session = await runtime.createSession({});
    const sessionDebugger = new AgentDebugger({ workspaceRoot: workDir });
    sessionDebugger.addBreakpoint({ toolName: 'write_file' });

    const gen = sessionDebugger.run(runtime.sendMessage({ sessionId: session.id, content: 'hi' }));
    let broke = false;
    let item = await gen.next();
    while (!item.done) {
      if (item.value!.hit) {
        broke = true;
        expect(sessionDebugger.getStatus()).toBe('paused');
        // Inspect mid-flight: the file write is already visible.
        expect(sessionDebugger.inspectState().toolCalls.length).toBeGreaterThanOrEqual(1);
        sessionDebugger.resume('continue');
      }
      item = await gen.next();
    }

    expect(broke).toBe(true);
    expect(readFileSync(join(workDir, 'hello.txt'), 'utf8')).toBe('v1');
    const state = sessionDebugger.inspectState();
    expect(state.filesChanged).toContain('hello.txt');
    expect(state.toolCalls[0]!.status).toBe('completed');
  });

  it('hydrates the debugger from the durable store', async () => {
    const dbPath = join(workDir, 'runtime.db');
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'a.txt', content: 'a' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        [
          { type: 'text', delta: 'ok' },
          { type: 'usage', inputUnits: 6, outputUnits: 3, costMinor: '2000' },
        ],
      ]),
      dbPath
    );
    const session = await runtime.createSession({});
    for await (const event of runtime.sendMessage({ sessionId: session.id, content: 'go' })) {
      void event;
    }

    const store = new RuntimeStore(dbPath);
    try {
      const hydrated = AgentDebugger.hydrateFromStore(store, session.id, {
        workspaceRoot: workDir,
      });
      const state = hydrated.inspectState();
      expect(state.toolCalls).toHaveLength(1);
      expect(state.filesChanged).toContain('a.txt');
      expect(hydrated.getLog().length).toBeGreaterThan(0);
      expect(hydrated.getProfile().toolCalls).toBe(1);
    } finally {
      store.close();
    }
  });
});

// ── CLI rendering ───────────────────────────────────────────────────────────

describe('debugger CLI rendering', () => {
  it('renders breakpoints, the log, and snapshots as terminal text', () => {
    const sessionDebugger = new AgentDebugger();
    expect(renderBreakpoints([])).toBe('(no breakpoints set)');
    expect(renderDebugLog([])).toBe('(nothing recorded yet)');

    const breakpoint = sessionDebugger.addBreakpoint({ toolName: 'write_file', onError: false });
    expect(formatBreakpoint(breakpoint)).toContain('tool=write_file');
    expect(renderBreakpoints(sessionDebugger.listBreakpoints())).toContain(breakpoint.id);

    for (const event of standardEvents()) sessionDebugger.record(event);
    const log = renderDebugLog(sessionDebugger.getLog());
    expect(log).toContain('tool.requested');
    expect(log).toContain('[BREAK');

    const snapshot = renderSnapshot(sessionDebugger.inspectState());
    expect(snapshot).toContain('10 in / 5 out');
    expect(snapshot).toContain('$0.100000');
    expect(snapshot).toContain('write_file hello.txt [completed]');
    expect(snapshot).toContain('Files changed: hello.txt');
  });

  it('formats integer minor units without floats', () => {
    expect(formatSnapshotCost('350000')).toBe('0.350000');
    expect(formatSnapshotCost('1')).toBe('0.000001');
    expect(formatSnapshotCost('123456789')).toBe('123.456789');
  });
});

// ── Session recording ───────────────────────────────────────────────────────

describe('session recording', () => {
  it('records a live stream while passing events through', async () => {
    const events = standardEvents();
    const recorder = new SessionRecorder('ses_test', workDir);
    const seen: AgentEvent[] = [];
    for await (const event of recorder.tee(streamOf(events))) seen.push(event);

    expect(seen).toHaveLength(events.length);
    const recording = recorder.getRecording();
    expect(recording.version).toBe(1);
    expect(recording.sessionId).toBe('ses_test');
    expect(recording.workspaceRoot).toBe(workDir);
    expect(recording.events).toHaveLength(events.length);
  });

  it('saves and loads a recording round-trip', async () => {
    const recorder = new SessionRecorder('ses_test');
    for (const event of standardEvents()) recorder.record(event);
    const filePath = join(workDir, 'session.json');
    await recorder.save(filePath);

    const replay = await SessionReplay.load(filePath);
    expect(replay.length).toBe(standardEvents().length);
    expect(replay.getRecording().sessionId).toBe('ses_test');
  });

  it('rebuilds a recording from the durable store', async () => {
    const dbPath = join(workDir, 'runtime.db');
    const runtime = makeRuntime(
      scriptedInvoker([
        [
          { type: 'tool_call', toolName: 'write_file', args: { path: 'b.txt', content: 'b' } },
          { type: 'usage', inputUnits: 4, outputUnits: 2, costMinor: '1000' },
        ],
        [{ type: 'text', delta: 'ok' }],
      ]),
      dbPath
    );
    const session = await runtime.createSession({});
    for await (const event of runtime.sendMessage({ sessionId: session.id, content: 'go' })) {
      void event;
    }

    const store = new RuntimeStore(dbPath);
    try {
      const replay = SessionReplay.fromStore(store, session.id, workDir);
      expect(replay.length).toBeGreaterThan(0);
      expect(replay.getRecording().sessionId).toBe(session.id);
    } finally {
      store.close();
    }
  });
});

// ── Session replay ──────────────────────────────────────────────────────────

describe('session replay', () => {
  function makeReplay(): SessionReplay {
    const recorder = new SessionRecorder('ses_test');
    for (const event of standardEvents()) recorder.record(event);
    return new SessionReplay(recorder.getRecording());
  }

  it('steps forward and backward through the recording', () => {
    const replay = makeReplay();
    expect(replay.position).toBe(-1);

    const first = replay.next()!;
    expect(first.index).toBe(0);
    expect(first.event.type).toBe('turn.started');
    expect(first.step?.kind).toBe('turn');

    replay.next(); // tool.requested
    const third = replay.next()!; // tool.started folds into the same step
    expect(third.index).toBe(2);
    expect(third.step?.toolCall?.status).toBe('running');

    const back = replay.prev()!;
    expect(back.index).toBe(1);
    expect(back.event.type).toBe('tool.requested');

    expect(replay.seek(-1)).toBeNull();
    expect(replay.prev()).toBeNull();
  });

  it('stops at the end of the recording', () => {
    const replay = makeReplay();
    let count = 0;
    while (replay.next()) count += 1;
    expect(count).toBe(replay.length);
    expect(replay.next()).toBeNull();
  });

  it('seeks to any point and reports the state there', () => {
    const replay = makeReplay();
    const frame = replay.seek(4)!; // file.diff
    expect(frame.event.type).toBe('file.diff');
    expect(frame.state.filesChanged).toEqual(['hello.txt']);
    expect(frame.state.content).toBe(''); // content arrives later
    expect(replay.position).toBe(4);

    // Seeking backward re-folds the timeline correctly.
    const early = replay.seek(1)!;
    expect(early.state.toolCalls[0]!.status).toBe('requested');
  });

  it('inspects the state at any point with snapshotAt', () => {
    const replay = makeReplay();
    const mid = replay.snapshotAt(1);
    expect(mid.toolCalls).toHaveLength(1);
    expect(mid.toolCalls[0]!.status).toBe('requested');

    const end = replay.snapshotAt(replay.length - 1);
    expect(end.content).toBe('done');
    expect(end.costMinor).toBe('100000');
    expect(end.filesChanged).toEqual(['hello.txt']);
  });

  it('auto-paces a full replay from the cursor', async () => {
    const replay = makeReplay();
    const frames: number[] = [];
    for await (const frame of replay.replay()) frames.push(frame.index);
    expect(frames).toEqual(standardEvents().map((_, i) => i));
    expect(replay.position).toBe(replay.length - 1);
  });
});

// ── Session export ──────────────────────────────────────────────────────────

describe('session export', () => {
  function makeReplay(): SessionReplay {
    const recorder = new SessionRecorder('ses_test', workDir);
    for (const event of standardEvents()) recorder.record(event);
    return new SessionReplay(recorder.getRecording());
  }

  it('exports JSON that loads back', async () => {
    const replay = makeReplay();
    const filePath = join(workDir, 'export.json');
    const exported = replay.exportSession('json');
    expect(JSON.parse(exported).sessionId).toBe('ses_test');

    writeFileSync(filePath, exported, 'utf8');
    const loaded = await SessionReplay.load(filePath);
    expect(loaded.length).toBe(replay.length);
  });

  it('exports one JSON event per line as JSONL', () => {
    const lines = makeReplay().exportSession('jsonl').split('\n');
    expect(lines).toHaveLength(standardEvents().length);
    expect(JSON.parse(lines[0]!).type).toBe('turn.started');
    expect(JSON.parse(lines.at(-1)!).type).toBe('turn.completed');
  });

  it('exports a Markdown analysis report', () => {
    const markdown = makeReplay().exportSession('markdown');
    expect(markdown).toContain('# Agent session ses_test');
    expect(markdown).toContain('10 in / 5 out');
    expect(markdown).toContain('$0.100000');
    expect(markdown).toContain('## Steps');
    expect(markdown).toContain('created hello.txt');
    expect(markdown).toContain('`write_file` hello.txt [completed]');
  });

  it('renders the markdown report helper directly', () => {
    const recording = makeReplay().getRecording();
    expect(renderSessionMarkdown(recording)).toContain('# Agent session ses_test');
  });
});

// ── Recording persistence ───────────────────────────────────────────────────

describe('recording persistence', () => {
  it('writes the recording to the requested path', async () => {
    const recorder = new SessionRecorder('ses_test');
    for (const event of standardEvents()) recorder.record(event);
    const filePath = join(workDir, 'recording.json');
    await recorder.save(filePath);
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).events).toHaveLength(
      standardEvents().length
    );
  });
});
