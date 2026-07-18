/**
 * TUI session status — the shared state store the capix-code TUI renders.
 *
 * One store per process (the `sessionStatus` singleton), fed by the plugin:
 *  - session / model / mode / agent state from plugin load + tool execution;
 *  - MCP health from the `McpSupervisor` listener;
 *  - spend from inference usage chunks and deployment receipts, accumulated
 *    in integer minor units (never floats).
 *
 * `renderStatusLine` produces the compact single-line summary the TUI status
 * bar shows; `snapshot` gives renderers the full structured state.
 */

import type { McpHealth } from '../mcp-supervisor.js';
import { formatMoney, type Money } from '../routing-client.js';

export type SessionAgentState =
  'idle' | 'planning' | 'awaiting-approval' | 'executing' | 'deploying' | 'training';

export interface SessionStatus {
  sessionId: string | null;
  /** Active model target, e.g. `capix/auto`. */
  model: string;
  /** Active agent mode (ask/plan/build/debug/review). */
  mode: string;
  agentState: SessionAgentState;
  mcp: McpHealth;
  /** Accumulated token usage this session, from inference usage events. */
  tokens: { input: number; output: number };
  /** Accumulated spend this session, integer minor units. */
  spend: Money;
  updatedAt: string;
}

export type SessionStatusListener = (status: SessionStatus) => void;

const DEFAULT_MCP_HEALTH: McpHealth = {
  state: 'disconnected',
  toolCount: 0,
  lastCheckedAt: '',
  restartCount: 0,
};

export class SessionStatusStore {
  private status: SessionStatus = {
    sessionId: null,
    model: 'capix/auto',
    mode: 'build',
    agentState: 'idle',
    mcp: { ...DEFAULT_MCP_HEALTH },
    tokens: { input: 0, output: 0 },
    spend: { amountMinor: '0', currency: 'USD', scale: 2 },
    updatedAt: new Date().toISOString(),
  };

  private readonly listeners = new Set<SessionStatusListener>();

  setSession(sessionId: string | null): void {
    this.status.sessionId = sessionId;
    this.touch();
  }

  setModel(model: string): void {
    if (!model) return;
    this.status.model = model;
    this.touch();
  }

  setMode(mode: string): void {
    if (!mode) return;
    this.status.mode = mode;
    this.touch();
  }

  setAgentState(agentState: SessionAgentState): void {
    this.status.agentState = agentState;
    this.touch();
  }

  setMcpHealth(mcp: McpHealth): void {
    this.status.mcp = { ...mcp };
    this.touch();
  }

  /**
   * Accumulate spend in integer minor units. Amounts in a different currency
   * or scale than the running total are ignored (and logged by the caller's
   * own path) rather than summed incorrectly.
   */
  recordSpend(amountMinor: string | bigint, currency?: string, scale?: number): void {
    const spend = this.status.spend;
    if (currency !== undefined && scale !== undefined) {
      if (spend.amountMinor === '0') {
        spend.currency = currency;
        spend.scale = scale;
      } else if (spend.currency !== currency || spend.scale !== scale) {
        return;
      }
    }
    spend.amountMinor = (BigInt(spend.amountMinor) + BigInt(amountMinor)).toString();
    this.touch();
  }

  /**
   * Record one inference usage event: real token counts plus (when present)
   * the provisional cost. Token counts are per-event deltas and accumulate;
   * cost is delegated to `recordSpend` (integer minor units, never floats).
   */
  recordUsage(
    inputTokens: number,
    outputTokens: number,
    cost?: { amount: string; asset: string; scale: number }
  ): void {
    this.status.tokens.input += Math.max(0, Math.trunc(inputTokens));
    this.status.tokens.output += Math.max(0, Math.trunc(outputTokens));
    if (cost) {
      this.recordSpend(cost.amount, cost.asset, cost.scale);
    } else {
      this.touch();
    }
  }

  /** Current immutable-ish snapshot for renderers. */
  snapshot(): SessionStatus {
    return {
      ...this.status,
      mcp: { ...this.status.mcp },
      tokens: { ...this.status.tokens },
      spend: { ...this.status.spend },
    };
  }

  subscribe(listener: SessionStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private touch(): void {
    this.status.updatedAt = new Date().toISOString();
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
export const sessionStatus = new SessionStatusStore();

/**
 * Compact one-line status for the TUI status bar, e.g.:
 * `capix/auto · build · executing │ mcp connected (42 tools) │ 1.2k in / 340 out tokens │ USD 1.23 spent`
 */
export function renderStatusLine(status: SessionStatus): string {
  const mcp =
    status.mcp.state === 'connected'
      ? `mcp connected (${status.mcp.toolCount} tools)`
      : status.mcp.state === 'disconnected'
        ? 'mcp disconnected'
        : `mcp ${status.mcp.state}`;
  const session = status.sessionId ? ` #${status.sessionId.slice(0, 8)}` : '';
  const tokens =
    status.tokens.input > 0 || status.tokens.output > 0
      ? `${status.tokens.input} in / ${status.tokens.output} out tokens │ `
      : '';
  return (
    `${status.model} · ${status.mode} · ${status.agentState}${session} │ ` +
    `${mcp} │ ${tokens}${formatMoney(status.spend)} spent`
  );
}
