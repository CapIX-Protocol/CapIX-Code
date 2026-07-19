/**
 * src/debugging/agent-debugger — CLI-facing agent debugger.
 *
 * Built on the shared observability engine (`AgentTimeline` + `AgentProfiler`
 * from `@capix/agent-runtime`) so the Capix Code TUI and CapixIDE debug the
 * exact same execution. This module adds what interactive debugging needs:
 *
 * - Execution logs with full context: every event is folded into a
 *   `DebugLogEntry` carrying the raw event, the timeline step it touched, and
 *   its correlation/redaction metadata.
 * - Breakpoints in agent execution: stop on a tool call, a file touch, an
 *   error, or any step kind. During a `run()` the stream pauses at a hit
 *   until the operator resumes with `continue` or `step`.
 * - Variable inspection: `inspectState()` / `inspectAt()` return the
 *   accumulated session state — reasoning, content, tool calls with args and
 *   results, files changed, tokens and cost — at the current point or any
 *   recorded point.
 * - Performance profiling: the shared `AgentProfiler` runs alongside, so the
 *   paused debugger can report time/tokens/cost per action and bottlenecks.
 *
 * The class is UI-free: terminal surfaces render with `renderDebugLog`,
 * `renderBreakpoints`, and `renderSnapshot`; CapixIDE mirrors the same
 * breakpoint semantics in `agentDebuggerPanel.ts`.
 */

import {
  AgentProfiler,
  AgentTimeline,
  type AgentEvent,
  type AgentProfileReport,
  type RuntimeStore,
  type TimelineStep,
  type TimelineStepKind,
  type ToolCallInspection,
} from '@capix/agent-runtime';

// ── Breakpoints ─────────────────────────────────────────────────────────────

export interface BreakpointSpec {
  /** Step kinds this breakpoint stops on; omitted = every step kind. */
  kinds?: TimelineStepKind[];
  /** Only stop on tool_call steps for this tool. */
  toolName?: string;
  /** Only stop on steps touching this workspace-relative file path. */
  filePath?: string;
  /** Stop when a step reports an error (failed tool call or failed turn). */
  onError?: boolean;
}

export interface Breakpoint extends BreakpointSpec {
  id: string;
  enabled: boolean;
  /** How many times this breakpoint has stopped execution. */
  hits: number;
}

/** True when the step satisfies every condition the breakpoint sets. */
export function matchesBreakpoint(step: TimelineStep, breakpoint: BreakpointSpec): boolean {
  if (breakpoint.kinds && breakpoint.kinds.length > 0 && !breakpoint.kinds.includes(step.kind)) {
    return false;
  }
  if (breakpoint.toolName && step.toolCall?.toolName !== breakpoint.toolName) return false;
  if (
    breakpoint.filePath &&
    step.fileChange?.filePath !== breakpoint.filePath &&
    step.toolCall?.filePath !== breakpoint.filePath
  ) {
    return false;
  }
  if (breakpoint.onError && step.kind !== 'error' && step.toolCall?.isError !== true) {
    return false;
  }
  // A breakpoint with no conditions at all never fires — require at least one.
  return Boolean(
    (breakpoint.kinds && breakpoint.kinds.length > 0) ||
      breakpoint.toolName ||
      breakpoint.filePath ||
      breakpoint.onError
  );
}

// ── Execution log ───────────────────────────────────────────────────────────

/** One recorded event with everything needed to debug it, in one place. */
export interface DebugLogEntry {
  /** 0-based position in the recorded stream. */
  seq: number;
  event: AgentEvent;
  /** The timeline step this event opened or updated, when it maps to one. */
  step: TimelineStep | null;
  /** The breakpoint this event tripped, when it did. */
  hit?: Breakpoint;
}

// ── Session state snapshot (variable inspection) ────────────────────────────

/** The agent's accumulated state at one point in the execution. */
export interface DebugSnapshot {
  /** Events folded into this snapshot. */
  eventCount: number;
  reasoning: string;
  content: string;
  toolCalls: ToolCallInspection[];
  filesChanged: string[];
  inputUnits: number;
  outputUnits: number;
  /** Integer minor units at the receipt scale — string math, never floats. */
  costMinor: string;
}

/**
 * Fold `events` (at most `count` of them) into a session-state snapshot.
 * `usage.updated` events carry cumulative per-turn totals, so each turn
 * contributes its latest seen values; cross-turn totals sum per turn.
 */
export function snapshotEvents(events: AgentEvent[], count = events.length): DebugSnapshot {
  const timeline = new AgentTimeline();
  const usageByTurn = new Map<string, { inputUnits: number; outputUnits: number; costMinor: bigint }>();
  const filesChanged: string[] = [];
  let reasoning = '';
  let content = '';

  for (const event of events.slice(0, count)) {
    timeline.record(event);
    switch (event.type) {
      case 'reasoning.delta':
        reasoning += event.delta;
        break;
      case 'content.delta':
        content += event.content;
        break;
      case 'file.diff':
        if (!filesChanged.includes(event.filePath)) filesChanged.push(event.filePath);
        break;
      case 'usage.updated':
        usageByTurn.set(event.turnId, {
          inputUnits: event.inputUnits,
          outputUnits: event.outputUnits,
          costMinor: BigInt(event.costMinor),
        });
        break;
      default:
        break;
    }
  }

  let inputUnits = 0;
  let outputUnits = 0;
  let costMinor = 0n;
  for (const usage of usageByTurn.values()) {
    inputUnits += usage.inputUnits;
    outputUnits += usage.outputUnits;
    costMinor += usage.costMinor;
  }

  const toolCalls = timeline
    .getSteps()
    .filter((step) => step.toolCall)
    .map((step) => step.toolCall!);

  return {
    eventCount: Math.min(count, events.length),
    reasoning,
    content,
    toolCalls,
    filesChanged,
    inputUnits,
    outputUnits,
    costMinor: costMinor.toString(),
  };
}

// ── Debugger ────────────────────────────────────────────────────────────────

export type DebuggerStatus = 'idle' | 'running' | 'paused';
export type ResumeAction = 'continue' | 'step';

/** What `run()` yields: every event, flagged when it tripped a breakpoint. */
export interface DebugYield {
  entry: DebugLogEntry;
  /** Set when execution paused on this entry. */
  hit?: Breakpoint;
}

let breakpointSeq = 0;

/**
 * The interactive debugger for one agent session. Feed events live with
 * `run(stream)` (pauses at breakpoints) or `record(event)` (no pausing), or
 * rebuild a finished session from the durable store with `hydrateFromStore`.
 */
export class AgentDebugger {
  private readonly timeline: AgentTimeline;
  private readonly profiler = new AgentProfiler();
  private readonly events: AgentEvent[] = [];
  private readonly log: DebugLogEntry[] = [];
  private readonly breakpoints = new Map<string, Breakpoint>();

  private status: DebuggerStatus = 'idle';
  /** When set, the paused `run()` waits for this to be called. */
  private resumeWaiter: ((action: ResumeAction) => void) | null = null;
  /** A resume issued between the pause yield and the waiter being set. */
  private queuedAction: ResumeAction | null = null;
  /** Breakpoint/step pairs that already tripped — a step trips once per bp. */
  private readonly tripped = new Set<string>();
  /** Step mode pauses again on the next recorded step. */
  private stepMode = false;
  private pauseRequested = false;

  constructor(options: { workspaceRoot?: string } = {}) {
    this.timeline = new AgentTimeline({ workspaceRoot: options.workspaceRoot });
  }

  // ── Recording ────────────────────────────────────────────────────────────

  /**
   * Fold one event into the debugger: execution log, timeline, profiler, and
   * breakpoint matching. Returns the log entry (with `hit` set on a trip).
   */
  record(event: AgentEvent): DebugLogEntry {
    this.events.push(event);
    this.profiler.record(event);
    const step = this.timeline.record(event);
    const entry: DebugLogEntry = { seq: this.log.length, event, step };
    if (step) {
      const hit = this.findHit(step);
      if (hit) {
        this.tripped.add(`${hit.id}:${step.stepId}`);
        hit.hits += 1;
        entry.hit = hit;
      }
    }
    this.log.push(entry);
    return entry;
  }

  /**
   * Debug a live event stream. Yields every recorded event; when a breakpoint
   * trips (or `pause()` was requested) the generator blocks after yielding
   * until the operator calls `resume('continue')` or `resume('step')`.
   */
  async *run(stream: AsyncIterable<AgentEvent>): AsyncGenerator<DebugYield> {
    this.status = 'running';
    try {
      for await (const event of stream) {
        const entry = this.record(event);
        // Step mode pauses at the next step-producing event (deltas that only
        // update an open step count — every recorded event maps to a step).
        const shouldPause =
          entry.hit !== undefined || this.pauseRequested || (this.stepMode && entry.step !== null);
        if (shouldPause) {
          this.status = 'paused';
          this.pauseRequested = false;
          yield { entry, hit: entry.hit };
          const action = await this.waitForResume();
          // 'step' pauses again at the next step; 'continue' runs to the next hit.
          this.stepMode = action === 'step';
          this.status = 'running';
        } else {
          yield { entry };
        }
      }
    } finally {
      this.status = 'idle';
      this.stepMode = false;
      this.queuedAction = null;
      this.resumeWaiter?.('continue');
      this.resumeWaiter = null;
    }
  }

  /** Resume a paused `run()`: `continue` to the next hit, `step` one step. */
  resume(action: ResumeAction = 'continue'): void {
    if (this.resumeWaiter) {
      const waiter = this.resumeWaiter;
      this.resumeWaiter = null;
      waiter(action);
    } else if (this.status === 'paused') {
      // The pause yield reached the consumer before the generator parked on
      // its waiter — queue the action so the waiter resolves immediately.
      this.queuedAction = action;
    }
  }

  /** Ask a running `run()` to pause at the next recorded step. */
  pause(): void {
    this.pauseRequested = true;
  }

  getStatus(): DebuggerStatus {
    return this.status;
  }

  // ── Breakpoints ──────────────────────────────────────────────────────────

  addBreakpoint(spec: BreakpointSpec): Breakpoint {
    breakpointSeq += 1;
    const breakpoint: Breakpoint = { id: `bp_${breakpointSeq}`, enabled: true, hits: 0, ...spec };
    this.breakpoints.set(breakpoint.id, breakpoint);
    return breakpoint;
  }

  removeBreakpoint(id: string): boolean {
    return this.breakpoints.delete(id);
  }

  setBreakpointEnabled(id: string, enabled: boolean): Breakpoint | null {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) return null;
    breakpoint.enabled = enabled;
    return breakpoint;
  }

  listBreakpoints(): Breakpoint[] {
    return [...this.breakpoints.values()];
  }

  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  // ── Inspection ───────────────────────────────────────────────────────────

  getLog(): DebugLogEntry[] {
    return [...this.log];
  }

  getTimeline(): AgentTimeline {
    return this.timeline;
  }

  getProfiler(): AgentProfiler {
    return this.profiler;
  }

  getProfile(): AgentProfileReport {
    return this.profiler.getReport();
  }

  /** The session state as it stands now (variable inspection). */
  inspectState(): DebugSnapshot {
    return snapshotEvents(this.events);
  }

  /** The session state as it stood after `count` recorded events. */
  inspectAt(count: number): DebugSnapshot {
    return snapshotEvents(this.events, count);
  }

  /** Everything recorded about one step: log entry plus state at that point. */
  inspectStep(stepId: string): { entry: DebugLogEntry; state: DebugSnapshot } | null {
    const entry = this.log.find((e) => e.step?.stepId === stepId);
    if (!entry) return null;
    return { entry, state: this.inspectAt(entry.seq + 1) };
  }

  /** Rebuild the debugger view of a finished session from the durable store. */
  static hydrateFromStore(
    store: RuntimeStore,
    sessionId: string,
    options: { workspaceRoot?: string } = {}
  ): AgentDebugger {
    const sessionDebugger = new AgentDebugger(options);
    for (const row of store.listEvents(sessionId)) {
      try {
        sessionDebugger.record(JSON.parse(row.payload) as AgentEvent);
      } catch {
        // A corrupt event row must not break the whole debug session.
      }
    }
    return sessionDebugger;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private findHit(step: TimelineStep): Breakpoint | undefined {
    for (const breakpoint of this.breakpoints.values()) {
      if (!breakpoint.enabled || !matchesBreakpoint(step, breakpoint)) continue;
      // A step trips a breakpoint once — update events (started/output) fold
      // into the same step and must not re-trip it.
      if (!this.tripped.has(`${breakpoint.id}:${step.stepId}`)) return breakpoint;
    }
    return undefined;
  }

  private waitForResume(): Promise<ResumeAction> {
    if (this.queuedAction) {
      const action = this.queuedAction;
      this.queuedAction = null;
      return Promise.resolve(action);
    }
    return new Promise((resolve) => {
      this.resumeWaiter = resolve;
    });
  }
}

// ── CLI text rendering ──────────────────────────────────────────────────────

/** One terminal line for a breakpoint: id, conditions, hit count. */
export function formatBreakpoint(breakpoint: Breakpoint): string {
  const conditions: string[] = [];
  if (breakpoint.kinds && breakpoint.kinds.length > 0) {
    conditions.push(`kind=${breakpoint.kinds.join('|')}`);
  }
  if (breakpoint.toolName) conditions.push(`tool=${breakpoint.toolName}`);
  if (breakpoint.filePath) conditions.push(`file=${breakpoint.filePath}`);
  if (breakpoint.onError) conditions.push('on error');
  const disabled = breakpoint.enabled ? '' : ' [disabled]';
  return `${breakpoint.id}: ${conditions.join(', ') || '(no conditions)'}${disabled} — ${breakpoint.hits} hits`;
}

/** Render the breakpoint list as terminal text. */
export function renderBreakpoints(breakpoints: Breakpoint[]): string {
  if (breakpoints.length === 0) return '(no breakpoints set)';
  return breakpoints.map(formatBreakpoint).join('\n');
}

/** Render the execution log as terminal text, one line per event. */
export function renderDebugLog(entries: DebugLogEntry[]): string {
  if (entries.length === 0) return '(nothing recorded yet)';
  return entries
    .map((entry) => {
      const title = entry.step ? entry.step.title : entry.event.type;
      const hit = entry.hit ? ` [BREAK ${entry.hit.id}]` : '';
      return `#${entry.seq} ${entry.event.timestamp} ${entry.event.type}: ${title}${hit}`;
    })
    .join('\n');
}

/** `12.340000` from integer minor units at the receipt scale (default 6). */
export function formatSnapshotCost(costMinor: string, scale = 6): string {
  const negative = costMinor.startsWith('-');
  const digits = (negative ? costMinor.slice(1) : costMinor).padStart(scale + 1, '0');
  const major = digits.slice(0, -scale) || '0';
  const minor = digits.slice(-scale);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

/** Render a state snapshot (variable inspection) as terminal text. */
export function renderSnapshot(snapshot: DebugSnapshot): string {
  const lines: string[] = [];
  lines.push(
    `State after ${snapshot.eventCount} events · ` +
      `${snapshot.inputUnits} in / ${snapshot.outputUnits} out · ` +
      `$${formatSnapshotCost(snapshot.costMinor)}`
  );
  if (snapshot.reasoning) lines.push(`Reasoning: ${snapshot.reasoning.length} chars`);
  if (snapshot.content) lines.push(`Content: ${snapshot.content}`);
  if (snapshot.toolCalls.length > 0) {
    lines.push('Tool calls:');
    for (const call of snapshot.toolCalls) {
      const target = call.filePath ?? call.command ?? '';
      const result = call.isError ? ' (error)' : '';
      lines.push(`  ${call.toolName} ${target} [${call.status}]${result}`.trimEnd());
    }
  }
  if (snapshot.filesChanged.length > 0) {
    lines.push(`Files changed: ${snapshot.filesChanged.join(', ')}`);
  }
  return lines.join('\n');
}
