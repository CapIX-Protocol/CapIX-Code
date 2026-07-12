/**
 * @capix/agent-runtime — intelligence event contracts.
 *
 * Stable contracts for intelligence-driven events that both Capix Code TUI
 * and CapixIDE must handle. These are TYPE CONTRACTS ONLY — the actual
 * implementations live in the TUI and IDE clients that consume
 * @capix/agent-runtime.
 *
 * The intelligence layer (plans, agents, memory, checkpoints, receipts)
 * emits events when durable state changes. Clients subscribe via the
 * `IntelligenceEvents` registration methods so they can:
 *  - refresh plan-aware UI when a new plan is persisted;
 *  - update the agents panel when a specialist is spawned;
 *  - surface a "memory written" indicator when a decision/constraint lands;
 *  - mark a checkpoint as safe-to-resume-from when one is created;
 *  - refresh the receipts / billing view when a work receipt is anchored.
 *
 * Refs:
 *  - architecture §12.3 (broker), §12.4 (provider/routing)
 *  - intelligence commands (commands/*.md) — each command persists state via
 *    `src/intelligence-client.ts` and the server emits the matching event.
 *
 * This package intentionally does NOT import the host's
 * `src/intelligence-client.ts` — the runtime contracts are self-contained so
 * both clients can depend on @capix/agent-runtime alone. The richer API
 * client types live in `src/intelligence-client.ts` and are structurally
 * compatible with the payloads emitted here (the field names line up).
 */

/** Function returned by an `on*` registration; calling it cancels the subscription. */
export type Unsubscribe = () => void;

/** Generic callback signature for intelligence events. */
export type IntelligenceEventCallback<T> = (event: T) => void;

// ── Shared value types (self-contained; mirror src/intelligence-client.ts) ──

export type MemoryNodeType = 'decision' | 'constraint' | 'fact' | 'observation' | 'plan' | 'risk';

export type AgentTrustLevel = 'untrusted' | 'sandboxed' | 'trusted' | 'privileged';

export type VerificationGateStatus = 'pass' | 'fail' | 'skipped';

export type ReceiptKind =
  'inference' | 'infra-provision' | 'infra-destroy' | 'verification' | 'review';

export type ReceiptOutcome = 'success' | 'failed' | 'partial';

// ── Event payload types ───────────────────────────────────────────────────

/** Emitted when `/plan` (or the plans API) persists a new plan. */
export interface PlanCreatedEvent {
  /** The newly-created plan id (e.g. `P-0042`). */
  planId: string;
  /** Goal sentence — load-bearing for context injection. */
  goal: string;
  /** Snapshot of the definition-of-done checklist (verbatim). */
  definitionOfDone: string[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /** The agent or command that created the plan. */
  source: string;
  /** Project id (audience scope), if scoped. */
  projectId?: string;
}

/** Emitted when `/delegate` (or the agents API) spawns a specialist agent. */
export interface AgentSpawnedEvent {
  /** The new agent id. */
  agentId: string;
  /** The agent kind / specialist class. */
  kind: string;
  /** Trust level granted by the spawn. */
  trustLevel: AgentTrustLevel;
  /** Lineage depth from the root agent (0 = root). */
  generation: number;
  /** One-sentence objective the agent was spawned with. */
  objective: string;
  /** Parent agent id (null if root). */
  parentAgentId: string | null;
  /** ISO timestamp of spawn. */
  createdAt: string;
  /** The command or agent that spawned this one. */
  source: string;
  /** Project id (audience scope), if scoped. */
  projectId?: string;
}

/** Emitted when `/remember` (or the memory API) writes a memory node. */
export interface MemoryWrittenEvent {
  /** The new memory node id. */
  nodeId: string;
  /** Node type — drives how it's rendered in context. */
  nodeType: MemoryNodeType;
  /** The persisted content (one line summary is fine for UI). */
  content: string;
  /** Source (command/agent/human). */
  source: string;
  /** Confidence in `[0, 1]`. */
  confidence: number;
  /** ISO timestamp of write. */
  createdAt: string;
  /** Project id (audience scope), if scoped. */
  projectId?: string;
}

/** Emitted when `/checkpoint` (or the checkpoints API) records a checkpoint. */
export interface CheckpointCreatedEvent {
  /** The new checkpoint id. */
  checkpointId: string;
  /** Optional human label. */
  label?: string;
  /** Git commit the checkpoint was taken at. */
  commit: string;
  /** Branch at checkpoint time. */
  branch: string;
  /** Whether the working tree was dirty. */
  dirty: boolean;
  /** Verification gate results. */
  verification: {
    typecheck: VerificationGateStatus;
    lint: VerificationGateStatus;
    tests: VerificationGateStatus;
    testCounts: { passed: number; failed: number; skipped: number };
  };
  /** Linked plan id, if any. */
  planId?: string;
  /** ISO timestamp of checkpoint. */
  createdAt: string;
  /** The command or agent that took the checkpoint. */
  source: string;
  /** Project id (audience scope), if scoped. */
  projectId?: string;
}

/** Emitted when any command (or the receipts API) creates a work receipt. */
export interface ReceiptCreatedEvent {
  /** The new receipt id. */
  receiptId: string;
  /** Receipt kind — drives icon/severity. */
  kind: ReceiptKind;
  /** Agent that produced the work, if any. */
  agentId?: string;
  /** Cost in minor units of `asset`. */
  costMinor: string;
  /** ISO 4217-like asset code (e.g. `USD`). */
  asset: string;
  /** Scale factor (e.g. 6 = cents). */
  scale: number;
  /** Whether the receipt is anchored to a checkpoint/work-batch. */
  anchored: boolean;
  /** Anchor id, if anchored. */
  anchorId?: string;
  /** One-line summary. */
  summary: string;
  /** Outcome (success/failed/partial). */
  outcome?: ReceiptOutcome;
  /** ISO timestamp of the receipt. */
  timestamp: string;
  /** Project id (audience scope), if scoped. */
  projectId?: string;
}

/**
 * Intelligence event subscriptions both clients MUST implement.
 *
 * Each `on*` method registers a callback for the matching server-emitted
 * intelligence event and returns an `Unsubscribe` function. Implementations
 * are responsible for wiring the underlying transport (SSE, websocket, or
 * polling) — this interface only defines the registration contract.
 *
 * Implementations MUST:
 *  - support multiple registrations per event type (fan-out);
 *  - call callbacks in registration order;
 *  - never block the transport on a slow callback — dispatch asynchronously;
 *  - guarantee `Unsubscribe` is idempotent (safe to call after the
 *    subscription was already removed);
 *  - tolerate a callback that throws (log + continue, do not break the fan-out).
 */
export interface IntelligenceEvents {
  onPlanCreated(cb: IntelligenceEventCallback<PlanCreatedEvent>): Unsubscribe;
  onAgentSpawned(cb: IntelligenceEventCallback<AgentSpawnedEvent>): Unsubscribe;
  onMemoryWritten(cb: IntelligenceEventCallback<MemoryWrittenEvent>): Unsubscribe;
  onCheckpointCreated(cb: IntelligenceEventCallback<CheckpointCreatedEvent>): Unsubscribe;
  onReceiptCreated(cb: IntelligenceEventCallback<ReceiptCreatedEvent>): Unsubscribe;
}

/**
 * Optional mixin: clients that want to expose the full intelligence event
 * surface alongside the base `AgentRuntime` should implement this combined
 * interface. Both the TUI and CapixIDE are expected to; downstream tooling
 * can probe for `IntelligenceEvents` to decide whether intelligence-aware
 * features (plan panels, agents view, checkpoint badges) should render.
 */
export interface IntelligenceAwareRuntime {
  readonly intelligence: IntelligenceEvents;
}
