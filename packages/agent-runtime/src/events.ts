/**
 * @capix/agent-runtime — shared event protocol.
 *
 * Versioned event types used by both Capix Code TUI and CapixIDE to
 * consume streaming agent output. Every event carries:
 * - version: protocol version (currently 1)
 * - eventId: unique identifier for this event
 * - sessionId: the session this event belongs to
 * - turnId: the turn within the session
 * - timestamp: ISO 8601
 * - correlationId: request/trace correlation
 * - causationId: the event that caused this one (if any)
 * - redaction: classification for log/screen redaction
 */

export const AGENT_EVENT_VERSION = 1 as const;

export type RedactionClass =
  | 'public' // safe to display in full
  | 'masked' // show truncated/summary only
  | 'redacted' // do not display content
  | 'internal'; // operator-only

export interface AgentEventBase {
  version: typeof AGENT_EVENT_VERSION;
  eventId: string;
  sessionId: string;
  turnId: string;
  timestamp: string;
  correlationId: string;
  causationId?: string;
  redaction: RedactionClass;
}

export interface SessionStartedEvent extends AgentEventBase {
  type: 'session.started';
  modelId: string;
  projectId?: string;
  routeMode: 'auto' | 'private' | 'routed';
}

export interface TurnStartedEvent extends AgentEventBase {
  type: 'turn.started';
  promptLength: number;
  modelId: string;
}

export interface ReasoningDeltaEvent extends AgentEventBase {
  type: 'reasoning.delta';
  delta: string;
}

export interface ContentDeltaEvent extends AgentEventBase {
  type: 'content.delta';
  content: string;
  role?: string;
}

export interface ToolRequestedEvent extends AgentEventBase {
  type: 'tool.requested';
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  network?: boolean;
  billable?: boolean;
  requiresApproval: boolean;
}

export interface ToolApprovedEvent extends AgentEventBase {
  type: 'tool.approved';
  toolName: string;
}

export interface ToolRejectedEvent extends AgentEventBase {
  type: 'tool.rejected';
  toolName: string;
  reason: string;
}

export interface ToolStartedEvent extends AgentEventBase {
  type: 'tool.started';
  toolName: string;
}

export interface ToolOutputEvent extends AgentEventBase {
  type: 'tool.output';
  toolName: string;
  output: string;
  isError: boolean;
  redaction: RedactionClass;
}

export interface FileDiffEvent extends AgentEventBase {
  type: 'file.diff';
  filePath: string;
  before: string;
  after: string;
  diff: string;
}

export interface CommandOutputEvent extends AgentEventBase {
  type: 'command.output';
  command: string;
  output: string;
  exitCode: number;
  redaction: RedactionClass;
}

export interface UsageUpdatedEvent extends AgentEventBase {
  type: 'usage.updated';
  inputUnits: number;
  outputUnits: number;
  costMinor: string;
  asset: string;
  scale: number;
}

export interface RouteReceiptEvent extends AgentEventBase {
  type: 'route.receipt';
  receiptId: string;
  modelCapability: string;
  region: string;
  privacyClass: string;
}

export interface CheckpointCreatedEvent extends AgentEventBase {
  type: 'checkpoint.created';
  checkpointId: string;
  filePaths: string[];
}

export interface TurnCompletedEvent extends AgentEventBase {
  type: 'turn.completed';
  finishReason: 'stop' | 'length' | 'tool_calls' | 'cancelled';
  totalInputUnits: number;
  totalOutputUnits: number;
  totalCostMinor: string;
}

export interface TurnFailedEvent extends AgentEventBase {
  type: 'turn.failed';
  error: {
    capixCode: string;
    message: string;
    retryClass: 'none' | 'retry' | 'retry-after';
    retryAfterMs?: number;
    supportId?: string;
  };
}

export interface SessionCompletedEvent extends AgentEventBase {
  type: 'session.completed';
  totalTurns: number;
  totalCostMinor: string;
}

/** Current settlement epoch status (root anchors the CPX ledger). */
export interface SettlementStatusEvent extends AgentEventBase {
  type: 'settlement.status';
  epoch: string;
  root: string;
  cluster: string;
  paused: boolean;
}

/** Result of a local Merkle proof verification (no API trust for the check). */
export interface ProofVerifiedEvent extends AgentEventBase {
  type: 'proof.verified';
  receiptId: string;
  verified: boolean;
  root: string;
}

export type AgentEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | ReasoningDeltaEvent
  | ContentDeltaEvent
  | ToolRequestedEvent
  | ToolApprovedEvent
  | ToolRejectedEvent
  | ToolStartedEvent
  | ToolOutputEvent
  | FileDiffEvent
  | CommandOutputEvent
  | UsageUpdatedEvent
  | RouteReceiptEvent
  | CheckpointCreatedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | SessionCompletedEvent
  | SettlementStatusEvent
  | ProofVerifiedEvent;

export type AgentEventType = AgentEvent['type'];
