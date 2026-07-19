/**
 * @capix/agent-runtime — agent performance profiler.
 *
 * Folds the streaming event protocol (`events.ts`) into a performance profile
 * of a session:
 *
 * - Execution time per tool: every call's wall time (requested/started →
 *   output) and per-tool aggregates (calls, failures, total/avg/max ms).
 * - Token usage per step: `usage.updated` events carry cumulative per-turn
 *   totals, so the profiler derives each model round's delta and attributes
 *   it to the action that round triggered — the tool call the model asked for
 *   next. Usage from the final round (the model replied with text, no tool
 *   call) is attributed to the turn's assistant-response step.
 * - Cost breakdown per action: the same attribution carries integer minor
 *   units (string math, BigInt — never floats) so every step shows what it
 *   cost.
 * - Bottleneck identification: slow tools dominating tool time, steps
 *   dominating token/cost spend, and flaky tools with high failure rates
 *   surface as ranked `Bottleneck`s.
 *
 * Like the timeline, the profiler is UI-free and shared by the Capix Code TUI
 * (`src/observability/`) and the CapixIDE timeline panel. Feed it live with
 * `record(event)` or rebuild from the durable store with `hydrate()`.
 */

import type { AgentEvent, UsageUpdatedEvent } from './events.js';
import type { RuntimeStore } from './store.js';

export interface ProfileStepMetric {
  /** toolCallId for tool steps, eventId for model steps. */
  stepKey: string;
  kind: 'tool' | 'model';
  /** Tool name, or `assistant response` for the closing model round. */
  label: string;
  turnId: string;
  durationMs: number | null;
  inputUnits: number;
  outputUnits: number;
  costMinor: string;
  isError: boolean;
  timestamp: string;
}

export interface ToolProfile {
  toolName: string;
  calls: number;
  failures: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  inputUnits: number;
  outputUnits: number;
  costMinor: string;
}

export type BottleneckKind = 'slow_tool' | 'token_heavy' | 'cost_heavy' | 'flaky_tool';

export interface Bottleneck {
  kind: BottleneckKind;
  /** Tool name or step label the bottleneck points at. */
  subject: string;
  /** Plain-language finding. */
  detail: string;
  /** Share of the relevant total (tool time, tokens, or cost), 0–100. */
  sharePct: number;
}

export interface AgentProfileReport {
  totalDurationMs: number;
  totalInputUnits: number;
  totalOutputUnits: number;
  totalCostMinor: string;
  toolCalls: number;
  failedToolCalls: number;
  tools: ToolProfile[];
  steps: ProfileStepMetric[];
  bottlenecks: Bottleneck[];
}

interface Usage {
  inputUnits: number;
  outputUnits: number;
  costMinor: bigint;
}

interface PendingTool {
  step: ProfileStepMetric;
  requestedAt: string;
  startedAt?: string;
}

const ZERO_USAGE: Usage = { inputUnits: 0, outputUnits: 0, costMinor: 0n };

function isZero(usage: Usage): boolean {
  return usage.inputUnits === 0 && usage.outputUnits === 0 && usage.costMinor === 0n;
}

function msBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** A tool that eats at least this share of total tool time is a bottleneck. */
const SLOW_TOOL_SHARE = 0.4;
/** A step that eats at least this share of session tokens or cost is one too. */
const HEAVY_STEP_SHARE = 0.5;
/** Failure rate (with at least this many calls) that flags a flaky tool. */
const FLAKY_MIN_CALLS = 2;
const FLAKY_FAILURE_RATE = 0.5;

export class AgentProfiler {
  private readonly steps: ProfileStepMetric[] = [];
  private readonly pendingTools = new Map<string, PendingTool>();
  /** Usage accrued since the last attribution point; flushed onto the next
   * tool request, or onto the turn's assistant-response step at turn end. */
  private pendingUsage: Usage = { ...ZERO_USAGE };
  /** Last cumulative usage seen for the open turn (deltas are per-round). */
  private lastCumulative: Usage = { ...ZERO_USAGE };
  private currentTurnId: string | null = null;
  private turnStartedAt: string | null = null;
  private totalDurationMs = 0;
  private readonly totals: Usage = { ...ZERO_USAGE };
  private activeToolCallId: string | null = null;

  /** Fold one streamed event into the profile. */
  record(event: AgentEvent): void {
    switch (event.type) {
      case 'turn.started':
        this.currentTurnId = event.turnId;
        this.turnStartedAt = event.timestamp;
        this.lastCumulative = { ...ZERO_USAGE };
        this.pendingUsage = { ...ZERO_USAGE };
        break;

      case 'usage.updated':
        this.recordUsage(event);
        break;

      case 'tool.requested': {
        const step: ProfileStepMetric = {
          stepKey: event.toolCallId,
          kind: 'tool',
          label: event.toolName,
          turnId: event.turnId,
          durationMs: null,
          inputUnits: this.pendingUsage.inputUnits,
          outputUnits: this.pendingUsage.outputUnits,
          costMinor: this.pendingUsage.costMinor.toString(),
          isError: false,
          timestamp: event.timestamp,
        };
        this.pendingUsage = { ...ZERO_USAGE };
        this.steps.push(step);
        this.pendingTools.set(event.toolCallId, { step, requestedAt: event.timestamp });
        this.activeToolCallId = event.toolCallId;
        break;
      }

      case 'tool.rejected':
        this.completeTool(event.toolCallId, event.timestamp, true);
        break;

      case 'tool.started': {
        const pending = this.activeToolCallId
          ? this.pendingTools.get(this.activeToolCallId)
          : undefined;
        if (pending) pending.startedAt = event.timestamp;
        break;
      }

      case 'tool.output':
        if (this.activeToolCallId) {
          this.completeTool(this.activeToolCallId, event.timestamp, event.isError);
        }
        break;

      case 'turn.completed':
      case 'turn.failed':
        this.closeTurn(event.timestamp);
        break;
    }
  }

  /** The full performance profile of everything recorded so far. */
  getReport(): AgentProfileReport {
    const tools = this.aggregateTools();
    const bottlenecks = this.findBottlenecks(tools);
    return {
      totalDurationMs: this.totalDurationMs,
      totalInputUnits: this.totals.inputUnits,
      totalOutputUnits: this.totals.outputUnits,
      totalCostMinor: this.totals.costMinor.toString(),
      toolCalls: this.steps.filter((s) => s.kind === 'tool').length,
      failedToolCalls: this.steps.filter((s) => s.kind === 'tool' && s.isError).length,
      tools,
      steps: [...this.steps],
      bottlenecks,
    };
  }

  /** Rebuild the profile of a past session from the durable store. */
  hydrate(store: RuntimeStore, sessionId: string): void {
    for (const row of store.listEvents(sessionId)) {
      try {
        this.record(JSON.parse(row.payload) as AgentEvent);
      } catch {
        // A corrupt event row must not break the profile.
      }
    }
  }

  static hydrateFromStore(store: RuntimeStore, sessionId: string): AgentProfiler {
    const profiler = new AgentProfiler();
    profiler.hydrate(store, sessionId);
    return profiler;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private recordUsage(event: UsageUpdatedEvent): void {
    // usage.updated carries cumulative per-turn totals; the round's usage is
    // the delta over the last reading (clamped at zero for robustness).
    const delta: Usage = {
      inputUnits: Math.max(0, event.inputUnits - this.lastCumulative.inputUnits),
      outputUnits: Math.max(0, event.outputUnits - this.lastCumulative.outputUnits),
      costMinor: BigInt(event.costMinor) - this.lastCumulative.costMinor,
    };
    if (delta.costMinor < 0n) delta.costMinor = 0n;
    this.lastCumulative = {
      inputUnits: event.inputUnits,
      outputUnits: event.outputUnits,
      costMinor: BigInt(event.costMinor),
    };
    this.totals.inputUnits += delta.inputUnits;
    this.totals.outputUnits += delta.outputUnits;
    this.totals.costMinor += delta.costMinor;
    this.pendingUsage.inputUnits += delta.inputUnits;
    this.pendingUsage.outputUnits += delta.outputUnits;
    this.pendingUsage.costMinor += delta.costMinor;
  }

  private completeTool(toolCallId: string, completedAt: string, isError: boolean): void {
    const pending = this.pendingTools.get(toolCallId);
    if (!pending) return;
    pending.step.durationMs = msBetween(pending.startedAt ?? pending.requestedAt, completedAt);
    pending.step.isError = isError;
    this.pendingTools.delete(toolCallId);
    if (this.activeToolCallId === toolCallId) this.activeToolCallId = null;
  }

  private closeTurn(completedAt: string): void {
    if (this.turnStartedAt) {
      this.totalDurationMs += msBetween(this.turnStartedAt, completedAt) ?? 0;
      this.turnStartedAt = null;
    }
    // Usage the closing model round produced (it replied with text, not a
    // tool call) becomes the turn's assistant-response step.
    if (!isZero(this.pendingUsage) && this.currentTurnId) {
      this.steps.push({
        stepKey: `${this.currentTurnId}:response`,
        kind: 'model',
        label: 'assistant response',
        turnId: this.currentTurnId,
        durationMs: null,
        inputUnits: this.pendingUsage.inputUnits,
        outputUnits: this.pendingUsage.outputUnits,
        costMinor: this.pendingUsage.costMinor.toString(),
        isError: false,
        timestamp: completedAt,
      });
    }
    this.pendingUsage = { ...ZERO_USAGE };
    // Tools still open when the turn ends (cancel/fail) close out here.
    for (const [toolCallId] of this.pendingTools) {
      this.completeTool(toolCallId, completedAt, true);
    }
    this.currentTurnId = null;
  }

  private aggregateTools(): ToolProfile[] {
    const byName = new Map<string, ToolProfile>();
    for (const step of this.steps) {
      if (step.kind !== 'tool') continue;
      let profile = byName.get(step.label);
      if (!profile) {
        profile = {
          toolName: step.label,
          calls: 0,
          failures: 0,
          totalMs: 0,
          avgMs: 0,
          maxMs: 0,
          inputUnits: 0,
          outputUnits: 0,
          costMinor: '0',
        };
        byName.set(step.label, profile);
      }
      profile.calls += 1;
      if (step.isError) profile.failures += 1;
      const ms = step.durationMs ?? 0;
      profile.totalMs += ms;
      profile.maxMs = Math.max(profile.maxMs, ms);
      profile.inputUnits += step.inputUnits;
      profile.outputUnits += step.outputUnits;
      profile.costMinor = (BigInt(profile.costMinor) + BigInt(step.costMinor)).toString();
    }
    const tools = [...byName.values()];
    for (const profile of tools) {
      profile.avgMs = profile.calls > 0 ? Math.round(profile.totalMs / profile.calls) : 0;
    }
    return tools.sort((a, b) => b.totalMs - a.totalMs);
  }

  private findBottlenecks(tools: ToolProfile[]): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    const totalToolMs = tools.reduce((sum, t) => sum + t.totalMs, 0);
    if (totalToolMs > 0) {
      for (const tool of tools) {
        const share = tool.totalMs / totalToolMs;
        if (share >= SLOW_TOOL_SHARE) {
          bottlenecks.push({
            kind: 'slow_tool',
            subject: tool.toolName,
            detail: `${tool.toolName} accounts for ${Math.round(share * 100)}% of tool time (${tool.totalMs}ms across ${tool.calls} calls)`,
            sharePct: Math.round(share * 100),
          });
        }
      }
    }

    for (const tool of tools) {
      if (tool.calls >= FLAKY_MIN_CALLS && tool.failures / tool.calls >= FLAKY_FAILURE_RATE) {
        bottlenecks.push({
          kind: 'flaky_tool',
          subject: tool.toolName,
          detail: `${tool.toolName} failed ${tool.failures} of ${tool.calls} calls`,
          sharePct: Math.round((tool.failures / tool.calls) * 100),
        });
      }
    }

    const totalTokens = this.totals.inputUnits + this.totals.outputUnits;
    for (const step of this.steps) {
      const tokens = step.inputUnits + step.outputUnits;
      if (totalTokens > 0 && tokens > 0 && tokens / totalTokens >= HEAVY_STEP_SHARE) {
        bottlenecks.push({
          kind: 'token_heavy',
          subject: step.label,
          detail: `${step.label} consumed ${Math.round((tokens / totalTokens) * 100)}% of session tokens (${tokens} units)`,
          sharePct: Math.round((tokens / totalTokens) * 100),
        });
      }
      if (this.totals.costMinor > 0n) {
        const stepCost = BigInt(step.costMinor);
        const sharePct = Number((stepCost * 100n) / this.totals.costMinor);
        if (stepCost > 0n && sharePct >= Math.round(HEAVY_STEP_SHARE * 100)) {
          bottlenecks.push({
            kind: 'cost_heavy',
            subject: step.label,
            detail: `${step.label} accounts for ${sharePct}% of session cost`,
            sharePct,
          });
        }
      }
    }

    return bottlenecks.sort((a, b) => b.sharePct - a.sharePct);
  }
}
