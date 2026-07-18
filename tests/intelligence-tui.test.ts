import { describe, expect, it, vi } from 'vitest';
import type {
  Checkpoint,
  Covenant,
  GraphQueryOutput,
  MemoryNode,
  WorkReceipt,
} from '../src/intelligence-client.js';
import {
  IntelligenceContext,
  IntelligencePanelStore,
  buildPromptInjection,
  rankMemoryForPrompt,
  renderCheckpointList,
  renderCovenantIndicator,
  renderCovenantSegment,
  renderGraph,
  renderIntelligencePanel,
  renderMemoryNodes,
  renderReceiptHistory,
} from '../src/tui/index.js';
import type { IntelligenceContextClient, IntelligencePanelClient } from '../src/tui/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function memoryNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem_0000000001',
    content: 'Use integer minor units for all money',
    nodeType: 'decision',
    source: 'capix-code',
    confidence: 0.92,
    status: 'active',
    tags: ['money', 'ledger'],
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

const MEMORY: MemoryNode[] = [
  memoryNode({ id: 'mem_dec1', content: 'Money is integer minor units, never floats' }),
  memoryNode({
    id: 'mem_con1',
    nodeType: 'constraint',
    content: 'Never embed bearer tokens in config or logs',
    confidence: 0.99,
    tags: ['security'],
  }),
  memoryNode({
    id: 'mem_fact1',
    nodeType: 'fact',
    content: 'Production API origin is https://www.capix.network',
    confidence: 0.8,
  }),
  memoryNode({
    id: 'mem_obs1',
    nodeType: 'observation',
    content: 'Staging gateway occasionally 502s under load',
    confidence: 0.5,
  }),
  memoryNode({
    id: 'mem_old',
    content: 'Old decision that was replaced',
    status: 'superseded',
    supersededBy: 'mem_dec1',
  }),
];

const GRAPH: GraphQueryOutput = {
  nodes: [
    { id: 'mem_dec1', type: 'memory', content: 'Money is integer minor units' },
    { id: 'plan_001', type: 'plan', content: 'Ledger migration plan' },
    { id: 'rcpt_001', type: 'receipt', content: 'Inference receipt' },
    { id: 'file_x', type: 'file', content: 'src/ledger.ts' },
  ],
  relationships: [
    { id: 'rel_1', sourceId: 'mem_dec1', targetId: 'plan_001', type: 'supports', weight: 0.9 },
    { id: 'rel_2', sourceId: 'plan_001', targetId: 'rcpt_001', type: 'produced' },
  ],
};

const COVENANT: Covenant = {
  id: 'cov_1',
  version: 'v1.2',
  ratifiedAt: '2026-07-01T00:00:00.000Z',
  rules: [
    { id: 'r1', invariant: 'never deploy to prod without approval', appliesTo: 'deploy', effect: 'ask' },
    { id: 'r2', invariant: 'deny rm -rf outside worktree', appliesTo: 'command', effect: 'deny' },
    { id: 'r3', invariant: 'allow read-only file access', appliesTo: 'tool', effect: 'allow' },
    { id: 'r4', invariant: 'allow local tests', appliesTo: 'command', effect: 'allow' },
  ],
};

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'cp_1',
    label: 'ledger migration green',
    repoState: { commit: 'abc1234def', branch: 'main', dirty: false, diffStat: '3 files changed' },
    verification: {
      typecheck: 'pass',
      lint: 'pass',
      tests: 'pass',
      testCounts: { passed: 42, failed: 0, skipped: 1 },
    },
    activeAgentIds: [],
    receiptSummary: { count: 3, totalCostMinor: '129900', asset: 'USD', scale: 2 },
    source: 'capix-code',
    createdAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

function receipt(overrides: Partial<WorkReceipt> = {}): WorkReceipt {
  return {
    id: 'rcpt_1',
    kind: 'inference',
    costMinor: '129900',
    asset: 'USD',
    scale: 2,
    timestamp: '2026-07-18T12:00:00.000Z',
    anchored: true,
    summary: 'Planner call for ledger migration',
    outcome: 'success',
    ...overrides,
  };
}

function fakePanelClient(overrides: Partial<IntelligencePanelClient> = {}): IntelligencePanelClient {
  return {
    retrieveMemory: vi.fn().mockResolvedValue({ nodes: MEMORY }),
    graphQuery: vi.fn().mockResolvedValue(GRAPH),
    getActiveCovenant: vi.fn().mockResolvedValue(COVENANT),
    listCheckpoints: vi.fn().mockResolvedValue({ checkpoints: [checkpoint()] }),
    listReceipts: vi.fn().mockResolvedValue({ receipts: [receipt()] }),
    ...overrides,
  };
}

// ── Panel renderers ──────────────────────────────────────────────────────────

describe('intelligence panel — memory nodes', () => {
  it('groups nodes by type with confidence and active counts', () => {
    const out = renderMemoryNodes(MEMORY);
    expect(out).toContain('Memory (4 active / 5 total)');
    expect(out).toContain('decisions:');
    expect(out).toContain('constraints:');
    expect(out).toContain('facts:');
    expect(out).toContain('observations:');
    expect(out).toContain('[0.92] Money is integer minor units, never floats');
    // Decisions render before constraints (panel order).
    expect(out.indexOf('decisions:')).toBeLessThan(out.indexOf('constraints:'));
  });

  it('marks superseded nodes with their replacement', () => {
    const out = renderMemoryNodes(MEMORY);
    expect(out).toContain('(superseded by mem_dec1)');
  });

  it('caps nodes per type and reports the remainder', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      memoryNode({ id: `mem_d${i}`, content: `decision ${i}` })
    );
    const out = renderMemoryNodes(many, { maxPerType: 3 });
    expect(out).toContain('decision 2');
    expect(out).not.toContain('decision 3');
    expect(out).toContain('… and 4 more');
  });

  it('renders an empty state', () => {
    expect(renderMemoryNodes([])).toBe('Memory: none recorded yet');
  });
});

describe('intelligence panel — knowledge graph', () => {
  it('renders relationships as an adjacency list with weights', () => {
    const out = renderGraph(GRAPH);
    expect(out).toContain('Knowledge graph (4 nodes, 2 edges)');
    expect(out).toContain('memory:mem_dec1 ──supports──▶ plan:plan_001 (0.90)');
    expect(out).toContain('plan:plan_001 ──produced──▶ receipt:rcpt_001');
  });

  it('summarizes isolated nodes by type', () => {
    const out = renderGraph(GRAPH);
    expect(out).toContain('isolated: 1 file');
  });

  it('caps edges and reports the remainder', () => {
    const out = renderGraph(GRAPH, { maxEdges: 1 });
    expect(out).toContain('… and 1 more edges');
  });

  it('renders an empty graph', () => {
    expect(renderGraph({ nodes: [], relationships: [] })).toBe('Knowledge graph: empty');
  });
});

describe('intelligence panel — covenant indicator', () => {
  it('renders version, ratification date, and rule effect counts', () => {
    expect(renderCovenantIndicator(COVENANT)).toBe(
      'covenant v1.2 · ratified 2026-07-01 · 4 rules (2 allow / 1 deny / 1 ask)'
    );
  });

  it('renders the no-covenant state', () => {
    expect(renderCovenantIndicator(null)).toBe('no active covenant');
  });
});

describe('intelligence panel — checkpoints', () => {
  it('renders repo state, verification, and receipt summary', () => {
    const out = renderCheckpointList([checkpoint()]);
    expect(out).toContain('Checkpoints (1)');
    expect(out).toContain('2026-07-18 abc1234 (main) ledger migration green');
    expect(out).toContain('typecheck ✓ lint ✓ tests ✓ 42/0');
    expect(out).toContain('3 receipts · USD 1299.00');
  });

  it('marks dirty worktrees and failing verification', () => {
    const dirty = checkpoint({
      label: undefined,
      repoState: { commit: 'def5678', branch: 'wip', dirty: true, diffStat: '1 file changed' },
      verification: {
        typecheck: 'fail',
        lint: 'skipped',
        tests: 'pass',
        testCounts: { passed: 10, failed: 2, skipped: 0 },
      },
      receiptSummary: { count: 0, totalCostMinor: '0', asset: 'USD', scale: 2 },
    });
    const out = renderCheckpointList([dirty]);
    expect(out).toContain('def5678 (wip*)');
    expect(out).toContain('typecheck ✗ lint – tests ✓ 10/2');
    expect(out).not.toContain('receipts ·');
  });

  it('renders an empty state', () => {
    expect(renderCheckpointList([])).toBe('Checkpoints: none yet');
  });
});

describe('intelligence panel — receipt history', () => {
  it('renders kind, integer-minor-unit cost, anchored marker, and summary', () => {
    const out = renderReceiptHistory([receipt()]);
    expect(out).toContain('Receipts (1)');
    expect(out).toContain('⚓ 2026-07-18 inference USD 1299.00 — Planner call for ledger migration');
  });

  it('marks non-success outcomes and unanchored receipts', () => {
    const failed = receipt({ anchored: false, outcome: 'failed', summary: 'Provision timed out' });
    const out = renderReceiptHistory([failed]);
    expect(out).toContain('inference USD 1299.00 [failed] — Provision timed out');
    expect(out).not.toContain('⚓');
  });

  it('renders an empty state', () => {
    expect(renderReceiptHistory([])).toBe('Receipts: none yet');
  });
});

describe('intelligence panel — store + composition', () => {
  it('refresh populates every section and notifies listeners', async () => {
    const store = new IntelligencePanelStore(fakePanelClient());
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.refreshing ? 'refreshing' : 'settled'));

    await store.refresh({ projectId: 'proj_1' });

    const state = store.snapshot();
    expect(state.memory).toHaveLength(MEMORY.length);
    expect(state.graph?.nodes).toHaveLength(GRAPH.nodes.length);
    expect(state.covenant?.version).toBe('v1.2');
    expect(state.checkpoints).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.errors).toEqual([]);
    expect(state.refreshedAt).not.toBeNull();
    // Listeners saw both the start and the end of the refresh.
    expect(seen).toEqual(['refreshing', 'settled']);
  });

  it('partial refresh failures keep prior data and record warnings', async () => {
    const store = new IntelligencePanelStore(
      fakePanelClient({
        retrieveMemory: vi.fn().mockRejectedValue(new Error('boom')),
        getActiveCovenant: vi.fn().mockRejectedValue(new Error('401')),
      })
    );

    await store.refresh();

    const state = store.snapshot();
    expect(state.memory).toEqual([]);
    expect(state.covenant).toBeNull();
    expect(state.checkpoints).toHaveLength(1);
    expect(state.errors).toEqual(['memory: boom', 'covenant: 401']);

    const panel = renderIntelligencePanel(state);
    expect(panel).toContain('no active covenant');
    expect(panel).toContain('warnings: memory: boom; covenant: 401');
  });

  it('renders the full panel with all sections separated', () => {
    const state = {
      memory: MEMORY,
      graph: GRAPH,
      covenant: COVENANT,
      checkpoints: [checkpoint()],
      receipts: [receipt()],
      refreshing: false,
      refreshedAt: '2026-07-18T12:00:00.000Z',
      errors: [],
    };
    const panel = renderIntelligencePanel(state);
    expect(panel).toContain('covenant v1.2');
    expect(panel).toContain('Memory (4 active / 5 total)');
    expect(panel).toContain('Knowledge graph (4 nodes, 2 edges)');
    expect(panel).toContain('Checkpoints (1)');
    expect(panel).toContain('Receipts (1)');
  });
});

// ── Context injection ────────────────────────────────────────────────────────

function fakeContextClient(overrides: Partial<IntelligenceContextClient> = {}): IntelligenceContextClient {
  return {
    retrieveMemory: vi.fn().mockResolvedValue({ nodes: MEMORY }),
    getActiveCovenant: vi.fn().mockResolvedValue(COVENANT),
    ...overrides,
  };
}

describe('intelligence context — ranking', () => {
  it('ranks prompt-relevant nodes first, constraints above facts', () => {
    const ranked = rankMemoryForPrompt(MEMORY, 'how should we handle money in the ledger?');
    expect(ranked[0]?.content).toContain('Money is integer minor units');
    expect(ranked.every((n) => n.status === 'active')).toBe(true);
  });

  it('drops nodes with no keyword overlap with the prompt', () => {
    const ranked = rankMemoryForPrompt(MEMORY, 'ledger money units');
    expect(ranked.map((n) => n.id)).toContain('mem_dec1');
    expect(ranked.map((n) => n.id)).not.toContain('mem_obs1');
  });

  it('excludes non-injectable types and inactive nodes', () => {
    const ranked = rankMemoryForPrompt(MEMORY, 'staging gateway load replaced');
    expect(ranked.map((n) => n.id)).not.toContain('mem_obs1');
    expect(ranked.map((n) => n.id)).not.toContain('mem_old');
  });

  it('falls back to confidence ordering when the prompt has no usable tokens', () => {
    const ranked = rankMemoryForPrompt(MEMORY, '???');
    expect(ranked[0]?.id).toBe('mem_con1'); // confidence 0.99
  });
});

describe('intelligence context — injection block', () => {
  it('groups nodes under binding-order headings', () => {
    const block = buildPromptInjection(MEMORY);
    expect(block).toContain('## Project memory');
    expect(block).toContain('Constraints:');
    expect(block).toContain('Decisions:');
    expect(block).toContain('Facts:');
    expect(block.indexOf('Constraints:')).toBeLessThan(block.indexOf('Decisions:'));
    expect(block).not.toContain('staging gateway'); // observations never injected
  });

  it('respects the character cap, dropping nodes whole', () => {
    const block = buildPromptInjection(MEMORY, { maxChars: 200 });
    expect(block.length).toBeLessThanOrEqual(200);
    expect(block).toContain('Constraints:');
    // The fact does not fit the budget and is dropped whole.
    expect(block).not.toContain('Facts:');
  });

  it('returns an empty string when there is nothing to inject', () => {
    expect(buildPromptInjection([])).toBe('');
    expect(buildPromptInjection(MEMORY, { maxChars: 10 })).toBe('');
  });
});

describe('intelligence context — covenant segment', () => {
  it('renders a compact status-bar segment', () => {
    expect(renderCovenantSegment(COVENANT)).toBe('covenant v1.2 (4 rules)');
    expect(renderCovenantSegment(null)).toBe('covenant none');
  });
});

describe('intelligence context — store', () => {
  it('auto-loads project context on first use and caches within the TTL', async () => {
    const client = fakeContextClient();
    const ctx = new IntelligenceContext(client, { ttlMs: 60_000 });

    await ctx.ensureLoaded({ projectId: 'proj_1' });
    await ctx.ensureLoaded({ projectId: 'proj_1' });

    expect(client.retrieveMemory).toHaveBeenCalledTimes(1);
    expect(client.getActiveCovenant).toHaveBeenCalledTimes(1);
    const snap = ctx.snapshot();
    expect(snap.memory).toHaveLength(MEMORY.length);
    expect(snap.covenant?.version).toBe('v1.2');
    expect(snap.error).toBeNull();
  });

  it('refetches after invalidation', async () => {
    const client = fakeContextClient();
    const ctx = new IntelligenceContext(client);
    await ctx.ensureLoaded();
    ctx.invalidate();
    await ctx.ensureLoaded();
    expect(client.retrieveMemory).toHaveBeenCalledTimes(2);
  });

  it('injects relevant memory into prompts once loaded', async () => {
    const ctx = new IntelligenceContext(fakeContextClient());
    await ctx.ensureLoaded();

    const augmented = ctx.augmentPrompt('update the ledger money handling');
    expect(augmented).toContain('## Project memory');
    expect(augmented).toContain('- Money is integer minor units, never floats');
    expect(augmented.endsWith('update the ledger money handling')).toBe(true);
  });

  it('returns the prompt untouched when no memory is loaded', () => {
    const ctx = new IntelligenceContext(fakeContextClient());
    expect(ctx.augmentPrompt('hello')).toBe('hello');
  });

  it('load failures are non-blocking and retried on the next turn', async () => {
    const retrieveMemory = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ nodes: MEMORY });
    const getActiveCovenant = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(COVENANT);
    const ctx = new IntelligenceContext({ retrieveMemory, getActiveCovenant });

    await ctx.ensureLoaded(); // both fail
    expect(ctx.snapshot().error).toContain('network down');
    expect(ctx.augmentPrompt('plain')).toBe('plain');

    await ctx.ensureLoaded(); // fully failed load does not count as fresh — retries
    expect(retrieveMemory).toHaveBeenCalledTimes(2);
    expect(ctx.snapshot().error).toBeNull();
    expect(ctx.covenantSegment()).toBe('covenant v1.2 (4 rules)');
  });

  it('keeps good sections when only one fetch fails', async () => {
    const ctx = new IntelligenceContext(
      fakeContextClient({ getActiveCovenant: vi.fn().mockRejectedValue(new Error('401')) })
    );
    await ctx.ensureLoaded();
    expect(ctx.snapshot().memory).toHaveLength(MEMORY.length);
    expect(ctx.snapshot().error).toBe('covenant: 401');
    expect(ctx.covenantSegment()).toBe('covenant none');
  });
});
