/**
 * @capix/agent-runtime — shared runtime package.
 *
 * This package defines the stable contracts and event protocol used by
 * both Capix Code (TUI) and CapixIDE (graphical client) to interact
 * with the shared Capix agent runtime.
 *
 * The actual agent loop is provided by the upstream engine (Bun-compiled
 * opencode). This package owns the Capix-specific layer:
 * - session lifecycle contracts
 * - versioned event protocol
 * - error types and problem details
 * - tool approval contracts
 *
 * Both clients consume these types to ensure identical behavior.
 */

export { AGENT_EVENT_VERSION } from './events.js';
export type {
  AgentEvent,
  AgentEventType,
  RedactionClass,
  SessionStartedEvent,
  TurnStartedEvent,
  ReasoningDeltaEvent,
  ContentDeltaEvent,
  ToolRequestedEvent,
  ToolApprovedEvent,
  ToolRejectedEvent,
  ToolStartedEvent,
  ToolOutputEvent,
  FileDiffEvent,
  CommandOutputEvent,
  UsageUpdatedEvent,
  RouteReceiptEvent,
  CheckpointCreatedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  SessionCompletedEvent,
} from './events.js';

export type {
  AgentRuntime,
  CreateSessionInput,
  Session,
  SendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ModelInfo,
  UsageSummary,
  ReceiptInfo,
} from './session.js';

export { CAPIX_ERROR_CODES, CapixAgentError } from './contracts.js';
export type { CapixProblemDetail, CapixErrorCode, ClientMeta, RuntimeInfo } from './contracts.js';
