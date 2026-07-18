/**
 * TUI intelligence panel — store + plain-text renderers for the Capix
 * intelligence API surface.
 *
 * One store per process (the `intelligencePanel` singleton), refreshed by the
 * plugin and rendered by the TUI:
 *  - memory nodes (decisions, facts, constraints, …) from `/v1/memory`;
 *  - knowledge graph from `/v1/graph`;
 *  - covenant status from `/v1/covenants`;
 *  - checkpoints from `/v1/checkpoints`;
 *  - receipt history from `/v1/receipts`.
 *
 * All fetch failures are non-blocking: a partial refresh keeps the sections
 * that succeeded and records the failures in `errors`, so the panel degrades
 * instead of blanking out. Rendering is pure — every `render*` function takes
 * data and returns a string, so the TUI can compose them however it wants.
 *
 * Money stays in integer minor units end-to-end (`formatMoney` from
 * routing-client) — never floats.
 */

import * as intelligence from '../intelligence-client.js';
import type {
  Checkpoint,
  Covenant,
  GraphNode,
  GraphQueryOutput,
  MemoryNode,
  MemoryNodeType,
  WorkReceipt,
} from '../intelligence-client.js';
import { formatMoney } from '../routing-client.js';

/**
 * The slice of the intelligence client the panel needs. Injectable so tests
 * (and offline fixtures) can render without a live API.
 */
export interface IntelligencePanelClient {
  retrieveMemory: typeof intelligence.retrieveMemory;
  graphQuery: typeof intelligence.graphQuery;
  getActiveCovenant: typeof intelligence.getActiveCovenant;
  listCheckpoints: typeof intelligence.listCheckpoints;
  listReceipts: typeof intelligence.listReceipts;
}

export interface IntelligencePanelState {
  memory: MemoryNode[];
  graph: GraphQueryOutput | null;
  covenant: Covenant | null;
  checkpoints: Checkpoint[];
  receipts: WorkReceipt[];
  /** True while a refresh is in flight. */
  refreshing: boolean;
  /** ISO timestamp of the last completed refresh; null before the first one. */
  refreshedAt: string | null;
  /** Human-readable failures from the last refresh (one per failed section). */
  errors: string[];
}

export type IntelligencePanelListener = (state: IntelligencePanelState) => void;

const EMPTY_GRAPH: GraphQueryOutput = { nodes: [], relationships: [] };

function emptyState(): IntelligencePanelState {
  return {
    memory: [],
    graph: null,
    covenant: null,
    checkpoints: [],
    receipts: [],
    refreshing: false,
    refreshedAt: null,
    errors: [],
  };
}

export class IntelligencePanelStore {
  private state: IntelligencePanelState = emptyState();
  private readonly listeners = new Set<IntelligencePanelListener>();
  private readonly client: IntelligencePanelClient;

  constructor(client: IntelligencePanelClient = intelligence) {
    this.client = client;
  }

  /**
   * Refresh every panel section concurrently. Each section is best-effort: a
   * failure leaves the previous data for that section in place and appends an
   * entry to `errors`. Never throws.
   */
  async refresh(opts: { projectId?: string; signal?: AbortSignal } = {}): Promise<void> {
    this.state.refreshing = true;
    this.touch();

    const [memRes, graphRes, covRes, cpRes, rcptRes] = await Promise.allSettled([
      this.client.retrieveMemory({ status: 'active', limit: 50 }, opts),
      this.client.graphQuery({ depth: 1, limit: 25, includeRelationships: true }, opts),
      this.client.getActiveCovenant(opts),
      this.client.listCheckpoints({ limit: 10 }, opts),
      this.client.listReceipts({ limit: 10 }, opts),
    ]);

    const errors: string[] = [];
    if (memRes.status === 'fulfilled') {
      this.state.memory = memRes.value.nodes;
    } else {
      errors.push(`memory: ${(memRes.reason as Error)?.message ?? 'unknown'}`);
    }
    if (graphRes.status === 'fulfilled') {
      this.state.graph = graphRes.value;
    } else {
      errors.push(`graph: ${(graphRes.reason as Error)?.message ?? 'unknown'}`);
    }
    if (covRes.status === 'fulfilled') {
      this.state.covenant = covRes.value;
    } else {
      errors.push(`covenant: ${(covRes.reason as Error)?.message ?? 'unknown'}`);
    }
    if (cpRes.status === 'fulfilled') {
      this.state.checkpoints = cpRes.value.checkpoints;
    } else {
      errors.push(`checkpoints: ${(cpRes.reason as Error)?.message ?? 'unknown'}`);
    }
    if (rcptRes.status === 'fulfilled') {
      this.state.receipts = rcptRes.value.receipts;
    } else {
      errors.push(`receipts: ${(rcptRes.reason as Error)?.message ?? 'unknown'}`);
    }

    this.state.errors = errors;
    this.state.refreshing = false;
    this.state.refreshedAt = new Date().toISOString();
    this.touch();
  }

  /** Current immutable-ish snapshot for renderers. */
  snapshot(): IntelligencePanelState {
    return {
      ...this.state,
      memory: [...this.state.memory],
      graph: this.state.graph
        ? {
            nodes: [...this.state.graph.nodes],
            relationships: [...this.state.graph.relationships],
          }
        : null,
      covenant: this.state.covenant
        ? { ...this.state.covenant, rules: [...this.state.covenant.rules] }
        : null,
      checkpoints: [...this.state.checkpoints],
      receipts: [...this.state.receipts],
      errors: [...this.state.errors],
    };
  }

  subscribe(listener: IntelligencePanelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

/** Shared process-wide store; the plugin refreshes it, the TUI renders it. */
export const intelligencePanel = new IntelligencePanelStore();

// ── Renderers (pure) ─────────────────────────────────────────────────────────

/** Display order and glyphs for memory node types. */
const NODE_TYPE_ORDER: ReadonlyArray<{ type: MemoryNodeType; glyph: string }> = [
  { type: 'decision', glyph: '◆' },
  { type: 'constraint', glyph: '■' },
  { type: 'fact', glyph: '●' },
  { type: 'observation', glyph: '○' },
  { type: 'plan', glyph: '▲' },
  { type: 'risk', glyph: '!' },
];

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Memory nodes grouped by type (decisions first, then constraints, facts,
 * observations, plans, risks), each with confidence and a superseded marker.
 */
export function renderMemoryNodes(
  nodes: MemoryNode[],
  opts: { maxPerType?: number; width?: number } = {}
): string {
  const maxPerType = opts.maxPerType ?? 5;
  const width = opts.width ?? 100;
  if (nodes.length === 0) return 'Memory: none recorded yet';

  const active = nodes.filter((n) => n.status === 'active').length;
  const lines = [`Memory (${active} active / ${nodes.length} total)`];
  for (const { type, glyph } of NODE_TYPE_ORDER) {
    const group = nodes.filter((n) => n.nodeType === type);
    if (group.length === 0) continue;
    lines.push(`  ${type}s:`);
    for (const node of group.slice(0, maxPerType)) {
      const superseded =
        node.status === 'superseded'
          ? ` (superseded${node.supersededBy ? ` by ${shortId(node.supersededBy)}` : ''})`
          : node.status === 'deprecated'
            ? ' (deprecated)'
            : '';
      lines.push(
        `    ${glyph} [${node.confidence.toFixed(2)}] ${truncate(node.content, width)}${superseded}`
      );
    }
    if (group.length > maxPerType) {
      lines.push(`    … and ${group.length - maxPerType} more`);
    }
  }
  return lines.join('\n');
}

function nodeLabel(node: GraphNode): string {
  return `${node.type}:${shortId(node.id)}`;
}

/**
 * Knowledge graph as an adjacency list. Nodes with relationships render as
 * `source ──type──▶ target`; isolated nodes are listed by type. Edge weights
 * are shown when present.
 */
export function renderGraph(
  graph: GraphQueryOutput,
  opts: { maxEdges?: number; width?: number } = {}
): string {
  const maxEdges = opts.maxEdges ?? 20;
  const width = opts.width ?? 60;
  if (graph.nodes.length === 0) return 'Knowledge graph: empty';

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines = [`Knowledge graph (${graph.nodes.length} nodes, ${graph.relationships.length} edges)`];

  const edges = graph.relationships.slice(0, maxEdges);
  const connected = new Set<string>();
  for (const rel of edges) {
    const source = byId.get(rel.sourceId);
    const target = byId.get(rel.targetId);
    if (!source || !target) continue;
    connected.add(source.id);
    connected.add(target.id);
    const weight = rel.weight !== undefined ? ` (${rel.weight.toFixed(2)})` : '';
    lines.push(
      `  ${nodeLabel(source)} ──${truncate(rel.type, 16)}──▶ ${nodeLabel(target)}${weight}  ${truncate(source.content, width)}`
    );
  }
  if (graph.relationships.length > maxEdges) {
    lines.push(`  … and ${graph.relationships.length - maxEdges} more edges`);
  }

  const isolated = graph.nodes.filter((n) => !connected.has(n.id));
  if (isolated.length > 0) {
    const counts = new Map<string, number>();
    for (const n of isolated) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const summary = Array.from(counts.entries())
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');
    lines.push(`  isolated: ${summary}`);
  }
  return lines.join('\n');
}

/**
 * One-line covenant status indicator, e.g.:
 * `covenant v1.2 · ratified 2026-07-01 · 7 rules (5 allow / 1 deny / 1 ask)`
 * or `no active covenant`.
 */
export function renderCovenantIndicator(covenant: Covenant | null): string {
  if (!covenant) return 'no active covenant';
  const counts = { allow: 0, deny: 0, ask: 0 };
  for (const rule of covenant.rules) counts[rule.effect] += 1;
  return (
    `covenant ${covenant.version} · ratified ${shortDate(covenant.ratifiedAt)} · ` +
    `${covenant.rules.length} rules ` +
    `(${counts.allow} allow / ${counts.deny} deny / ${counts.ask} ask)`
  );
}

function verificationMark(result: 'pass' | 'fail' | 'skipped'): string {
  return result === 'pass' ? '✓' : result === 'fail' ? '✗' : '–';
}

/**
 * Checkpoint list: repo state, verification results, and the anchored receipt
 * summary for each checkpoint, most recent first (API order).
 */
export function renderCheckpointList(
  checkpoints: Checkpoint[],
  opts: { max?: number } = {}
): string {
  const max = opts.max ?? 10;
  if (checkpoints.length === 0) return 'Checkpoints: none yet';

  const lines = [`Checkpoints (${checkpoints.length})`];
  for (const cp of checkpoints.slice(0, max)) {
    const dirty = cp.repoState.dirty ? '*' : '';
    const label = cp.label ? ` ${cp.label}` : '';
    const v = cp.verification;
    const verification =
      `typecheck ${verificationMark(v.typecheck)} ` +
      `lint ${verificationMark(v.lint)} ` +
      `tests ${verificationMark(v.tests)} ${v.testCounts.passed}/${v.testCounts.failed}`;
    const receipts =
      cp.receiptSummary.count > 0
        ? ` · ${cp.receiptSummary.count} receipts · ${formatMoney({
            amountMinor: cp.receiptSummary.totalCostMinor,
            currency: cp.receiptSummary.asset,
            scale: cp.receiptSummary.scale,
          })}`
        : '';
    lines.push(
      `  ${shortDate(cp.createdAt)} ${cp.repoState.commit.slice(0, 7)} (${cp.repoState.branch}${dirty})${label} — ${verification}${receipts}`
    );
  }
  if (checkpoints.length > max) {
    lines.push(`  … and ${checkpoints.length - max} more`);
  }
  return lines.join('\n');
}

/**
 * Receipt history: one line per receipt with kind, integer-minor-unit cost,
 * anchored marker, outcome, and a truncated summary.
 */
export function renderReceiptHistory(
  receipts: WorkReceipt[],
  opts: { max?: number; width?: number } = {}
): string {
  const max = opts.max ?? 10;
  const width = opts.width ?? 60;
  if (receipts.length === 0) return 'Receipts: none yet';

  const lines = [`Receipts (${receipts.length})`];
  for (const receipt of receipts.slice(0, max)) {
    const anchored = receipt.anchored ? '⚓' : ' ';
    const outcome = receipt.outcome && receipt.outcome !== 'success' ? ` [${receipt.outcome}]` : '';
    const cost = formatMoney({
      amountMinor: receipt.costMinor,
      currency: receipt.asset,
      scale: receipt.scale,
    });
    lines.push(
      `  ${anchored} ${shortDate(receipt.timestamp)} ${receipt.kind} ${cost}${outcome} — ${truncate(receipt.summary, width)}`
    );
  }
  if (receipts.length > max) {
    lines.push(`  … and ${receipts.length - max} more`);
  }
  return lines.join('\n');
}

/**
 * Full intelligence panel: covenant indicator, memory, knowledge graph,
 * checkpoints, and receipt history, separated by blank lines. Refresh errors
 * (if any) are listed at the bottom so a partial outage is visible.
 */
export function renderIntelligencePanel(state: IntelligencePanelState): string {
  const sections = [
    renderCovenantIndicator(state.covenant),
    renderMemoryNodes(state.memory),
    renderGraph(state.graph ?? EMPTY_GRAPH),
    renderCheckpointList(state.checkpoints),
    renderReceiptHistory(state.receipts),
  ];
  if (state.refreshing && state.refreshedAt === null) {
    sections.push('refreshing…');
  }
  if (state.errors.length > 0) {
    sections.push(`warnings: ${state.errors.join('; ')}`);
  }
  return sections.join('\n\n');
}
