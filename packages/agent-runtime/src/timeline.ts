/**
 * @capix/agent-runtime — real-time agent execution timeline.
 *
 * Folds the streaming event protocol (`events.ts`) into an ordered,
 * inspectable timeline of everything the agent did:
 *
 * - Tool call inspection: every tool call is one step carrying what file it
 *   touched, what command it ran, its arguments, and what came back.
 * - Decision explanations: each step carries a plain-language `explanation`
 *   of why it happened — the model requested it, the mode policy allowed it,
 *   the operator approved or rejected it (with the recorded reason).
 * - Rollback: any file-changing step can be reverted (`rollbackStep`) — the
 *   recorded before-image is written back (a file the agent created is
 *   removed). Rolling back a change that a later, still-active change builds
 *   on fails with a `conflict` problem instead of silently corrupting work.
 * - Step-by-step replay: `replay()` re-yields the recorded steps in order —
 *   pull-driven (the consumer steps at its own pace) or auto-paced with
 *   `stepDelayMs`.
 *
 * The class is UI-free: the same instance feeds the Capix Code TUI
 * (`src/observability/`) and the CapixIDE timeline panel. Feed it live with
 * `record(event)` as events stream by, or rebuild a past session from the
 * durable store with `hydrate()`.
 */

import { rm, writeFile } from 'node:fs/promises';

import type {
  AgentEvent,
  CheckpointCreatedEvent,
  FileDiffEvent,
  ToolOutputEvent,
  ToolRejectedEvent,
  ToolRequestedEvent,
} from './events.js';
import { CapixAgentError, CAPIX_ERROR_CODES, type CapixProblemDetail } from './contracts.js';
import type { RuntimeStore } from './store.js';
import { resolveWorkspacePath } from './tools.js';

export type TimelineStepKind =
  | 'turn'
  | 'reasoning'
  | 'content'
  | 'tool_call'
  | 'file_change'
  | 'checkpoint'
  | 'error';

export type ToolCallStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed';

/** Everything there is to know about one tool call, in one place. */
export interface ToolCallInspection {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** The file the call reads or writes, when its args name one. */
  filePath?: string;
  /** The shell command the call runs, when its args carry one. */
  command?: string;
  status: ToolCallStatus;
  /** Why the permission pipeline allowed/asked/denied, or the operator gave. */
  decisionReason?: string;
  requiresApproval: boolean;
  output?: string;
  isError?: boolean;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface FileChangeDetail {
  filePath: string;
  before: string;
  after: string;
  diff: string;
  /** The tool call that produced this change, when known. */
  toolCallId?: string;
}

export interface TimelineStep {
  /** Stable id — the eventId of the event that opened the step. */
  stepId: string;
  sessionId: string;
  turnId: string;
  kind: TimelineStepKind;
  timestamp: string;
  /** One-line summary for lists. */
  title: string;
  /** Plain-language reason this step happened. */
  explanation: string;
  /** Longer text (reasoning trace, assistant content, tool output). */
  detail?: string;
  toolCall?: ToolCallInspection;
  fileChange?: FileChangeDetail;
  checkpointId?: string;
  rolledBack: boolean;
  rolledBackAt?: string;
}

export interface TimelineOptions {
  /** Workspace root used to resolve file paths on rollback. */
  workspaceRoot?: string;
}

function problem(
  status: number,
  capixCode: string,
  title: string,
  detail: string
): CapixAgentError {
  const problemDetail: CapixProblemDetail = {
    type: `https://capix.network/problems/${capixCode}`,
    title,
    status,
    detail,
    capixCode,
  };
  return new CapixAgentError(problemDetail);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const filePath = typeof args.path === 'string' ? args.path : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  if (filePath) return `${toolName} ${filePath}`;
  if (command) return `${toolName}: ${truncate(command, 60)}`;
  return toolName;
}

/**
 * The execution timeline for one agent session. Steps are kept in event
 * order; tool events that arrive as a request → approval → output sequence
 * fold into a single `tool_call` step that grows as the call progresses.
 */
export class AgentTimeline {
  private readonly steps: TimelineStep[] = [];
  private readonly byStepId = new Map<string, TimelineStep>();
  private readonly byToolCallId = new Map<string, TimelineStep>();
  /** Reasoning/content deltas aggregate into one step per turn. */
  private readonly reasoningByTurn = new Map<string, TimelineStep>();
  private readonly contentByTurn = new Map<string, TimelineStep>();
  /** Tools run serially in the runtime, so started/output/diff events — which
   * carry no toolCallId — attach to the most recently requested open call. */
  private activeToolCallId: string | null = null;

  constructor(private readonly options: TimelineOptions = {}) {}

  /** Fold one streamed event into the timeline. Returns the step touched. */
  record(event: AgentEvent): TimelineStep | null {
    switch (event.type) {
      case 'turn.started':
        return this.addStep(event, 'turn', 'Turn started', 'The operator sent a message.');

      case 'reasoning.delta': {
        let step = this.reasoningByTurn.get(event.turnId);
        if (!step) {
          step = this.addStep(event, 'reasoning', 'Reasoning', 'The model reasoned before acting.');
          this.reasoningByTurn.set(event.turnId, step);
        }
        step.detail = (step.detail ?? '') + event.delta;
        step.title = `Reasoning (${step.detail.length} chars)`;
        return step;
      }

      case 'content.delta': {
        let step = this.contentByTurn.get(event.turnId);
        if (!step) {
          step = this.addStep(event, 'content', 'Assistant response', 'The model replied.');
          this.contentByTurn.set(event.turnId, step);
        }
        step.detail = (step.detail ?? '') + event.content;
        return step;
      }

      case 'tool.requested':
        return this.recordToolRequested(event);

      case 'tool.approved': {
        const step = this.byToolCallId.get(event.toolCallId);
        if (step?.toolCall) {
          step.toolCall.status = 'approved';
          if (!step.toolCall.requiresApproval) {
            step.explanation = `${step.explanation} Allowed by the permission policy.`;
          }
        }
        return step ?? null;
      }

      case 'tool.rejected':
        return this.recordToolRejected(event);

      case 'tool.started': {
        const step = this.activeStep();
        if (step?.toolCall) {
          step.toolCall.status = 'running';
          step.toolCall.startedAt = event.timestamp;
        }
        return step ?? null;
      }

      case 'tool.output':
        return this.recordToolOutput(event);

      case 'file.diff':
        return this.recordFileDiff(event);

      case 'checkpoint.created':
        return this.recordCheckpoint(event);

      case 'turn.completed':
        return this.addStep(
          event,
          'turn',
          `Turn completed (${event.finishReason})`,
          `The turn finished: ${event.finishReason}.`
        );

      case 'turn.failed':
        return this.addStep(
          event,
          'error',
          `Turn failed: ${event.error.capixCode}`,
          `The turn failed with ${event.error.capixCode} (${event.error.retryClass}).`,
          event.error.message
        );

      default:
        // usage/route/settlement events are the profiler's concern, not the
        // operator-facing timeline's.
        return null;
    }
  }

  /** All steps in event order (live references — updated as events arrive). */
  getSteps(): TimelineStep[] {
    return [...this.steps];
  }

  getStep(stepId: string): TimelineStep | null {
    return this.byStepId.get(stepId) ?? null;
  }

  /** Inspect one tool call: file, command, args, decision, result. */
  inspectToolCall(toolCallId: string): ToolCallInspection | null {
    return this.byToolCallId.get(toolCallId)?.toolCall ?? null;
  }

  /**
   * Roll back a file-changing step: write the recorded before-image back to
   * the workspace (or delete the file when the step created it). Refuses with
   * a `conflict` problem when a later change to the same file is still active.
   */
  async rollbackStep(stepId: string): Promise<TimelineStep> {
    const step = this.byStepId.get(stepId);
    if (!step || step.kind !== 'file_change' || !step.fileChange) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Step not found',
        `no file-changing step: ${stepId}`
      );
    }
    if (step.rolledBack) return step;
    if (!this.options.workspaceRoot) {
      throw problem(
        409,
        CAPIX_ERROR_CODES.CONFLICT,
        'Rollback unavailable',
        'no workspace root configured for this timeline'
      );
    }

    const filePath = step.fileChange.filePath;
    const laterActive = this.steps
      .slice(this.steps.indexOf(step) + 1)
      .find((s) => s.kind === 'file_change' && !s.rolledBack && s.fileChange?.filePath === filePath);
    if (laterActive) {
      throw problem(
        409,
        CAPIX_ERROR_CODES.CONFLICT,
        'Rollback conflict',
        `${filePath} has a later change (${laterActive.stepId}) — roll that back first`
      );
    }

    const absolute = resolveWorkspacePath(this.options.workspaceRoot, filePath);
    if (step.fileChange.before === '') {
      // The step created the file; rolling back removes it.
      await rm(absolute, { force: true });
    } else {
      await writeFile(absolute, step.fileChange.before, 'utf8');
    }
    step.rolledBack = true;
    step.rolledBackAt = new Date().toISOString();
    step.title = `${step.title} (rolled back)`;
    return step;
  }

  /** Roll back every file change a tool call produced, newest first. */
  async rollbackToolCall(toolCallId: string): Promise<TimelineStep[]> {
    const changes = this.steps
      .filter((s) => s.kind === 'file_change' && s.fileChange?.toolCallId === toolCallId)
      .reverse();
    const rolledBack: TimelineStep[] = [];
    for (const step of changes) rolledBack.push(await this.rollbackStep(step.stepId));
    return rolledBack;
  }

  /**
   * Step-by-step replay of the recorded timeline. The generator is
   * pull-driven — each `next()` advances one step — or self-paced when
   * `stepDelayMs` is set. Pass `fromStepId` to resume mid-timeline.
   */
  async *replay(options: {
    stepDelayMs?: number;
    fromStepId?: string;
    signal?: AbortSignal;
    onStep?: (step: TimelineStep, index: number, total: number) => void;
  } = {}): AsyncGenerator<TimelineStep> {
    let steps = this.getSteps();
    if (options.fromStepId) {
      const at = steps.findIndex((s) => s.stepId === options.fromStepId);
      if (at === -1) {
        throw problem(
          404,
          CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
          'Step not found',
          `no step: ${options.fromStepId}`
        );
      }
      steps = steps.slice(at);
    }
    for (let i = 0; i < steps.length; i++) {
      if (options.signal?.aborted) return;
      const step = steps[i]!;
      options.onStep?.(step, i, steps.length);
      yield step;
      if (options.stepDelayMs && i < steps.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.stepDelayMs));
      }
    }
  }

  /**
   * Rebuild the timeline of a past session from the durable store. Event
   * payloads replay through `record`; the tool_calls table then enriches each
   * inspection with its persisted status, decision reason, and output.
   */
  hydrate(store: RuntimeStore, sessionId: string): void {
    for (const row of store.listEvents(sessionId)) {
      try {
        this.record(JSON.parse(row.payload) as AgentEvent);
      } catch {
        // A corrupt event row must not break the whole timeline.
      }
    }
    for (const row of store.listToolCalls(sessionId)) {
      const step = this.byToolCallId.get(row.tool_call_id);
      if (!step?.toolCall) continue;
      step.toolCall.status = row.status as ToolCallStatus;
      step.toolCall.decisionReason = row.decision_reason ?? undefined;
      step.toolCall.output = row.output ?? undefined;
      step.toolCall.isError = row.is_error === 1;
      step.toolCall.completedAt = row.completed_at ?? undefined;
      if (row.decision_reason) {
        step.explanation = `${step.explanation} (${row.decision_reason})`;
      }
    }
  }

  /** Rebuild a session timeline straight from the store. */
  static hydrateFromStore(
    store: RuntimeStore,
    sessionId: string,
    options: TimelineOptions = {}
  ): AgentTimeline {
    const timeline = new AgentTimeline(options);
    timeline.hydrate(store, sessionId);
    return timeline;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private addStep(
    event: AgentEvent,
    kind: TimelineStepKind,
    title: string,
    explanation: string,
    detail?: string
  ): TimelineStep {
    const step: TimelineStep = {
      stepId: event.eventId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      kind,
      timestamp: event.timestamp,
      title,
      explanation,
      detail,
      rolledBack: false,
    };
    this.steps.push(step);
    this.byStepId.set(step.stepId, step);
    return step;
  }

  private activeStep(): TimelineStep | null {
    return this.activeToolCallId ? (this.byToolCallId.get(this.activeToolCallId) ?? null) : null;
  }

  private recordToolRequested(event: ToolRequestedEvent): TimelineStep {
    const filePath = typeof event.args.path === 'string' ? event.args.path : undefined;
    const command = typeof event.args.command === 'string' ? event.args.command : undefined;
    const inspection: ToolCallInspection = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      filePath,
      command,
      status: 'requested',
      requiresApproval: event.requiresApproval,
      requestedAt: event.timestamp,
    };
    const step = this.addStep(
      event,
      'tool_call',
      summarizeArgs(event.toolName, event.args),
      event.requiresApproval
        ? `The model requested ${event.toolName}; waiting for operator approval.`
        : `The model requested ${event.toolName}.`
    );
    step.toolCall = inspection;
    this.byToolCallId.set(event.toolCallId, step);
    this.activeToolCallId = event.toolCallId;
    return step;
  }

  private recordToolRejected(event: ToolRejectedEvent): TimelineStep | null {
    const step = this.byToolCallId.get(event.toolCallId);
    if (!step?.toolCall) return null;
    step.toolCall.status = 'rejected';
    step.toolCall.decisionReason = event.reason;
    step.toolCall.completedAt = event.timestamp;
    step.toolCall.isError = true;
    step.explanation = `Rejected: ${event.reason}.`;
    if (this.activeToolCallId === event.toolCallId) this.activeToolCallId = null;
    return step;
  }

  private recordToolOutput(event: ToolOutputEvent): TimelineStep | null {
    const step = this.activeStep();
    if (!step?.toolCall) return null;
    step.toolCall.status = event.isError ? 'failed' : 'completed';
    step.toolCall.output = event.output;
    step.toolCall.isError = event.isError;
    step.toolCall.completedAt = event.timestamp;
    step.detail = event.output;
    if (event.isError) {
      step.title = `${step.title} ✗`;
      step.explanation = `${step.explanation} The call failed.`;
    }
    this.activeToolCallId = null;
    return step;
  }

  private recordFileDiff(event: FileDiffEvent): TimelineStep {
    const added = event.diff.split('\n').filter((l) => l.startsWith('+')).length;
    const removed = event.diff.split('\n').filter((l) => l.startsWith('-')).length;
    const created = event.before === '';
    const step = this.addStep(
      event,
      'file_change',
      `${created ? 'created' : 'changed'} ${event.filePath} (+${added}/-${removed})`,
      created
        ? `A tool call created ${event.filePath}.`
        : `A tool call modified ${event.filePath}.`
    );
    step.fileChange = {
      filePath: event.filePath,
      before: event.before,
      after: event.after,
      diff: event.diff,
      toolCallId: this.activeToolCallId ?? undefined,
    };
    return step;
  }

  private recordCheckpoint(event: CheckpointCreatedEvent): TimelineStep {
    const step = this.addStep(
      event,
      'checkpoint',
      `checkpoint ${event.checkpointId} (${event.filePaths.length} files)`,
      `The runtime checkpointed ${event.filePaths.length} file(s) before continuing.`
    );
    step.checkpointId = event.checkpointId;
    return step;
  }
}
