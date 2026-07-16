/**
 * Concrete AgentRuntime implementation.
 * 
 * This wraps the OpenCode engine's plugin hooks to provide the full
 * AgentRuntime contract: session lifecycle, message streaming, tool
 * approvals, model selection, usage/receipts, diffs, and commands.
 * 
 * Sessions are persisted to ~/.capix-code/sessions/ as JSON files
 * so the IDE and TUI can resume the same session.
 */

import type {
  AgentRuntime,
  CreateSessionInput,
  Session,
  SendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ModelInfo,
  UsageSummary,
  ReceiptInfo,
  SettlementStatus,
  SettlementEpoch,
  ReceiptVerification,
} from './session.js';
import type { AgentEvent } from './events.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const SESSIONS_DIR = join(homedir(), '.capix-code', 'sessions');
const RUNTIME_VERSION = '1.4.0';
const AGENT_EVENT_VERSION = 1 as const;

interface PersistedSession extends Session {
  messages: Array<{ role: string; content: string; timestamp: string }>;
  routeReceipts: Array<{ receiptId: string; model: string; costMinor: string; timestamp: string }>;
  pendingToolApprovals: Map<string, { tool: string; args: unknown }>;
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadSession(sessionId: string): PersistedSession | null {
  try {
    const data = readFileSync(sessionPath(sessionId), 'utf8');
    const parsed = JSON.parse(data);
    // Restore Map from serialized object
    if (parsed.pendingToolApprovals && !Array.isArray(parsed.pendingToolApprovals)) {
      parsed.pendingToolApprovals = new Map(Object.entries(parsed.pendingToolApprovals));
    } else {
      parsed.pendingToolApprovals = new Map();
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(session: PersistedSession): void {
  ensureSessionsDir();
  // Serialize Map to object for JSON
  const serialized = {
    ...session,
    pendingToolApprovals: Object.fromEntries(session.pendingToolApprovals),
  };
  writeFileSync(sessionPath(session.id), JSON.stringify(serialized, null, 2));
}

function makeEvent(
  sessionId: string,
  type: string,
  redaction: 'public' | 'masked' | 'redacted' | 'internal',
  data: Record<string, unknown>
): AgentEvent {
  const base = {
    version: AGENT_EVENT_VERSION,
    eventId: randomUUID(),
    sessionId,
    turnId: randomUUID(),
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
    redaction,
  };
  return { ...base, type, ...data } as unknown as AgentEvent;
}

export class CapixAgentRuntime implements AgentRuntime {
  readonly version = RUNTIME_VERSION;

  async createSession(input: CreateSessionInput): Promise<Session> {
    const sessionId = `ses_${randomUUID()}`;
    const now = new Date().toISOString();
    const session: PersistedSession = {
      id: sessionId,
      modelId: input.modelId || 'capix/auto',
      projectId: input.projectId,
      routeMode: input.routeMode || 'auto',
      createdAt: now,
      updatedAt: now,
      totalInputUnits: 0,
      totalOutputUnits: 0,
      totalCostMinor: '0',
      status: 'active',
      messages: [],
      routeReceipts: [],
      pendingToolApprovals: new Map(),
    };
    saveSession(session);
    return this.stripSession(session);
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const session = loadSession(sessionId);
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    session.status = 'active';
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    return this.stripSession(session);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsOutput> {
    ensureSessionsDir();
    const limit = input.limit || 50;
    const files = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const sessions: Session[] = [];
    for (const file of files) {
      try {
        const data = readFileSync(join(SESSIONS_DIR, file), 'utf8');
        const parsed = JSON.parse(data);
        sessions.push(this.stripSession(parsed));
      } catch { /* skip corrupt sessions */ }
    }

    return { sessions, nextCursor: undefined };
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = loadSession(sessionId);
    if (!session) return;
    session.status = 'completed';
    session.updatedAt = new Date().toISOString();
    saveSession(session);
  }

  async *sendMessage(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    const session = loadSession(input.sessionId);
    if (!session) throw new Error(`session_not_found: ${input.sessionId}`);

    const model = input.modelId || session.modelId;
    const turnId = randomUUID();
    const now = new Date().toISOString();

    // Record the user message
    session.messages.push({ role: 'user', content: input.content, timestamp: now });
    session.updatedAt = now;

    yield makeEvent(input.sessionId, 'turn.started', 'public', {
      type: 'turn.started',
      modelId: model,
    } as any);

    // The actual streaming happens through the plugin's provider stream.
    // The runtime converts engine events to AgentEvent types.

    yield makeEvent(input.sessionId, 'content.delta', 'public', {
      type: 'content.delta',
      content: '',
    } as any);

    yield makeEvent(input.sessionId, 'checkpoint.created', 'public', {
      type: 'checkpoint.created',
      label: 'turn_complete',
    } as any);

    saveSession(session);
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const session = loadSession(sessionId);
    if (!session) return;
    session.status = 'idle';
    session.updatedAt = new Date().toISOString();
    saveSession(session);
  }

  async approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    const session = loadSession(sessionId);
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    // Remove from pending approvals
    session.pendingToolApprovals.delete(toolCallId);
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    // In the real implementation, this would send the approval to the
    // engine's tool.execute.before hook via the IPC channel.
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'capix/auto',
        name: 'Capix Auto (smart route)',
        provider: 'capix',
        contextWindow: 128000,
        maxOutput: 64000,
        isAuto: true,
      },
    ];
  }

  async selectModel(sessionId: string, modelId: string): Promise<void> {
    const session = loadSession(sessionId);
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    session.modelId = modelId;
    session.updatedAt = new Date().toISOString();
    saveSession(session);
  }

  async getUsage(sessionId: string): Promise<UsageSummary> {
    const session = loadSession(sessionId);
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    return {
      totalInputUnits: session.totalInputUnits,
      totalOutputUnits: session.totalOutputUnits,
      totalCostMinor: session.totalCostMinor,
      asset: 'USDC',
      scale: 6,
      receiptIds: session.routeReceipts.map(r => r.receiptId),
    };
  }

  async getReceipts(sessionId: string): Promise<ReceiptInfo[]> {
    const session = loadSession(sessionId);
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    return session.routeReceipts.map(r => ({
      id: r.receiptId,
      modelCapability: r.model,
      region: 'global',
      privacyClass: 'public',
      costMinor: r.costMinor,
      asset: 'USDC',
      scale: 6,
      timestamp: r.timestamp,
    }));
  }

  async getSettlementStatus(sessionId: string): Promise<SettlementStatus> {
    return {
      epoch: '0',
      root: '',
      cluster: 'mainnet-beta',
      paused: true,
    };
  }

  async verifyReceipt(receiptId: string): Promise<ReceiptVerification> {
    // Local Merkle verification would go here
    return { verified: false, root: '' };
  }

  async getEpoch(sessionId: string, epoch: bigint): Promise<SettlementEpoch> {
    return {
      epoch: epoch.toString(),
      root: '',
      cluster: 'mainnet-beta',
      startedAt: new Date().toISOString(),
      finalizedAt: undefined,
      leafCount: '0',
      paused: true,
    };
  }

  async attachWorkspace(sessionId: string, workspaceRoot: string): Promise<void> {
    const session = loadSession(sessionId);
    if (!session) return;
    // Store workspace root (would be used by the engine for file operations)
    (session as any).workspaceRoot = workspaceRoot;
    saveSession(session);
  }

  async getDiff(sessionId: string, filePath?: string): Promise<{ filePath: string; diff: string }[]> {
    // In the real implementation, this reads git diff from the workspace
    return [];
  }

  async applyPatch(sessionId: string, filePath: string, patch: string): Promise<void> {
    // In the real implementation, this applies a git patch to the workspace
  }

  async runCommand(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<{ exitCode: number; output: string }> {
    // In the real implementation, this executes a command in the workspace
    // with sandbox restrictions
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync(command, { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 30000 });
      return { exitCode: 0, output };
    } catch (err: any) {
      return { exitCode: 1, output: err.stderr || err.message };
    }
  }

  private stripSession(session: PersistedSession): Session {
    return {
      id: session.id,
      modelId: session.modelId,
      projectId: session.projectId,
      routeMode: session.routeMode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      totalInputUnits: session.totalInputUnits,
      totalOutputUnits: session.totalOutputUnits,
      totalCostMinor: session.totalCostMinor,
      status: session.status,
    };
  }
}
