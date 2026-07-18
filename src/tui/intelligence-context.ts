/**
 * TUI intelligence context — automatic memory injection and covenant status
 * for the capix-code TUI.
 *
 * The `IntelligenceContext` store auto-loads the project's intelligence
 * context (active memory nodes + the active covenant) from the intelligence
 * API, caches it for a short TTL, and exposes:
 *  - `augmentPrompt(prompt)` — prepend the memory nodes most relevant to the
 *    prompt (decisions, constraints, facts) so the model sees project context
 *    without the user pasting anything;
 *  - `covenantSegment()` — a compact covenant indicator for the status bar;
 *  - `snapshot()` — the raw cached context for other renderers.
 *
 * All API failures are non-blocking: on error the store keeps the last good
 * context, and `augmentPrompt` returns the prompt untouched. The TUI's own
 * prompt path must never be broken by an intelligence outage.
 */

import * as intelligence from '../intelligence-client.js';
import type { Covenant, MemoryNode, MemoryNodeType } from '../intelligence-client.js';

/** The slice of the intelligence client context injection needs. */
export interface IntelligenceContextClient {
  retrieveMemory: typeof intelligence.retrieveMemory;
  getActiveCovenant: typeof intelligence.getActiveCovenant;
}

export interface IntelligenceContextSnapshot {
  memory: MemoryNode[];
  covenant: Covenant | null;
  /** ISO timestamp of the last successful load; null before the first one. */
  loadedAt: string | null;
  /** Message from the last failed load, if any. */
  error: string | null;
}

export interface IntelligenceContextOptions {
  /** Cache TTL in ms before `ensureLoaded` refetches. Default 60s. */
  ttlMs?: number;
  /** Max memory nodes to fetch per load. Default 50. */
  fetchLimit?: number;
}

/** Memory node types eligible for prompt injection, most binding first. */
const INJECTABLE_TYPES: ReadonlyArray<{ type: MemoryNodeType; heading: string }> = [
  { type: 'constraint', heading: 'Constraints' },
  { type: 'decision', heading: 'Decisions' },
  { type: 'fact', heading: 'Facts' },
];

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FETCH_LIMIT = 50;

export class IntelligenceContext {
  private readonly client: IntelligenceContextClient;
  private readonly ttlMs: number;
  private readonly fetchLimit: number;
  private state: IntelligenceContextSnapshot = {
    memory: [],
    covenant: null,
    loadedAt: null,
    error: null,
  };
  private loading: Promise<void> | null = null;

  constructor(client: IntelligenceContextClient = intelligence, opts: IntelligenceContextOptions = {}) {
    this.client = client;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchLimit = opts.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  }

  /**
   * Auto-load project context when the cache is empty or stale. Concurrent
   * callers share one in-flight load. Never throws — failures are recorded in
   * `snapshot().error` and the previous context stays in place.
   */
  async ensureLoaded(opts: { projectId?: string; signal?: AbortSignal } = {}): Promise<void> {
    if (this.isFresh()) return;
    this.loading ??= this.load(opts).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Force the next `ensureLoaded` to refetch. */
  invalidate(): void {
    this.state.loadedAt = null;
  }

  snapshot(): IntelligenceContextSnapshot {
    return { ...this.state, memory: [...this.state.memory] };
  }

  /**
   * Inject the memory most relevant to `prompt` ahead of it. Ranking is
   * keyword-overlap plus confidence (see `rankMemoryForPrompt`); the injected
   * block is capped by `maxChars` so context stays bounded. Returns the prompt
   * unchanged when no memory is loaded.
   */
  augmentPrompt(
    prompt: string,
    opts: { maxNodes?: number; maxChars?: number } = {}
  ): string {
    const ranked = rankMemoryForPrompt(this.state.memory, prompt, {
      maxNodes: opts.maxNodes ?? 8,
    });
    const block = buildPromptInjection(ranked, { maxChars: opts.maxChars ?? 2_000 });
    if (!block) return prompt;
    return `${block}\n\n${prompt}`;
  }

  /**
   * Compact covenant indicator for the TUI status bar, e.g.
   * `covenant v1.2 (7 rules)` or `covenant none`. Appended to the session
   * status line by the renderer that consumes it.
   */
  covenantSegment(): string {
    return renderCovenantSegment(this.state.covenant);
  }

  private isFresh(): boolean {
    if (!this.state.loadedAt) return false;
    return Date.now() - Date.parse(this.state.loadedAt) < this.ttlMs;
  }

  private async load(opts: { projectId?: string; signal?: AbortSignal }): Promise<void> {
    const [memRes, covRes] = await Promise.allSettled([
      this.client.retrieveMemory({ status: 'active', limit: this.fetchLimit }, opts),
      this.client.getActiveCovenant(opts),
    ]);

    const errors: string[] = [];
    if (memRes.status === 'fulfilled') {
      this.state.memory = memRes.value.nodes;
    } else {
      errors.push(`memory: ${(memRes.reason as Error)?.message ?? 'unknown'}`);
    }
    if (covRes.status === 'fulfilled') {
      this.state.covenant = covRes.value;
    } else {
      errors.push(`covenant: ${(covRes.reason as Error)?.message ?? 'unknown'}`);
    }

    if (errors.length > 0) {
      this.state.error = errors.join('; ');
      // A fully failed load must not count as fresh — retry on the next turn.
      if (memRes.status === 'rejected' && covRes.status === 'rejected') {
        this.state.loadedAt = null;
        return;
      }
    } else {
      this.state.error = null;
    }
    this.state.loadedAt = new Date().toISOString();
  }
}

/** Shared process-wide store; the prompt path refreshes it lazily. */
export const intelligenceContext = new IntelligenceContext();

// ── Pure helpers ─────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{3,}/g);
  return new Set(tokens ?? []);
}

/**
 * Rank memory nodes for a prompt: score = keyword overlap with the prompt
 * (weighted by node type: constraints and decisions outrank facts) plus the
 * node's confidence. Only active, injectable nodes (constraints, decisions,
 * facts) are eligible; nodes with no signal at all are dropped unless the
 * prompt has no usable tokens, in which case confidence alone orders them.
 */
export function rankMemoryForPrompt(
  nodes: MemoryNode[],
  prompt: string,
  opts: { maxNodes?: number } = {}
): MemoryNode[] {
  const maxNodes = opts.maxNodes ?? 8;
  const promptTokens = tokenize(prompt);
  const typeWeight: Record<string, number> = { constraint: 3, decision: 2, fact: 1 };
  const eligible = INJECTABLE_TYPES.map((t) => t.type);

  const scored = nodes
    .filter((n) => n.status === 'active' && eligible.includes(n.nodeType))
    .map((node) => {
      const nodeTokens = tokenize(`${node.content} ${node.tags.join(' ')}`);
      let overlap = 0;
      for (const token of nodeTokens) {
        if (promptTokens.has(token)) overlap += 1;
      }
      const score = overlap * (typeWeight[node.nodeType] ?? 1) + node.confidence;
      return { node, overlap, score };
    })
    .filter((s) => promptTokens.size === 0 || s.overlap > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxNodes).map((s) => s.node);
}

/**
 * Format memory nodes as a prompt-injection block, grouped under Constraints /
 * Decisions / Facts headings and capped at `maxChars` (nodes that would exceed
 * the cap are dropped whole — a half-injected constraint is worse than none).
 * Returns an empty string when there is nothing to inject.
 */
export function buildPromptInjection(
  nodes: MemoryNode[],
  opts: { maxChars?: number } = {}
): string {
  const maxChars = opts.maxChars ?? 2_000;
  if (nodes.length === 0) return '';

  const header = '## Project memory (capix intelligence — treat as binding context)';
  const lines = [header];
  let used = header.length;
  for (const { type, heading } of INJECTABLE_TYPES) {
    const group = nodes.filter((n) => n.nodeType === type);
    if (group.length === 0) continue;
    const headingLine = `${heading}:`;
    const groupLines: string[] = [headingLine];
    let groupUsed = headingLine.length + 1;
    for (const node of group) {
      const line = `- ${node.content.replace(/\s+/g, ' ').trim()}`;
      if (used + groupUsed + line.length + 1 > maxChars) break;
      groupLines.push(line);
      groupUsed += line.length + 1;
    }
    if (groupLines.length === 1) continue; // heading alone — nothing fit
    lines.push(...groupLines);
    used += groupUsed;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Compact covenant indicator for the status bar: `covenant v1.2 (7 rules)`,
 * or `covenant none` when no covenant is ratified.
 */
export function renderCovenantSegment(covenant: Covenant | null): string {
  if (!covenant) return 'covenant none';
  return `covenant ${covenant.version} (${covenant.rules.length} rules)`;
}
