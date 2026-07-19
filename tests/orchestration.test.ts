/**
 * Tests for the orchestration stack:
 *
 * - `packages/agent-runtime/src/orchestration.ts` — pipeline state machine,
 *   parallel execution coordination, per-specialist cost tracking (integer
 *   minor units), delegation history persistence (SQLite), smart specialist
 *   suggestions, and cost estimation;
 * - `src/tui/orchestration-panel.ts` — store + pure renderers;
 * - `src/tui/delegation-manager.ts` — one-click delegation, templates,
 *   previews with cost estimation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  OrchestrationEngine,
  RuntimeStore,
  createRuntimeExecutor,
  estimateDelegationCost,
  rowToDelegation,
  delegationToRow,
  suggestSpecialists,
  PIPELINE_STAGES,
  type AgentEvent,
  type Delegation,
  type DelegationResult,
  type OrchestrationEvent,
} from '@capix/agent-runtime';
import {
  OrchestrationPanelStore,
  progressBar,
  renderCostBreakdown,
  renderDelegationHistory,
  renderOrchestrationLine,
  renderOrchestrationPanel,
  renderParallelView,
  renderPipeline,
  renderSpecialistStatuses,
  renderSuggestions,
} from '../src/tui/orchestration-panel.js';
import {
  DELEGATION_TEMPLATES,
  DelegationManager,
  getDelegationTemplate,
  renderDelegationPreview,
} from '../src/tui/delegation-manager.js';

/** Flush the microtask/macrotask queue so executor promise chains settle. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const okExecutor = async (d: Delegation): Promise<DelegationResult> => ({
  outcome: 'success',
  summary: `done: ${d.task}`,
});

// ── Engine: delegation + parallel coordination ──────────────────────────────

describe('OrchestrationEngine delegation', () => {
  it('runs a delegation through the executor and records the outcome', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const events: OrchestrationEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const delegation = engine.delegate({ role: 'implement', task: 'add auth' });
    // A free parallel slot starts the delegation synchronously.
    expect(delegation.status).toBe('running');

    await flush();

    const final = engine.getDelegation(delegation.id)!;
    expect(final.status).toBe('completed');
    expect(final.outcome).toBe('success');
    expect(final.summary).toBe('done: add auth');
    expect(final.progress).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      'delegation.queued',
      'delegation.started',
      'delegation.completed',
    ]);
  });

  it('rejects unknown specialist roles', () => {
    const engine = new OrchestrationEngine();
    expect(() => engine.delegate({ role: 'nope', task: 'x' })).toThrow(/unknown specialist/);
  });

  it('respects maxParallel and drains the FIFO queue', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const engine = new OrchestrationEngine({
      maxParallel: 1,
      executor: async (d) => {
        started.push(d.task);
        if (d.task === 'first') await gate;
        return { outcome: 'success', summary: d.task };
      },
    });

    engine.delegate({ role: 'implement', task: 'first' });
    engine.delegate({ role: 'test', task: 'second' });
    await flush(2);

    expect(started).toEqual(['first']);
    expect(engine.getActiveDelegations()).toHaveLength(1);
    expect(engine.getQueuedDelegations()).toHaveLength(1);
    expect(engine.getQueuedDelegations()[0].task).toBe('second');

    release();
    await flush();

    expect(started).toEqual(['first', 'second']);
    expect(engine.getActiveDelegations()).toHaveLength(0);
    expect(engine.getHistory().every((d) => d.status === 'completed')).toBe(true);
  });

  it('cancels a running delegation and aborts its executor', async () => {
    let aborted = false;
    const engine = new OrchestrationEngine({
      executor: async (_d, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        return { outcome: 'failed', summary: 'cancelled' };
      },
    });
    const delegation = engine.delegate({ role: 'explore', task: 'map repo' });
    await flush(2);

    await engine.cancelDelegation(delegation.id);
    await flush(2);

    expect(aborted).toBe(true);
    expect(engine.getDelegation(delegation.id)!.status).toBe('cancelled');
  });

  it('accumulates usage in integer minor units (BigInt arithmetic)', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const delegation = engine.delegate({ role: 'review', task: 'check diff' });
    await flush(2);

    engine.recordUsage(delegation.id, { inputUnits: 100, outputUnits: 50, costMinor: '7' });
    engine.recordUsage(delegation.id, { inputUnits: 5, outputUnits: 5, costMinor: BigInt(3) });

    const final = engine.getDelegation(delegation.id)!;
    expect(final.costMinor).toBe('10');
    expect(final.inputUnits).toBe(105);
    expect(final.outputUnits).toBe(55);
  });

  it('rolls up cost per specialist, most expensive first', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const a = engine.delegate({ role: 'implement', task: 'build a' });
    const b = engine.delegate({ role: 'implement', task: 'build b' });
    const c = engine.delegate({ role: 'test', task: 'test a' });
    await flush();

    engine.recordUsage(a.id, { costMinor: '500' });
    engine.recordUsage(b.id, { costMinor: '300' });
    engine.recordUsage(c.id, { costMinor: '120' });

    const breakdown = engine.getCostBreakdown();
    expect(breakdown[0]).toMatchObject({ role: 'implement', delegations: 2, costMinor: '800' });
    expect(breakdown[1]).toMatchObject({ role: 'test', delegations: 1, costMinor: '120' });
  });

  it('reports per-specialist live status', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const engine = new OrchestrationEngine({
      maxParallel: 1,
      executor: async () => {
        await gate;
        return { outcome: 'success', summary: 'ok' };
      },
    });
    const running = engine.delegate({ role: 'implement', task: 'build feature' });
    engine.delegate({ role: 'test', task: 'write tests' });
    await flush(2);
    engine.updateProgress(running.id, 0.4, 'running edit_file');

    const statuses = engine.getSpecialistStatuses();
    const implement = statuses.find((s) => s.role === 'implement')!;
    const test = statuses.find((s) => s.role === 'test')!;
    const review = statuses.find((s) => s.role === 'review')!;

    expect(implement.state).toBe('running');
    expect(implement.currentTask).toBe('build feature');
    expect(implement.progress).toBe(0.4);
    expect(implement.currentStep).toBe('running edit_file');
    expect(implement.activeDelegationId).toBe(running.id);
    expect(test.state).toBe('queued');
    expect(review.state).toBe('idle');

    release();
    await flush();
  });
});

// ── Engine: pipeline state machine ──────────────────────────────────────────

describe('OrchestrationEngine pipeline', () => {
  it('walks plan → implement → test → review → deploy, handing summaries forward', async () => {
    const seen: Array<{ role: string; stage: string | null; context: string }> = [];
    const engine = new OrchestrationEngine({
      executor: async (d) => {
        seen.push({ role: d.role, stage: d.stage, context: d.context });
        return { outcome: 'success', summary: `${d.stage} done` };
      },
    });

    const pipeline = engine.createPipeline('ship auth');
    expect(pipeline.status).toBe('draft');
    expect(pipeline.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);

    await engine.startPipeline(pipeline.id);
    await flush(20);

    const final = engine.getPipeline(pipeline.id)!;
    expect(final.status).toBe('completed');
    expect(final.stages.every((s) => s.status === 'completed')).toBe(true);
    expect(seen.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    // Default stage→specialist mapping.
    expect(seen.map((s) => s.role)).toEqual(['explore', 'implement', 'test', 'review', 'deploy']);
    // The deploy stage received every prior stage's summary as context.
    expect(seen[4].context).toContain('plan: plan done');
    expect(seen[4].context).toContain('review: review done');
  });

  it('blocks on stage failure and resumes on retryStage', async () => {
    let attempts = 0;
    const events: OrchestrationEvent[] = [];
    const engine = new OrchestrationEngine({
      executor: async (d) => {
        if (d.stage === 'implement' && attempts++ === 0) {
          return { outcome: 'failed', summary: 'compile error' };
        }
        return { outcome: 'success', summary: `${d.stage} ok` };
      },
    });
    engine.subscribe((e) => events.push(e));

    const pipeline = engine.createPipeline('goal');
    await engine.startPipeline(pipeline.id);
    await flush(10);

    let state = engine.getPipeline(pipeline.id)!;
    expect(state.status).toBe('blocked');
    expect(state.stages.find((s) => s.stage === 'implement')!.status).toBe('failed');
    expect(events.some((e) => e.type === 'pipeline.blocked' && e.stage === 'implement')).toBe(true);

    await engine.retryStage(pipeline.id, 'implement');
    await flush(20);

    state = engine.getPipeline(pipeline.id)!;
    expect(state.status).toBe('completed');
  });

  it('skipStage jumps a failed stage and finishes the pipeline', async () => {
    const engine = new OrchestrationEngine({
      executor: async (d) =>
        d.stage === 'deploy'
          ? { outcome: 'failed', summary: 'no capacity' }
          : { outcome: 'success', summary: 'ok' },
    });
    const pipeline = engine.createPipeline('goal');
    await engine.startPipeline(pipeline.id);
    await flush(20);

    expect(engine.getPipeline(pipeline.id)!.status).toBe('blocked');
    engine.skipStage(pipeline.id, 'deploy');
    await flush(5);

    const state = engine.getPipeline(pipeline.id)!;
    expect(state.status).toBe('completed');
    expect(state.stages.find((s) => s.stage === 'deploy')!.status).toBe('skipped');
  });

  it('honours stage subsets and specialist overrides', async () => {
    const roles: string[] = [];
    const engine = new OrchestrationEngine({
      executor: async (d) => {
        roles.push(d.role);
        return { outcome: 'success', summary: 'ok' };
      },
    });
    const pipeline = engine.createPipeline('quick fix', {
      stages: ['implement', 'review'],
      specialistOverrides: { review: 'security' },
    });
    await engine.startPipeline(pipeline.id);
    await flush(10);

    expect(roles).toEqual(['implement', 'security']);
    expect(engine.getPipeline(pipeline.id)!.stages).toHaveLength(2);
  });

  it('cancelPipeline aborts the in-flight stage delegation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const engine = new OrchestrationEngine({
      executor: async () => {
        await gate;
        return { outcome: 'success', summary: 'ok' };
      },
    });
    const pipeline = engine.createPipeline('goal');
    await engine.startPipeline(pipeline.id);
    await flush(3);

    await engine.cancelPipeline(pipeline.id);
    release();
    await flush(3);

    expect(engine.getPipeline(pipeline.id)!.status).toBe('cancelled');
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe('orchestration persistence', () => {
  let store: RuntimeStore;

  beforeEach(() => {
    store = new RuntimeStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('persists delegation history through RuntimeStore', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor, persistence: store });
    const delegation = engine.delegate({ role: 'security', task: 'scan secrets' });
    await flush();
    engine.recordUsage(delegation.id, { costMinor: '42', inputUnits: 10, outputUnits: 4 });

    const row = store.getDelegation(delegation.id)!;
    expect(row.role).toBe('security');
    expect(row.status).toBe('completed');
    expect(row.outcome).toBe('success');
    expect(row.cost_minor).toBe('42');
    expect(store.listDelegations(10)).toHaveLength(1);
  });

  it('rehydrates history on boot and cancels orphaned in-flight delegations', () => {
    store.insertDelegation(
      delegationToRow({
        id: 'dlg_old',
        pipelineId: null,
        stage: null,
        role: 'implement',
        task: 'interrupted task',
        context: '',
        status: 'running',
        progress: 0.5,
        currentStep: 'running bash',
        costMinor: '9',
        inputUnits: 3,
        outputUnits: 2,
        outcome: null,
        summary: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
      })
    );

    const engine = new OrchestrationEngine({ persistence: store });
    const restored = engine.getDelegation('dlg_old')!;
    expect(restored.status).toBe('cancelled');
    expect(restored.error).toBe('interrupted by restart');
    expect(restored.costMinor).toBe('9');
    expect(engine.getHistory()).toHaveLength(1);
  });

  it('row mapping round-trips', () => {
    const delegation: Delegation = {
      id: 'dlg_x',
      pipelineId: 'pipe_1',
      stage: 'test',
      role: 'test',
      task: 'write tests',
      context: 'handoff',
      status: 'completed',
      progress: 1,
      currentStep: null,
      costMinor: '17',
      inputUnits: 11,
      outputUnits: 6,
      outcome: 'partial',
      summary: 'some passed',
      error: null,
      createdAt: '2026-07-19T00:00:00.000Z',
      startedAt: '2026-07-19T00:00:01.000Z',
      completedAt: '2026-07-19T00:00:02.000Z',
    };
    expect(rowToDelegation(delegationToRow(delegation))).toEqual(delegation);
  });
});

// ── Suggestions + estimation ────────────────────────────────────────────────

describe('suggestSpecialists', () => {
  it('scores the security specialist for vulnerability tasks', () => {
    const [top] = suggestSpecialists('scan for injection vulnerabilities and leaked secrets');
    expect(top.role).toBe('security');
    expect(top.score).toBeGreaterThan(0.5);
    expect(top.matchedKeywords.length).toBeGreaterThanOrEqual(2);
    expect(top.reason).toContain('matches');
  });

  it('suggests deploy for shipping tasks', () => {
    const [top] = suggestSpecialists('deploy the app to production with docker and ssl');
    expect(top.role).toBe('deploy');
  });

  it('returns matches sorted by score and capped by max', () => {
    const suggestions = suggestSpecialists('implement a feature and add tests', { max: 2 });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].score).toBeGreaterThanOrEqual(suggestions[1].score);
  });

  it('returns nothing for unmatchable tasks', () => {
    expect(suggestSpecialists('xyzzy plugh')).toEqual([]);
  });
});

describe('estimateDelegationCost', () => {
  it('estimates as an integer fraction of the specialist ceiling', () => {
    const estimate = estimateDelegationCost('implement', { complexity: 'medium' })!;
    // implement ceiling is 500 USD minor units; medium is 50%.
    expect(estimate.ceilingMinor).toBe('500');
    expect(estimate.estimatedMinor).toBe('250');
    expect(estimate.asset).toBe('USD');
    expect(estimate.scale).toBe(2);
  });

  it('scales with complexity', () => {
    const low = estimateDelegationCost('explore', { complexity: 'low' })!;
    const high = estimateDelegationCost('explore', { complexity: 'high' })!;
    expect(BigInt(low.estimatedMinor)).toBeLessThan(BigInt(high.estimatedMinor));
  });

  it('returns null for unknown roles', () => {
    expect(estimateDelegationCost('nope')).toBeNull();
  });
});

// ── Runtime bridge ──────────────────────────────────────────────────────────

describe('createRuntimeExecutor', () => {
  it('streams a child-session turn into engine usage + outcome', async () => {
    const events: AgentEvent[] = [
      {
        type: 'tool.started',
        toolName: 'edit_file',
        version: 1,
        eventId: 'e1',
        sessionId: 'child',
        turnId: 't1',
        timestamp: '',
        correlationId: '',
        redaction: 'public',
      },
      {
        type: 'usage.updated',
        inputUnits: 10,
        outputUnits: 4,
        costMinor: '33',
        asset: 'USDC',
        scale: 6,
        version: 1,
        eventId: 'e2',
        sessionId: 'child',
        turnId: 't1',
        timestamp: '',
        correlationId: '',
        redaction: 'public',
      },
      {
        type: 'content.delta',
        content: 'implemented the feature',
        version: 1,
        eventId: 'e3',
        sessionId: 'child',
        turnId: 't1',
        timestamp: '',
        correlationId: '',
        redaction: 'public',
      },
    ];
    const bridge = {
      createChildSession: async () => ({ id: 'child' }),
      sendMessage: async function* () {
        yield* events;
      },
    };

    // Executor needs the engine for usage/progress reporting; the engine
    // needs the executor at construction. Wire the cycle lazily — the
    // executor only runs after `delegate`, when the engine exists.
    const engine: OrchestrationEngine = new OrchestrationEngine({
      executor: (d, signal): Promise<DelegationResult> =>
        createRuntimeExecutor(bridge, 'parent', engine)(d, signal),
    });
    const delegation = engine.delegate({ role: 'implement', task: 'add feature' });
    await flush();

    const final = engine.getDelegation(delegation.id)!;
    expect(final.status).toBe('completed');
    expect(final.costMinor).toBe('33');
    expect(final.summary).toBe('implemented the feature');
  });
});

// ── TUI renderers ───────────────────────────────────────────────────────────

describe('orchestration panel renderers', () => {
  async function makeState() {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const d1 = engine.delegate({ role: 'implement', task: 'add auth middleware' });
    engine.delegate({ role: 'test', task: 'write auth tests' });
    await flush();
    engine.recordUsage(d1.id, { costMinor: '123' });
    engine.updateProgress(d1.id, 0.6, 'running edit_file');
    const pipeline = engine.createPipeline('ship auth');
    await engine.startPipeline(pipeline.id);
    await flush(20);

    const store = new OrchestrationPanelStore();
    store.setEngine(engine);
    store.suggestFor('deploy to production with ssl');
    return store.snapshot();
  }

  it('progressBar renders fill and unknown states', () => {
    expect(progressBar(0.5, 10)).toBe('█████░░░░░');
    expect(progressBar(null, 4)).toBe('····');
    expect(progressBar(1.5, 4)).toBe('████');
  });

  it('renderPipeline shows stage flow with glyphs and summaries', async () => {
    const state = await makeState();
    const text = renderPipeline(state.pipeline);
    expect(text).toContain('plan ✓');
    expect(text).toContain('implement ✓');
    expect(text).toContain('deploy ✓');
    expect(text).toContain('[completed]');
    expect(text).toContain('─▶');

    expect(renderPipeline(null)).toContain('plan → implement → test → review → deploy');
  });

  it('renderSpecialistStatuses shows task, progress and spend', async () => {
    const state = await makeState();
    const text = renderSpecialistStatuses(state.specialists);
    expect(text).toContain('Implement Agent');
    expect(text).toContain('USD');
    expect(text).toContain('idle');
  });

  it('renderParallelView lists running and queued delegations', () => {
    const running: Delegation[] = [
      {
        id: 'd1',
        pipelineId: null,
        stage: null,
        role: 'implement',
        task: 'build the thing',
        context: '',
        status: 'running',
        progress: 0.3,
        currentStep: 'running bash',
        costMinor: '42',
        inputUnits: 0,
        outputUnits: 0,
        outcome: null,
        summary: null,
        error: null,
        createdAt: '2026-07-19T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
      },
    ];
    const queued: Delegation[] = [{ ...running[0], id: 'd2', role: 'test', status: 'queued' }];
    const text = renderParallelView(running, queued);
    expect(text).toContain('1 running / 1 queued');
    expect(text).toContain('build the thing');
    expect(text).toContain('(queued)');

    expect(renderParallelView([], [])).toBe('Delegations: none in flight');
  });

  it('renderDelegationHistory shows outcomes with cost', async () => {
    const state = await makeState();
    const text = renderDelegationHistory(state.history);
    expect(text).toContain('Delegation history');
    expect(text).toContain('✓');
  });

  it('renderCostBreakdown totals per-agent spend', async () => {
    const state = await makeState();
    const text = renderCostBreakdown(state.costs);
    expect(text).toContain('Cost per agent');
    expect(text).toContain('delegation');
    expect(renderCostBreakdown([])).toBe('Cost per agent: no spend yet');
  });

  it('renderSuggestions lists scored specialists', async () => {
    const state = await makeState();
    const text = renderSuggestions(state.suggestions);
    expect(text).toContain('Deploy Agent');
    expect(text).toContain('%');
  });

  it('renderOrchestrationPanel composes all sections', async () => {
    const state = await makeState();
    const text = renderOrchestrationPanel(state);
    for (const section of [
      'Pipeline',
      'Specialists',
      'Suggested specialists',
      'Cost per agent',
      'Delegation history',
    ]) {
      expect(text).toContain(section);
    }
  });

  it('renderOrchestrationLine summarizes for the status bar', async () => {
    const state = await makeState();
    expect(renderOrchestrationLine(state)).toMatch(/^orchestration: .+ · USD .+ spent$/);
  });
});

// ── Delegation manager ──────────────────────────────────────────────────────

describe('DelegationManager', () => {
  it('delegates one-click with the top suggestion and records history', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const manager = new DelegationManager(engine);

    const delegation = manager.delegate('deploy the service to production');
    expect(delegation.role).toBe('deploy');
    await flush();
    expect(engine.getDelegation(delegation.id)!.status).toBe('completed');
  });

  it('falls back to implement when nothing matches', () => {
    const manager = new DelegationManager(new OrchestrationEngine());
    expect(manager.resolveRole('xyzzy plugh')).toBe('implement');
  });

  it('previews cost and alternatives before delegating', () => {
    const manager = new DelegationManager(new OrchestrationEngine());
    const preview = manager.preview('scan for injection vulnerabilities');
    expect(preview.role).toBe('security');
    expect(preview.estimate.role).toBe('security');
    expect(BigInt(preview.estimate.estimatedMinor)).toBeLessThanOrEqual(
      BigInt(preview.estimate.ceilingMinor)
    );
    const text = renderDelegationPreview(preview);
    expect(text).toContain('Security Agent');
    expect(text).toContain('est. cost');
    expect(text).toContain('ceiling');
  });

  it('applies templates with {task} substitution and context', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const manager = new DelegationManager(engine);

    const delegation = manager.applyTemplate('security-audit', 'the auth module', {
      context: 'repo: capix',
    });
    expect(delegation.role).toBe('security');
    expect(delegation.task).toContain('the auth module');
    expect(delegation.context).toContain('repo: capix');
    await flush();
    expect(engine.getDelegation(delegation.id)!.status).toBe('completed');
  });

  it('exposes the template roster and lookup', () => {
    expect(DELEGATION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(getDelegationTemplate('write-tests')!.role).toBe('test');
    expect(getDelegationTemplate('nope')).toBeNull();

    const manager = new DelegationManager(new OrchestrationEngine());
    expect(manager.listTemplates().map((t) => t.id)).toContain('deploy-cloud');
  });

  it('rejects unknown templates and roles', () => {
    const manager = new DelegationManager(new OrchestrationEngine());
    expect(() => manager.preview('x', { templateId: 'nope' })).toThrow(
      /unknown delegation template/
    );
    expect(() => manager.preview('x', { role: 'nope' })).toThrow(/unknown specialist role/);
  });
});
