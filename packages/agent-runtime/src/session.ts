/**
 * @capix/agent-runtime — session lifecycle contracts.
 *
 * Stable contracts for creating, resuming, and managing agent sessions.
 * Both Capix Code TUI and CapixIDE use these to interact with the
 * shared agent runtime.
 */

import type { AgentEvent } from './events.js';

export interface CreateSessionInput {
  modelId?: string;
  projectId?: string;
  workspaceRoot?: string;
  sandboxProfile?: 'restricted' | 'developer' | 'host';
  routeMode?: 'auto' | 'private' | 'routed';
  privateEndpointId?: string;
  instructions?: string;
}

export interface Session {
  id: string;
  modelId: string;
  projectId?: string;
  routeMode: 'auto' | 'private' | 'routed';
  createdAt: string;
  updatedAt: string;
  totalInputUnits: number;
  totalOutputUnits: number;
  totalCostMinor: string;
  status: 'active' | 'idle' | 'completed' | 'failed';
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

  attachWorkspace(sessionId: string, workspaceRoot: string): Promise<void>;

  getDiff(sessionId: string, filePath?: string): Promise<{ filePath: string; diff: string }[]>;
  applyPatch(sessionId: string, filePath: string, patch: string): Promise<void>;

  runCommand(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<{ exitCode: number; output: string }>;
}
