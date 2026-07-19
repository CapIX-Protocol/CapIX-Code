/**
 * @capix/agent-runtime — orchestration engine.
 *
 * Coordinates the specialist roster (specialists.ts) as an epic pipeline:
 *
 * - Pipeline state machine: plan → implement → test → review → deploy. Each
 *   stage delegates to its specialist; a stage hands its summary forward as
 *   context for the next. Failures block the pipeline until the operator
 *   retries or skips the stage.
 * - Parallel execution: ad-hoc delegations run concurrently up to
 *   `maxParallel`; the rest queue in FIFO order. Every delegation is
 *   cancellable.
 * - Cost tracking per specialist: usage is accumulated in integer minor
 *   units (BigInt arithmetic, TEXT persistence) — never floats.
 * - Delegation history persistence: every delegation is written through an
 *   injectable `OrchestrationPersistence` adapter (RuntimeStore satisfies it
 *   structurally) and rehydrated on boot, so history survives restarts.
 * - Smart suggestions: `suggestSpecialists` scores the roster against a
 *   task's keywords so the TUI and IDE can offer one-click delegation.
 *
 * Execution is injected as a `DelegationExecutor` (the same pattern as the
 * runtime's `ModelInvoker`): the engine owns coordination state, the host
 * owns how a specialist turn actually runs. `createRuntimeExecutor` bridges
 * the engine to a `CapixAgentRuntime`-shaped object for hosts that want the
 * default child-session behaviour.
 */

import { randomUUID } from 'node:crypto';

import type { AgentEvent } from './events.js';
import { getSpecialist, listSpecialists } from './specialists.js';
import type { DelegationRow } from './store.js';

// ── Pipeline ────────────────────────────────────────────────────────────────

export type PipelineStage = 'plan' | 'implement' | 'test' | 'review' | 'deploy';

/** Canonical epic pipeline order. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'plan',
  'implement',
  'test',
  'review',
  'deploy',
];

/** The specialist each stage delegates to by default. */
export const STAGE_DEFAULT_SPECIALIST: Record<PipelineStage, string> = {
  plan: 'explore',
  implement: 'implement',
  test: 'test',
  review: 'review',
  deploy: 'deploy',
};

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

export interface PipelineStageState {
  stage: PipelineStage;
  status: StageStatus;
  specialistRole: string;
  delegationId: string | null;
  summary: string | null;
}

export type PipelineStatus = 'draft' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface AgentPipeline {
  id: string;
  goal: string;
  status: PipelineStatus;
  stages: PipelineStageState[];
  createdAt: string;
  updatedAt: string;
}

// ── Delegations ─────────────────────────────────────────────────────────────

export type DelegationStatus =
  'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export type DelegationOutcome = 'success' | 'partial' | 'failed';

export interface Delegation {
  id: string;
  pipelineId: string | null;
  stage: PipelineStage | null;
  role: string;
  task: string;
  context: string;
  status: DelegationStatus;
  /** 0..1 when the executor reports progress; null when unknown. */
  progress: number | null;
  /** Human-readable current step, e.g. the tool in flight. */
  currentStep: string | null;
  /** Accumulated spend, integer minor units (BigInt-safe string). */
  costMinor: string;
  inputUnits: number;
  outputUnits: number;
  outcome: DelegationOutcome | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DelegationResult {
  outcome: DelegationOutcome;
  summary: string;
}

/**
 * How a delegation actually runs. Injected by the host — the engine awaits
 * the promise and records the outcome. Reject (or return outcome 'failed')
 * to fail the delegation.
 */
export type DelegationExecutor = (
  delegation: Delegation,
  signal: AbortSignal
) => Promise<DelegationResult>;

/** Persistence adapter for delegation history; RuntimeStore satisfies it. */
export interface OrchestrationPersistence {
  insertDelegation(row: DelegationRow): void;
  updateDelegation(id: string, fields: Partial<DelegationRow>): void;
  listDelegations(limit: number, pipelineId?: string): DelegationRow[];
}

// ── Events ──────────────────────────────────────────────────────────────────

export type OrchestrationEvent =
  | { type: 'pipeline.created'; pipeline: AgentPipeline }
  | { type: 'pipeline.started'; pipelineId: string }
  | {
      type: 'pipeline.stage.started';
      pipelineId: string;
      stage: PipelineStage;
      delegationId: string;
    }
  | {
      type: 'pipeline.stage.completed';
      pipelineId: string;
      stage: PipelineStage;
      summary: string | null;
    }
  | { type: 'pipeline.completed'; pipelineId: string }
  | { type: 'pipeline.blocked'; pipelineId: string; stage: PipelineStage; reason: string }
  | { type: 'pipeline.cancelled'; pipelineId: string }
  | { type: 'delegation.queued'; delegation: Delegation }
  | { type: 'delegation.started'; delegation: Delegation }
  | {
      type: 'delegation.progress';
      delegationId: string;
      progress: number;
      currentStep: string | null;
    }
  | {
      type: 'delegation.usage';
      delegationId: string;
      costMinor: string;
      inputUnits: number;
      outputUnits: number;
    }
  | { type: 'delegation.completed'; delegation: Delegation }
  | { type: 'delegation.failed'; delegation: Delegation }
  | { type: 'delegation.cancelled'; delegation: Delegation };

export type OrchestrationListener = (event: OrchestrationEvent) => void;

// ── Status views ────────────────────────────────────────────────────────────

export type SpecialistState = 'idle' | 'queued' | 'running';

export interface SpecialistStatus {
  role: string;
  name: string;
  icon: string;
  model: string;
  state: SpecialistState;
  currentTask: string | null;
  progress: number | null;
  currentStep: string | null;
  /** Lifetime spend across all delegations to this specialist, minor units. */
  costMinor: string;
  activeDelegationId: string | null;
}

export interface SpecialistCost {
  role: string;
  name: string;
  icon: string;
  model: string;
  delegations: number;
  costMinor: string;
}

export interface OrchestrationOptions {
  /** Max concurrently running delegations. Default 3. */
  maxParallel?: number;
  /** Host executor; without one, delegations wait in the queue to be driven
   * manually via `updateProgress` / `recordUsage` / `finishDelegation`. */
  executor?: DelegationExecutor;
  /** Durable history adapter (e.g. RuntimeStore). */
  persistence?: OrchestrationPersistence;
  /** How many historical delegations to rehydrate on boot. Default 100. */
  historyLimit?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Row mapping ─────────────────────────────────────────────────────────────

export function delegationToRow(d: Delegation): DelegationRow {
  return {
    id: d.id,
    pipeline_id: d.pipelineId,
    stage: d.stage,
    role: d.role,
    task: d.task,
    context: d.context,
    status: d.status,
    progress: d.progress,
    current_step: d.currentStep,
    cost_minor: d.costMinor,
    input_units: d.inputUnits,
    output_units: d.outputUnits,
    outcome: d.outcome,
    summary: d.summary,
    error: d.error,
    created_at: d.createdAt,
    started_at: d.startedAt,
    completed_at: d.completedAt,
  };
}

export function rowToDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    stage: (row.stage as PipelineStage | null) ?? null,
    role: row.role,
    task: row.task,
    context: row.context,
    status: row.status as DelegationStatus,
    progress: row.progress,
    currentStep: row.current_step,
    costMinor: row.cost_minor,
    inputUnits: row.input_units,
    outputUnits: row.output_units,
    outcome: (row.outcome as DelegationOutcome | null) ?? null,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ── Engine ──────────────────────────────────────────────────────────────────

export class OrchestrationEngine {
  private readonly maxParallel: number;
  private readonly executor?: DelegationExecutor;
  private readonly persistence?: OrchestrationPersistence;

  private readonly pipelines = new Map<string, AgentPipeline>();
  private readonly delegations = new Map<string, Delegation>();
  /** FIFO of delegation ids waiting for a parallel slot. */
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<OrchestrationListener>();

  constructor(options: OrchestrationOptions = {}) {
    this.maxParallel = Math.max(1, options.maxParallel ?? 3);
    this.executor = options.executor;
    this.persistence = options.persistence;
    if (this.persistence) {
      for (const row of this.persistence.listDelegations(options.historyLimit ?? 100)) {
        const delegation = rowToDelegation(row);
        // A process restart orphans anything that was mid-flight.
        if (delegation.status === 'running' || delegation.status === 'queued') {
          delegation.status = 'cancelled';
          delegation.error = 'interrupted by restart';
          delegation.completedAt = nowIso();
          this.persistUpdate(delegation);
        }
        this.delegations.set(delegation.id, delegation);
      }
    }
  }

  subscribe(listener: OrchestrationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Pipeline state machine ──────────────────────────────────────────────

  createPipeline(
    goal: string,
    opts: {
      stages?: PipelineStage[];
      specialistOverrides?: Partial<Record<PipelineStage, string>>;
    } = {}
  ): AgentPipeline {
    const now = nowIso();
    const pipeline: AgentPipeline = {
      id: `pipe_${randomUUID()}`,
      goal,
      status: 'draft',
      stages: (opts.stages ?? [...PIPELINE_STAGES]).map((stage) => ({
        stage,
        status: 'pending',
        specialistRole: opts.specialistOverrides?.[stage] ?? STAGE_DEFAULT_SPECIALIST[stage],
        delegationId: null,
        summary: null,
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.pipelines.set(pipeline.id, pipeline);
    this.emit({ type: 'pipeline.created', pipeline: this.copyPipeline(pipeline) });
    return this.copyPipeline(pipeline);
  }

  /** Start (or resume) a pipeline: kicks the first pending stage. */
  async startPipeline(pipelineId: string): Promise<void> {
    const pipeline = this.requirePipeline(pipelineId);
    if (pipeline.status === 'cancelled' || pipeline.status === 'completed') return;
    if (pipeline.status === 'draft') {
      pipeline.status = 'running';
      pipeline.updatedAt = nowIso();
      this.emit({ type: 'pipeline.started', pipelineId });
    }
    this.advancePipeline(pipeline);
  }

  getPipeline(pipelineId: string): AgentPipeline | null {
    const pipeline = this.pipelines.get(pipelineId);
    return pipeline ? this.copyPipeline(pipeline) : null;
  }

  listPipelines(): AgentPipeline[] {
    return [...this.pipelines.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => this.copyPipeline(p));
  }

  /** Re-run a failed/blocked stage with a fresh delegation. */
  async retryStage(pipelineId: string, stage: PipelineStage): Promise<void> {
    const pipeline = this.requirePipeline(pipelineId);
    const state = this.requireStage(pipeline, stage);
    if (state.status !== 'failed' && state.status !== 'blocked') {
      throw new Error(`stage ${stage} is not retryable (status: ${state.status})`);
    }
    state.status = 'pending';
    state.delegationId = null;
    if (pipeline.status === 'blocked') pipeline.status = 'running';
    pipeline.updatedAt = nowIso();
    this.advancePipeline(pipeline);
  }

  /** Skip a pending/failed/blocked stage and continue the pipeline. */
  skipStage(pipelineId: string, stage: PipelineStage): void {
    const pipeline = this.requirePipeline(pipelineId);
    const state = this.requireStage(pipeline, stage);
    if (state.status === 'completed' || state.status === 'running') {
      throw new Error(`stage ${stage} cannot be skipped (status: ${state.status})`);
    }
    state.status = 'skipped';
    if (pipeline.status === 'blocked') pipeline.status = 'running';
    pipeline.updatedAt = nowIso();
    this.advancePipeline(pipeline);
  }

  async cancelPipeline(pipelineId: string): Promise<void> {
    const pipeline = this.requirePipeline(pipelineId);
    pipeline.status = 'cancelled';
    pipeline.updatedAt = nowIso();
    for (const state of pipeline.stages) {
      if (state.delegationId) await this.cancelDelegation(state.delegationId);
      if (state.status === 'running' || state.status === 'pending') state.status = 'skipped';
    }
    this.emit({ type: 'pipeline.cancelled', pipelineId });
  }

  /**
   * Start the next pending stage when no stage is currently running. The
   * stage's delegation carries the goal plus every prior stage summary as
   * handoff context.
   */
  private advancePipeline(pipeline: AgentPipeline): void {
    if (pipeline.status !== 'running' && pipeline.status !== 'draft') return;
    if (pipeline.stages.some((s) => s.status === 'running')) return;
    const next = pipeline.stages.find((s) => s.status === 'pending');
    if (!next) {
      if (pipeline.stages.every((s) => s.status === 'completed' || s.status === 'skipped')) {
        pipeline.status = 'completed';
        pipeline.updatedAt = nowIso();
        this.emit({ type: 'pipeline.completed', pipelineId: pipeline.id });
      }
      return;
    }
    const handoff = pipeline.stages
      .filter((s) => s.status === 'completed' && s.summary)
      .map((s) => `${s.stage}: ${s.summary}`)
      .join('\n');
    const delegation = this.delegate({
      role: next.specialistRole,
      task: pipeline.goal,
      context: handoff
        ? `Pipeline stage: ${next.stage}\nPrior stages:\n${handoff}`
        : `Pipeline stage: ${next.stage}`,
      pipelineId: pipeline.id,
      stage: next.stage,
    });
    next.delegationId = delegation.id;
    next.status = 'running';
    pipeline.updatedAt = nowIso();
    this.emit({
      type: 'pipeline.stage.started',
      pipelineId: pipeline.id,
      stage: next.stage,
      delegationId: delegation.id,
    });
  }

  private onStageDelegationFinished(pipeline: AgentPipeline, delegation: Delegation): void {
    const state = pipeline.stages.find((s) => s.delegationId === delegation.id);
    if (!state) return;
    if (delegation.status === 'completed' && delegation.outcome !== 'failed') {
      state.status = 'completed';
      state.summary = delegation.summary;
      pipeline.updatedAt = nowIso();
      this.emit({
        type: 'pipeline.stage.completed',
        pipelineId: pipeline.id,
        stage: state.stage,
        summary: delegation.summary,
      });
      this.advancePipeline(pipeline);
    } else if (delegation.status === 'cancelled') {
      state.status = 'pending';
      state.delegationId = null;
    } else {
      state.status = 'failed';
      pipeline.status = 'blocked';
      pipeline.updatedAt = nowIso();
      this.emit({
        type: 'pipeline.blocked',
        pipelineId: pipeline.id,
        stage: state.stage,
        reason: delegation.error ?? 'stage delegation failed',
      });
    }
  }

  // ── Delegation ──────────────────────────────────────────────────────────

  /**
   * Queue a delegation to a specialist. Starts immediately when a parallel
   * slot is free and an executor is configured; otherwise waits in the FIFO.
   */
  delegate(input: {
    role: string;
    task: string;
    context?: string;
    pipelineId?: string;
    stage?: PipelineStage;
  }): Delegation {
    const specialist = getSpecialist(input.role);
    if (!specialist) throw new Error(`unknown specialist role: ${input.role}`);
    if (input.pipelineId) this.requirePipeline(input.pipelineId);
    const delegation: Delegation = {
      id: `dlg_${randomUUID()}`,
      pipelineId: input.pipelineId ?? null,
      stage: input.stage ?? null,
      role: specialist.role,
      task: input.task,
      context: input.context ?? '',
      status: 'queued',
      progress: null,
      currentStep: null,
      costMinor: '0',
      inputUnits: 0,
      outputUnits: 0,
      outcome: null,
      summary: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    this.delegations.set(delegation.id, delegation);
    this.queue.push(delegation.id);
    this.persistInsert(delegation);
    this.emit({ type: 'delegation.queued', delegation: { ...delegation } });
    this.pump();
    return { ...delegation };
  }

  async cancelDelegation(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;
    if (delegation.status !== 'queued' && delegation.status !== 'running') return;
    delegation.status = 'cancelled';
    delegation.completedAt = nowIso();
    const queuedAt = this.queue.indexOf(delegationId);
    if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
    const controller = this.controllers.get(delegationId);
    if (controller) {
      controller.abort();
      this.controllers.delete(delegationId);
    }
    this.persistUpdate(delegation);
    this.emit({ type: 'delegation.cancelled', delegation: { ...delegation } });
    const pipeline = delegation.pipelineId ? this.pipelines.get(delegation.pipelineId) : null;
    if (pipeline) this.onStageDelegationFinished(pipeline, delegation);
    this.pump();
  }

  /** Executor/host progress report (0..1 plus a human-readable step). */
  updateProgress(delegationId: string, progress: number, currentStep?: string): void {
    const delegation = this.delegations.get(delegationId);
    if (!delegation || delegation.status !== 'running') return;
    delegation.progress = Math.min(1, Math.max(0, progress));
    if (currentStep !== undefined) delegation.currentStep = currentStep;
    this.persistUpdate(delegation);
    this.emit({
      type: 'delegation.progress',
      delegationId,
      progress: delegation.progress,
      currentStep: delegation.currentStep,
    });
  }

  /** Accumulate usage in integer minor units (BigInt arithmetic). */
  recordUsage(
    delegationId: string,
    usage: { inputUnits?: number; outputUnits?: number; costMinor?: string | bigint }
  ): void {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;
    delegation.inputUnits += Math.max(0, Math.trunc(usage.inputUnits ?? 0));
    delegation.outputUnits += Math.max(0, Math.trunc(usage.outputUnits ?? 0));
    delegation.costMinor = (BigInt(delegation.costMinor) + BigInt(usage.costMinor ?? 0)).toString();
    this.persistUpdate(delegation);
    this.emit({
      type: 'delegation.usage',
      delegationId,
      costMinor: delegation.costMinor,
      inputUnits: delegation.inputUnits,
      outputUnits: delegation.outputUnits,
    });
  }

  /** Settle a running delegation (hosts driving without an executor). */
  finishDelegation(delegationId: string, result: DelegationResult): void {
    const delegation = this.delegations.get(delegationId);
    if (!delegation || delegation.status !== 'running') return;
    this.settle(delegation, result);
  }

  getDelegation(delegationId: string): Delegation | null {
    const delegation = this.delegations.get(delegationId);
    return delegation ? { ...delegation } : null;
  }

  /** Delegation history, most recent first. */
  getHistory(opts: { limit?: number; pipelineId?: string; role?: string } = {}): Delegation[] {
    let all = [...this.delegations.values()];
    if (opts.pipelineId) all = all.filter((d) => d.pipelineId === opts.pipelineId);
    if (opts.role) all = all.filter((d) => d.role === opts.role);
    return all
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 50)
      .map((d) => ({ ...d }));
  }

  getActiveDelegations(): Delegation[] {
    return [...this.delegations.values()]
      .filter((d) => d.status === 'running')
      .map((d) => ({ ...d }));
  }

  getQueuedDelegations(): Delegation[] {
    return this.queue
      .map((id) => this.delegations.get(id))
      .filter((d): d is Delegation => d !== undefined && d.status === 'queued')
      .map((d) => ({ ...d }));
  }

  // ── Status views ────────────────────────────────────────────────────────

  /** Per-specialist live status for the orchestration panel. */
  getSpecialistStatuses(): SpecialistStatus[] {
    const costs = this.costByRole();
    return listSpecialists().map((specialist) => {
      const active = [...this.delegations.values()].find(
        (d) => d.role === specialist.role && d.status === 'running'
      );
      const queued = !active
        ? [...this.delegations.values()].find(
            (d) => d.role === specialist.role && d.status === 'queued'
          )
        : undefined;
      const current = active ?? queued ?? null;
      return {
        role: specialist.role,
        name: specialist.name,
        icon: specialist.icon,
        model: specialist.model,
        state: active ? 'running' : queued ? 'queued' : 'idle',
        currentTask: current?.task ?? null,
        progress: active?.progress ?? null,
        currentStep: active?.currentStep ?? null,
        costMinor: costs.get(specialist.role)?.toString() ?? '0',
        activeDelegationId: active?.id ?? null,
      };
    });
  }

  /** Lifetime cost roll-up per specialist, most expensive first. */
  getCostBreakdown(): SpecialistCost[] {
    const costs = this.costByRole();
    const counts = new Map<string, number>();
    for (const d of this.delegations.values()) {
      counts.set(d.role, (counts.get(d.role) ?? 0) + 1);
    }
    return listSpecialists()
      .map((specialist) => ({
        role: specialist.role,
        name: specialist.name,
        icon: specialist.icon,
        model: specialist.model,
        delegations: counts.get(specialist.role) ?? 0,
        costMinor: costs.get(specialist.role)?.toString() ?? '0',
      }))
      .sort((a, b) => (BigInt(b.costMinor) > BigInt(a.costMinor) ? 1 : -1));
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Start queued delegations while parallel slots are free. */
  private pump(): void {
    while (this.queue.length > 0 && this.controllers.size < this.maxParallel) {
      const id = this.queue.shift()!;
      const delegation = this.delegations.get(id);
      if (!delegation || delegation.status !== 'queued') continue;
      delegation.status = 'running';
      delegation.startedAt = nowIso();
      this.persistUpdate(delegation);
      this.emit({ type: 'delegation.started', delegation: { ...delegation } });
      if (this.executor) {
        const controller = new AbortController();
        this.controllers.set(id, controller);
        void this.executor({ ...delegation }, controller.signal)
          .then((result) => {
            const current = this.delegations.get(id);
            if (current && current.status === 'running') this.settle(current, result);
          })
          .catch((err: unknown) => {
            const current = this.delegations.get(id);
            if (current && current.status === 'running') {
              current.error = err instanceof Error ? err.message : String(err);
              this.settle(current, { outcome: 'failed', summary: current.error });
            }
          })
          .finally(() => {
            this.controllers.delete(id);
            this.pump();
          });
      }
    }
  }

  private settle(delegation: Delegation, result: DelegationResult): void {
    delegation.status = result.outcome === 'failed' ? 'failed' : 'completed';
    delegation.outcome = result.outcome;
    delegation.summary = result.summary;
    delegation.progress = 1;
    delegation.currentStep = null;
    delegation.completedAt = nowIso();
    this.persistUpdate(delegation);
    this.emit({
      type: delegation.status === 'failed' ? 'delegation.failed' : 'delegation.completed',
      delegation: { ...delegation },
    });
    const pipeline = delegation.pipelineId ? this.pipelines.get(delegation.pipelineId) : null;
    if (pipeline) this.onStageDelegationFinished(pipeline, delegation);
  }

  private costByRole(): Map<string, bigint> {
    const costs = new Map<string, bigint>();
    for (const d of this.delegations.values()) {
      costs.set(d.role, (costs.get(d.role) ?? BigInt(0)) + BigInt(d.costMinor));
    }
    return costs;
  }

  private requirePipeline(pipelineId: string): AgentPipeline {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`unknown pipeline: ${pipelineId}`);
    return pipeline;
  }

  private requireStage(pipeline: AgentPipeline, stage: PipelineStage): PipelineStageState {
    const state = pipeline.stages.find((s) => s.stage === stage);
    if (!state) throw new Error(`pipeline ${pipeline.id} has no stage: ${stage}`);
    return state;
  }

  private copyPipeline(pipeline: AgentPipeline): AgentPipeline {
    return { ...pipeline, stages: pipeline.stages.map((s) => ({ ...s })) };
  }

  private persistInsert(delegation: Delegation): void {
    try {
      this.persistence?.insertDelegation(delegationToRow(delegation));
    } catch {
      // Persistence is best-effort; never break orchestration on it.
    }
  }

  private persistUpdate(delegation: Delegation): void {
    try {
      this.persistence?.updateDelegation(delegation.id, delegationToRow(delegation));
    } catch {
      // Persistence is best-effort; never break orchestration on it.
    }
  }

  private emit(event: OrchestrationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never interrupt orchestration.
      }
    }
  }
}

// ── Smart suggestions ───────────────────────────────────────────────────────

export interface SpecialistSuggestion {
  role: string;
  name: string;
  icon: string;
  model: string;
  /** 0..1 confidence. */
  score: number;
  reason: string;
  matchedKeywords: string[];
}

/** Keyword signals per specialist role, matched case-insensitively. */
const ROLE_KEYWORDS: Record<string, string[]> = {
  explore: [
    'explore',
    'understand',
    'how does',
    'where is',
    'find',
    'structure',
    'architecture',
    'orient',
    'map',
    'read',
    'explain',
  ],
  implement: [
    'implement',
    'add',
    'build',
    'create',
    'fix',
    'write',
    'refactor',
    'feature',
    'change',
    'update',
    'patch',
  ],
  test: ['test', 'tests', 'coverage', 'spec', 'unit', 'e2e', 'verify', 'assert'],
  review: [
    'review',
    'audit code',
    'quality',
    'correctness',
    'diff',
    'pull request',
    'pr',
    'feedback',
  ],
  security: [
    'security',
    'vulnerability',
    'vulnerabilities',
    'secret',
    'injection',
    'xss',
    'csrf',
    'ssrf',
    'auth bypass',
    'traversal',
  ],
  deploy: [
    'deploy',
    'ship',
    'release',
    'production',
    'vps',
    'docker',
    'nginx',
    'ssl',
    'hosting',
    'provision',
  ],
};

/**
 * Score the specialist roster against a free-form task. Returns matches
 * sorted by descending score; empty when nothing matches (callers pick
 * their own default).
 */
export function suggestSpecialists(
  task: string,
  opts: { max?: number } = {}
): SpecialistSuggestion[] {
  const text = task.toLowerCase();
  const suggestions: SpecialistSuggestion[] = [];
  for (const specialist of listSpecialists()) {
    const keywords = ROLE_KEYWORDS[specialist.role] ?? [];
    const matched = keywords.filter((kw) => text.includes(kw));
    if (matched.length === 0) continue;
    // First hit weighs most; each extra hit adds diminishing confidence.
    const score = Math.min(1, 0.5 + 0.15 * (matched.length - 1));
    suggestions.push({
      role: specialist.role,
      name: specialist.name,
      icon: specialist.icon,
      model: specialist.model,
      score,
      reason: `matches "${matched[0]}"${matched.length > 1 ? ` (+${matched.length - 1} more)` : ''}`,
      matchedKeywords: matched,
    });
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, opts.max ?? 3);
}

// ── Cost estimation ─────────────────────────────────────────────────────────

export type TaskComplexity = 'low' | 'medium' | 'high';

export interface DelegationCostEstimate {
  role: string;
  /** Heuristic estimate, integer USD minor units. */
  estimatedMinor: string;
  /** Hard spend ceiling from the specialist definition, integer USD minor units. */
  ceilingMinor: string;
  asset: string;
  scale: number;
}

/** Fraction of the spend ceiling a task of each complexity typically burns. */
const COMPLEXITY_FRACTION: Record<TaskComplexity, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.8,
};

/**
 * Estimate a delegation's cost before it runs. The estimate is a fraction of
 * the specialist's hard spend ceiling (its `maxSpendUsdMinor`), computed with
 * integer arithmetic only. Returns null for unknown roles.
 */
export function estimateDelegationCost(
  role: string,
  opts: { complexity?: TaskComplexity } = {}
): DelegationCostEstimate | null {
  const specialist = getSpecialist(role);
  if (!specialist) return null;
  const complexity = opts.complexity ?? 'medium';
  const ceiling = specialist.maxSpendUsdMinor;
  const fraction = COMPLEXITY_FRACTION[complexity];
  // Integer math: ceiling * percent / 100 keeps minor units exact.
  const percent = BigInt(Math.round(fraction * 100));
  const estimated = (ceiling * percent) / BigInt(100);
  return {
    role: specialist.role,
    estimatedMinor: estimated.toString(),
    ceilingMinor: ceiling.toString(),
    asset: 'USD',
    scale: 2,
  };
}

// ── Runtime bridge ──────────────────────────────────────────────────────────

/** The slice of CapixAgentRuntime the default executor needs. */
export interface OrchestrationRuntimeBridge {
  createChildSession(
    parentSessionId: string,
    role: string,
    mandate: string
  ): Promise<{ id: string }>;
  sendMessage(input: { sessionId: string; content: string }): AsyncIterable<AgentEvent>;
}

/**
 * Build a DelegationExecutor that runs each delegation as a specialist child
 * session on the shared runtime: usage events feed the engine's cost
 * tracking, tool calls surface as progress steps, and the turn's finish
 * reason decides the outcome.
 */
export function createRuntimeExecutor(
  runtime: OrchestrationRuntimeBridge,
  parentSessionId: string,
  engine: OrchestrationEngine
): DelegationExecutor {
  return async (delegation, signal) => {
    const child = await runtime.createChildSession(
      parentSessionId,
      delegation.role,
      delegation.context ? `${delegation.context}\n\n${delegation.task}` : delegation.task
    );
    let lastTool = '';
    let failed: string | null = null;
    let summary = '';
    for await (const event of runtime.sendMessage({
      sessionId: child.id,
      content: delegation.task,
    })) {
      if (signal.aborted) break;
      if (event.type === 'tool.started') {
        lastTool = event.toolName;
        engine.updateProgress(delegation.id, 0.5, `running ${event.toolName}`);
      } else if (event.type === 'usage.updated') {
        engine.recordUsage(delegation.id, {
          inputUnits: event.inputUnits,
          outputUnits: event.outputUnits,
          costMinor: event.costMinor,
        });
      } else if (event.type === 'content.delta') {
        summary += event.content;
      } else if (event.type === 'turn.failed') {
        failed = event.error.message;
      }
    }
    if (signal.aborted) return { outcome: 'failed', summary: 'cancelled' };
    if (failed) return { outcome: 'failed', summary: failed };
    return {
      outcome: 'success',
      summary:
        summary.trim().slice(0, 500) ||
        (lastTool ? `finished after ${lastTool}` : 'turn completed'),
    };
  };
}
