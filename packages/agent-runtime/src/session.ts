/**
 * @capix/agent-runtime — session lifecycle contracts.
 *
 * Stable contracts for creating, resuming, and managing agent sessions.
 * Both Capix Code TUI and CapixIDE use these to interact with the
 * shared agent runtime.
 */

import type { AgentEvent } from './events.js';
import type { AgentMode } from './modes.js';
import type { SpecialistAgent } from './specialists.js';

export interface CreateSessionInput {
  /** Adopt an externally-assigned session id (e.g. the host engine's). */
  sessionId?: string;
  modelId?: string;
  projectId?: string;
  workspaceRoot?: string;
  sandboxProfile?: 'restricted' | 'developer' | 'host';
  routeMode?: 'auto' | 'private' | 'routed';
  privateEndpointId?: string;
  instructions?: string;
  /** Initial mode; defaults to 'build'. */
  mode?: AgentMode;
  parentSessionId?: string;
  specialistRole?: string;
}

export interface Session {
  id: string;
  modelId: string;
  projectId?: string;
  routeMode: 'auto' | 'private' | 'routed';
  mode: AgentMode;
  workspaceRoot?: string;
  parentSessionId?: string;
  specialistRole?: string;
  createdAt: string;
  updatedAt: string;
  totalInputUnits: number;
  totalOutputUnits: number;
  totalCostMinor: string;
  status: 'active' | 'idle' | 'completed' | 'failed';
}

export type PlanStepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';

export interface PlanStepInput {
  description: string;
  files?: string[];
  tests?: string[];
}

export interface RuntimePlanStep {
  stepId: string;
  idx: number;
  description: string;
  status: PlanStepStatus;
  files: string[];
  tests: string[];
}

export interface RuntimePlan {
  planId: string;
  sessionId: string;
  goal: string;
  status: 'draft' | 'active' | 'completed' | 'abandoned';
  definitionOfDone: string[];
  steps: RuntimePlanStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanInput {
  goal: string;
  definitionOfDone?: string[];
  steps?: PlanStepInput[];
}

export interface SendMessageInput {
  sessionId: string;
  content: string;
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ListSessionsInput {
  limit?: number;
  cursor?: string;
}

export interface ListSessionsOutput {
  sessions: Session[];
  nextCursor?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  isAuto?: boolean;
}

export interface UsageSummary {
  totalInputUnits: number;
  totalOutputUnits: number;
  totalCostMinor: string;
  asset: string;
  scale: number;
  receiptIds: string[];
}

export interface ReceiptInfo {
  id: string;
  modelCapability: string;
  region: string;
  privacyClass: string;
  costMinor: string;
  asset: string;
  scale: number;
  timestamp: string;
}

/** Settlement epoch status (root anchors the CPX ledger). */
export interface SettlementStatus {
  epoch: string;
  root: string;
  cluster: string;
  paused: boolean;
}

/** A single settlement epoch record. */
export interface SettlementEpoch {
  epoch: string;
  root: string;
  cluster: string;
  startedAt: string;
  finalizedAt?: string;
  leafCount: string;
  paused: boolean;
}

/** Local receipt verification result (proof recomputed client-side). */
export interface ReceiptVerification {
  verified: boolean;
  root: string;
}

/**
 * The shared agent runtime contract. Both Capix Code TUI and CapixIDE
 * implement this interface (or a client of it) to provide:
 *
 * - Session lifecycle (create, resume, list, dispose)
 * - Message streaming (send message → stream of AgentEvent)
 * - Cancellation
 * - Tool approval/rejection
 * - Model listing and selection
 * - Usage and receipt queries
 * - Workspace attachment
 * - Diff and patch operations
 * - Command execution
 */
export interface AgentRuntime {
  readonly version: string;

  createSession(input: CreateSessionInput): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsOutput>;
  disposeSession(sessionId: string): Promise<void>;

  sendMessage(input: SendMessageInput): AsyncGenerator<AgentEvent>;
  cancelTurn(sessionId: string): Promise<void>;

  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<void>;

  listModels(): Promise<ModelInfo[]>;
  selectModel(sessionId: string, modelId: string): Promise<void>;

  getUsage(sessionId: string): Promise<UsageSummary>;
  getReceipts(sessionId: string): Promise<ReceiptInfo[]>;

  /** Fetch the current settlement epoch status (CPX ledger root). */
  getSettlementStatus(sessionId: string): Promise<SettlementStatus>;
  /**
   * Verify a receipt's Merkle proof locally. The proof package is fetched
   * from the API but the cryptographic check (recompute leaf hash, walk
   * sibling path, compare root) is performed client-side.
   */
  verifyReceipt(receiptId: string): Promise<ReceiptVerification>;
  /** Fetch a specific settlement epoch by number. */
  getEpoch(sessionId: string, epoch: bigint): Promise<SettlementEpoch>;

  attachWorkspace(sessionId: string, workspaceRoot: string): Promise<void>;

  // ── Modes ───────────────────────────────────────────────────────────────
  setMode(sessionId: string, mode: AgentMode): Promise<void>;
  getMode(sessionId: string): Promise<AgentMode>;

  // ── Plans ───────────────────────────────────────────────────────────────
  createPlan(sessionId: string, input: CreatePlanInput): Promise<RuntimePlan>;
  getPlan(planId: string): Promise<RuntimePlan>;
  listPlans(sessionId: string): Promise<RuntimePlan[]>;
  updatePlanStep(planId: string, stepId: string, status: PlanStepStatus): Promise<RuntimePlan>;

  // ── Specialists ─────────────────────────────────────────────────────────
  listSpecialists(): SpecialistAgent[];

  getDiff(sessionId: string, filePath?: string): Promise<{ filePath: string; diff: string }[]>;
  applyPatch(sessionId: string, filePath: string, patch: string): Promise<void>;

  // ── Child sessions / specialist agents ────────────────────────────────
  createChildSession(parentSessionId: string, role: string, mandate: string): Promise<Session>;
  listChildSessions(parentSessionId: string): Promise<Session[]>;
  cancelChildSession(sessionId: string): Promise<void>;

  runCommand(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<{ exitCode: number; output: string }>;
}
