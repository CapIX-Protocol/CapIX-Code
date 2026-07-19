/**
 * TUI orchestration panel — visible agent coordination for the Capix TUI.
 *
 * One store per process (the `orchestrationPanel` singleton), fed by an
 * `OrchestrationEngine` from `@capix/agent-runtime` and rendered by the TUI:
 *  - pipeline flow: plan → implement → test → review → deploy, with per-stage
 *    status and handoff summaries;
 *  - real-time specialist status: state, current task, progress, spend;
 *  - parallel execution view: running delegations plus the FIFO queue;
 *  - delegation history with outcomes;
 *  - smart specialist suggestions for a draft task;
 *  - per-specialist cost breakdown in integer minor units (`formatMoney`
 *    from routing-client) — never floats.
 *
 * The store mirrors the engine on every orchestration event, so renderers
 * always read a consistent snapshot. Rendering is pure — every `render*`
 * function takes data and returns a string.
 */

import {
  OrchestrationEngine,
  suggestSpecialists,
  PIPELINE_STAGES,
  type AgentPipeline,
  type Delegation,
  type PipelineStage,
  type SpecialistCost,
  type SpecialistStatus,
  type SpecialistSuggestion,
  type StageStatus,
} from '@capix/agent-runtime';
import { formatMoney } from '../routing-client.js';

export interface OrchestrationPanelState {
  /** The most recently created pipeline, if any. */
  pipeline: AgentPipeline | null;
  pipelines: number;
  specialists: SpecialistStatus[];
  active: Delegation[];
  queued: Delegation[];
  history: Delegation[];
  costs: SpecialistCost[];
  /** Suggestions for the current draft task (set via `suggestFor`). */
  suggestions: SpecialistSuggestion[];
  updatedAt: string;
}

export type OrchestrationPanelListener = (state: OrchestrationPanelState) => void;

function emptyState(): OrchestrationPanelState {
  return {
    pipeline: null,
    pipelines: 0,
    specialists: [],
    active: [],
    queued: [],
    history: [],
    costs: [],
    suggestions: [],
    updatedAt: new Date().toISOString(),
  };
}

export class OrchestrationPanelStore {
  private state: OrchestrationPanelState = emptyState();
  private readonly listeners = new Set<OrchestrationPanelListener>();
  private engine: OrchestrationEngine | null = null;
  private unsubscribeEngine: (() => void) | null = null;
  /** Draft task the suggestions section reflects. */
  private draftTask = '';

  /** Attach an engine; the store re-mirrors on every orchestration event. */
  setEngine(engine: OrchestrationEngine | null): void {
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.engine = engine;
    if (engine) {
      this.unsubscribeEngine = engine.subscribe(() => this.refresh());
    }
    this.refresh();
  }

  /** Update the draft task and recompute smart suggestions. */
  suggestFor(task: string): void {
    this.draftTask = task;
    this.refresh();
  }

  /** Re-mirror engine state. Safe to call any time; never throws. */
  refresh(): void {
    if (!this.engine) {
      this.state = { ...emptyState(), suggestions: this.computeSuggestions() };
    } else {
      const pipelines = this.engine.listPipelines();
      this.state = {
        pipeline: pipelines[0] ?? null,
        pipelines: pipelines.length,
        specialists: this.engine.getSpecialistStatuses(),
        active: this.engine.getActiveDelegations(),
        queued: this.engine.getQueuedDelegations(),
        history: this.engine.getHistory({ limit: 10 }),
        costs: this.engine.getCostBreakdown(),
        suggestions: this.computeSuggestions(),
        updatedAt: new Date().toISOString(),
      };
    }
    this.touch();
  }

  /** Current immutable-ish snapshot for renderers. */
  snapshot(): OrchestrationPanelState {
    return {
      ...this.state,
      specialists: this.state.specialists.map((s) => ({ ...s })),
      active: this.state.active.map((d) => ({ ...d })),
      queued: this.state.queued.map((d) => ({ ...d })),
      history: this.state.history.map((d) => ({ ...d })),
      costs: this.state.costs.map((c) => ({ ...c })),
      suggestions: this.state.suggestions.map((s) => ({
        ...s,
        matchedKeywords: [...s.matchedKeywords],
      })),
    };
  }

  subscribe(listener: OrchestrationPanelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private computeSuggestions(): SpecialistSuggestion[] {
    if (!this.draftTask.trim()) return [];
    return suggestSpecialists(this.draftTask, { max: 3 });
  }

  private touch(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        // A broken renderer must never interrupt the session.
      }
    }
  }
}

/** Shared process-wide store; the plugin feeds it, the TUI renders it. */
export const orchestrationPanel = new OrchestrationPanelStore();

// ── Renderers (pure) ─────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function shortDate(iso: string): string {
  return iso.slice(5, 10) + ' ' + iso.slice(11, 16);
}

const USD = { currency: 'USD', scale: 2 };

function usd(amountMinor: string): string {
  return formatMoney({ amountMinor, ...USD });
}

/** `██████░░░░` progress bar; `?` when progress is unknown. */
export function progressBar(progress: number | null, width = 10): string {
  if (progress === null) return '·'.repeat(width);
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const STAGE_GLYPH: Record<StageStatus, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  skipped: '–',
  blocked: '!',
};

const STAGE_ICON: Record<PipelineStage, string> = {
  plan: '📋',
  implement: '⚡',
  test: '🧪',
  review: '👀',
  deploy: '🚀',
};

/**
 * Pipeline flow as connected stages, e.g.:
 * `📋 plan ✓ ─▶ ⚡ implement ◐ ─▶ 🧪 test ○ ─▶ 👀 review ○ ─▶ 🚀 deploy ○`
 * plus one indented line per active/completed stage with its summary.
 */
export function renderPipeline(
  pipeline: AgentPipeline | null,
  opts: { width?: number } = {}
): string {
  const width = opts.width ?? 60;
  if (!pipeline) return `Pipeline: none — ${PIPELINE_STAGES.join(' → ')}`;

  const flow = pipeline.stages
    .map((s) => `${STAGE_ICON[s.stage]} ${s.stage} ${STAGE_GLYPH[s.status]}`)
    .join(' ─▶ ');
  const lines = [
    `Pipeline ${pipeline.id.slice(0, 13)} [${pipeline.status}] ${truncate(pipeline.goal, width)}`,
    `  ${flow}`,
  ];
  for (const stage of pipeline.stages) {
    if (stage.status === 'pending' || stage.status === 'skipped') continue;
    const summary = stage.summary ? ` — ${truncate(stage.summary, width)}` : '';
    lines.push(`  ${STAGE_GLYPH[stage.status]} ${stage.stage} (${stage.specialistRole})${summary}`);
  }
  return lines.join('\n');
}

/**
 * Real-time specialist roster: state, current task, progress bar, spend.
 * One line per specialist, running first, then queued, then idle.
 */
export function renderSpecialistStatuses(
  statuses: SpecialistStatus[],
  opts: { width?: number } = {}
): string {
  const width = opts.width ?? 40;
  if (statuses.length === 0) return 'Specialists: none registered';
  const order = { running: 0, queued: 1, idle: 2 };
  const sorted = [...statuses].sort((a, b) => order[a.state] - order[b.state]);
  const lines = [`Specialists (${statuses.filter((s) => s.state === 'running').length} running)`];
  for (const s of sorted) {
    const state =
      s.state === 'running' ? '▶ running' : s.state === 'queued' ? '… queued ' : '  idle   ';
    const task = s.currentTask ? ` "${truncate(s.currentTask, width)}"` : '';
    const step = s.currentStep ? ` · ${truncate(s.currentStep, 24)}` : '';
    const bar = s.state === 'running' ? ` [${progressBar(s.progress)}]` : '';
    lines.push(
      `  ${s.icon} ${s.name.padEnd(18)} ${state}${bar}${task}${step} · ${usd(s.costMinor)}`
    );
  }
  return lines.join('\n');
}

/**
 * Parallel execution view: every in-flight delegation with its progress,
 * plus the FIFO queue behind it.
 */
export function renderParallelView(
  active: Delegation[],
  queued: Delegation[],
  opts: { width?: number } = {}
): string {
  const width = opts.width ?? 40;
  if (active.length === 0 && queued.length === 0) return 'Delegations: none in flight';

  const lines = [`In flight (${active.length} running / ${queued.length} queued)`];
  for (const d of active) {
    const step = d.currentStep ? ` · ${truncate(d.currentStep, 24)}` : '';
    lines.push(
      `  ▶ ${d.role.padEnd(10)} [${progressBar(d.progress)}] ${truncate(d.task, width)}${step} · ${usd(d.costMinor)}`
    );
  }
  for (const [i, d] of queued.entries()) {
    lines.push(`  ${i + 1}. ${d.role.padEnd(10)} ${truncate(d.task, width)} (queued)`);
  }
  return lines.join('\n');
}

const OUTCOME_GLYPH: Record<string, string> = {
  success: '✓',
  partial: '◐',
  failed: '✗',
};

/**
 * Delegation history: who was delegated what, and how it ended.
 * Most recent first.
 */
export function renderDelegationHistory(
  history: Delegation[],
  opts: { max?: number; width?: number } = {}
): string {
  const max = opts.max ?? 10;
  const width = opts.width ?? 50;
  if (history.length === 0) return 'History: nothing delegated yet';

  const lines = [`Delegation history (${history.length})`];
  for (const d of history.slice(0, max)) {
    const glyph = d.outcome ? OUTCOME_GLYPH[d.outcome] : d.status === 'cancelled' ? '–' : '…';
    const cost = BigInt(d.costMinor) > BigInt(0) ? ` ${usd(d.costMinor)}` : '';
    const detail = d.summary ?? d.error ?? d.status;
    lines.push(
      `  ${glyph} ${shortDate(d.createdAt)} ${d.role.padEnd(10)}${cost} — ${truncate(detail, width)}`
    );
  }
  if (history.length > max) {
    lines.push(`  … and ${history.length - max} more`);
  }
  return lines.join('\n');
}

/** Per-specialist cost breakdown, most expensive first. */
export function renderCostBreakdown(costs: SpecialistCost[]): string {
  const active = costs.filter((c) => c.delegations > 0);
  if (active.length === 0) return 'Cost per agent: no spend yet';
  const total = active.reduce((sum, c) => sum + BigInt(c.costMinor), BigInt(0));
  const lines = [`Cost per agent (${usd(total.toString())} total)`];
  for (const c of active) {
    const count = `${c.delegations} delegation${c.delegations === 1 ? '' : 's'}`;
    lines.push(
      `  ${c.icon} ${c.name.padEnd(18)} ${usd(c.costMinor).padStart(8)} · ${count} · ${c.model}`
    );
  }
  return lines.join('\n');
}

/** Smart specialist suggestions for a draft task. */
export function renderSuggestions(suggestions: SpecialistSuggestion[]): string {
  if (suggestions.length === 0) return 'Suggestions: describe a task to see suggested specialists';
  const lines = ['Suggested specialists'];
  for (const s of suggestions) {
    lines.push(`  ${s.icon} ${s.name} (${Math.round(s.score * 100)}%) — ${s.reason} · ${s.model}`);
  }
  return lines.join('\n');
}

/**
 * Full orchestration panel: pipeline flow, specialist roster, parallel view,
 * suggestions, cost breakdown, and delegation history.
 */
export function renderOrchestrationPanel(state: OrchestrationPanelState): string {
  const sections = [
    renderPipeline(state.pipeline),
    renderSpecialistStatuses(state.specialists),
    renderParallelView(state.active, state.queued),
    renderSuggestions(state.suggestions),
    renderCostBreakdown(state.costs),
    renderDelegationHistory(state.history),
  ];
  return sections.join('\n\n');
}

/**
 * Compact one-line orchestration summary for the TUI status bar, e.g.:
 * `orchestration: implement ◐ (2 running, 1 queued) · USD 0.87 spent`
 */
export function renderOrchestrationLine(state: OrchestrationPanelState): string {
  const running = state.active.length;
  const queued = state.queued.length;
  const total = state.costs.reduce((sum, c) => sum + BigInt(c.costMinor), BigInt(0));
  const stage = state.pipeline?.stages.find((s) => s.status === 'running');
  const stageText = stage ? `${stage.stage} ◐` : (state.pipeline?.status ?? 'idle');
  const counts = running > 0 || queued > 0 ? ` (${running} running, ${queued} queued)` : '';
  return `orchestration: ${stageText}${counts} · ${usd(total.toString())} spent`;
}
