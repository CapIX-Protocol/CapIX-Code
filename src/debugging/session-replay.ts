/**
 * src/debugging/session-replay — record and replay agent sessions.
 *
 * A `SessionRecorder` captures the raw event stream (live, or rebuilt from
 * the durable store) into a portable `SessionRecording`. A `SessionReplay`
 * then drives that recording like tape:
 *
 * - Step-through: `next()` / `prev()` / `seek()` move a cursor one event at a
 *   time and return a `ReplayFrame` — the event, the timeline step it
 *   touched, and the session state at that point.
 * - Inspect state at any point: `snapshotAt(index)` folds the recording up
 *   to any event into a `DebugSnapshot` (reasoning, content, tool calls with
 *   args and results, files changed, tokens and cost).
 * - Export for analysis: `exportSession()` renders the recording as JSON,
 *   JSON-lines, or a Markdown report; recordings round-trip through
 *   `save()` / `SessionReplay.load()`.
 *
 * The snapshot semantics are shared with the debugger
 * (`src/debugging/agent-debugger.ts`) so replaying a session and debugging it
 * live answer the same questions the same way.
 */

import { readFile, writeFile } from 'node:fs/promises';

import {
  AgentTimeline,
  type AgentEvent,
  type RuntimeStore,
  type TimelineStep,
} from '@capix/agent-runtime';
import {
  formatSnapshotCost,
  snapshotEvents,
  type DebugSnapshot,
} from './agent-debugger.js';

export const SESSION_RECORDING_VERSION = 1 as const;

/** A portable capture of one agent session's event stream. */
export interface SessionRecording {
  version: typeof SESSION_RECORDING_VERSION;
  sessionId: string;
  recordedAt: string;
  workspaceRoot?: string;
  events: AgentEvent[];
}

/** One position in a replay: the event, its timeline step, the state there. */
export interface ReplayFrame {
  /** 0-based index into the recording. */
  index: number;
  event: AgentEvent;
  /** The timeline step this event opened or updated, when it maps to one. */
  step: TimelineStep | null;
  /** Session state immediately after this event. */
  state: DebugSnapshot;
}

/** Records an agent session's event stream into a portable recording. */
export class SessionRecorder {
  private readonly events: AgentEvent[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly workspaceRoot?: string
  ) {}

  /** Tap a live runtime event stream: record while passing events through. */
  async *tee(stream: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of stream) {
      this.record(event);
      yield event;
    }
  }

  record(event: AgentEvent): void {
    this.events.push(event);
  }

  getRecording(): SessionRecording {
    return {
      version: SESSION_RECORDING_VERSION,
      sessionId: this.sessionId,
      recordedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      events: [...this.events],
    };
  }

  /** Persist the recording as JSON. */
  async save(filePath: string): Promise<SessionRecording> {
    const recording = this.getRecording();
    await writeFile(filePath, JSON.stringify(recording, null, 2), 'utf8');
    return recording;
  }

  /** Rebuild a recording of a past session from the durable store. */
  static fromStore(store: RuntimeStore, sessionId: string, workspaceRoot?: string): SessionRecording {
    const events: AgentEvent[] = [];
    for (const row of store.listEvents(sessionId)) {
      try {
        events.push(JSON.parse(row.payload) as AgentEvent);
      } catch {
        // A corrupt event row must not break the whole recording.
      }
    }
    return {
      version: SESSION_RECORDING_VERSION,
      sessionId,
      recordedAt: new Date().toISOString(),
      workspaceRoot,
      events,
    };
  }
}

/**
 * Step-through replay of a recorded session. The cursor starts before the
 * first event; `next()` / `prev()` / `seek()` move it and return the frame
 * there (or `null` when moving past either end).
 */
export class SessionReplay {
  private cursor = -1;
  /**
   * Timeline folded up to `cursor`. Forward moves fold incrementally;
   * backward moves and seeks re-fold from the start.
   */
  private timeline = new AgentTimeline();

  constructor(private readonly recording: SessionRecording) {}

  /** Load a recording saved by `SessionRecorder.save()`. */
  static async load(filePath: string): Promise<SessionReplay> {
    const raw = await readFile(filePath, 'utf8');
    return new SessionReplay(JSON.parse(raw) as SessionRecording);
  }

  /** Replay a past session straight from the durable store. */
  static fromStore(store: RuntimeStore, sessionId: string, workspaceRoot?: string): SessionReplay {
    return new SessionReplay(SessionRecorder.fromStore(store, sessionId, workspaceRoot));
  }

  get length(): number {
    return this.recording.events.length;
  }

  /** Current cursor position (-1 = before the first event). */
  get position(): number {
    return this.cursor;
  }

  getRecording(): SessionRecording {
    return this.recording;
  }

  /** Advance one event; `null` when already at the end. */
  next(): ReplayFrame | null {
    if (this.cursor + 1 >= this.recording.events.length) return null;
    this.cursor += 1;
    const event = this.recording.events[this.cursor]!;
    const step = this.timeline.record(event);
    return { index: this.cursor, event, step, state: this.snapshotAt(this.cursor) };
  }

  /** Step back one event; `null` when already before the first event. */
  prev(): ReplayFrame | null {
    if (this.cursor < 0) return null;
    return this.seek(this.cursor - 1);
  }

  /** Move the cursor to `index` (clamped to the recording; -1 = start). */
  seek(index: number): ReplayFrame | null {
    const target = Math.max(-1, Math.min(index, this.recording.events.length - 1));
    if (target < this.cursor) {
      this.timeline = new AgentTimeline();
      for (let i = 0; i <= target; i++) this.timeline.record(this.recording.events[i]!);
    } else {
      for (let i = this.cursor + 1; i <= target; i++) {
        this.timeline.record(this.recording.events[i]!);
      }
    }
    this.cursor = target;
    if (target < 0) return null;
    return this.frameAt(target);
  }

  /** Session state immediately after event `index` (variable inspection). */
  snapshotAt(index: number): DebugSnapshot {
    return snapshotEvents(this.recording.events, index + 1);
  }

  /** The full timeline folded to the current cursor position. */
  getTimeline(): AgentTimeline {
    return this.timeline;
  }

  /**
   * Auto-paced replay from the cursor to the end — pull-driven per frame, or
   * self-paced when `stepDelayMs` is set.
   */
  async *replay(options: { stepDelayMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<ReplayFrame> {
    let frame = this.next();
    while (frame) {
      if (options.signal?.aborted) return;
      yield frame;
      if (options.stepDelayMs && this.cursor < this.recording.events.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.stepDelayMs));
      }
      frame = this.next();
    }
  }

  /** Export the recording for analysis: JSON, JSON-lines, or Markdown. */
  exportSession(format: 'json' | 'jsonl' | 'markdown' = 'json'): string {
    switch (format) {
      case 'json':
        return JSON.stringify(this.recording, null, 2);
      case 'jsonl':
        return this.recording.events.map((event) => JSON.stringify(event)).join('\n');
      case 'markdown':
        return renderSessionMarkdown(this.recording);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private frameAt(index: number): ReplayFrame {
    const event = this.recording.events[index]!;
    return {
      index,
      event,
      step: this.timeline.getSteps().find((step) => step.stepId === event.eventId) ?? null,
      state: this.snapshotAt(index),
    };
  }
}

/** Render a recording as a Markdown analysis report. */
export function renderSessionMarkdown(recording: SessionRecording): string {
  const state = snapshotEvents(recording.events);
  const timeline = new AgentTimeline();
  for (const event of recording.events) timeline.record(event);

  const lines: string[] = [];
  lines.push(`# Agent session ${recording.sessionId}`);
  lines.push('');
  lines.push(`- Recorded: ${recording.recordedAt}`);
  if (recording.workspaceRoot) lines.push(`- Workspace: ${recording.workspaceRoot}`);
  lines.push(
    `- Totals: ${state.inputUnits} in / ${state.outputUnits} out · ` +
      `$${formatSnapshotCost(state.costMinor)} · ${state.toolCalls.length} tool calls · ` +
      `${state.filesChanged.length} files changed`
  );
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  for (const step of timeline.getSteps()) {
    const rolledBack = step.rolledBack ? ' (rolled back)' : '';
    lines.push(`1. **${step.title}**${rolledBack} — ${step.explanation}`);
  }
  if (state.toolCalls.length > 0) {
    lines.push('');
    lines.push('## Tool calls');
    lines.push('');
    for (const call of state.toolCalls) {
      const target = call.filePath ?? call.command ?? '';
      lines.push(
        `- \`${call.toolName}\` ${target} [${call.status}]${call.isError ? ' (error)' : ''}`.trimEnd()
      );
    }
  }
  return lines.join('\n');
}
