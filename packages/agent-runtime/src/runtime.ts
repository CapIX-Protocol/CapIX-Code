/**
 * @capix/agent-runtime — concrete AgentRuntime implementation.
 *
 * A real agent runtime shared by the Capix Code TUI plugin and CapixIDE:
 *
 * - Modes (ask/plan/build/debug/review) gate every tool execution through a
 *   permission check; side-effectful tools wait for operator approval unless
 *   the mode allows them or the operator granted them for the session.
 * - Specialists (explore/implement/test/review/security/deploy) run as
 *   bounded child sessions with their own mandate and permission profile.
 * - Sessions, messages, events, tool calls, plans, diffs, and receipts are
 *   persisted to SQLite (`store.ts`) — durable across restarts, resumable
 *   from any client over ACP (`transport.ts`).
 * - Money is integer minor units end-to-end (BigInt arithmetic, TEXT columns).
 * - Errors are RFC 9457 problem details via `CapixAgentError`.
 *
 * Model access is injected as a `ModelInvoker` so the runtime never talks to
 * a provider directly; the host wires its broker-backed stream in. Customer-
 * facing output never names upstream providers — the only model target the
 * runtime lists is `capix/auto`, resolved server-authoritatively.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import type {
  AgentRuntime,
  CreatePlanInput,
  CreateSessionInput,
  ListSessionsInput,
  ListSessionsOutput,
  ModelInfo,
  PlanStepStatus,
  ReceiptInfo,
  ReceiptVerification,
  RuntimePlan,
  RuntimePlanStep,
  SendMessageInput,
  Session,
  SettlementEpoch,
  SettlementStatus,
  UsageSummary,
} from './session.js';
import type { AgentEvent, RedactionClass } from './events.js';
import { AGENT_EVENT_VERSION } from './events.js';
import { CapixAgentError, CAPIX_ERROR_CODES, type CapixProblemDetail } from './contracts.js';
import {
  checkModePermission,
  getModeProfile,
  isAgentMode,
  type AgentMode,
  type PermissionDecision,
} from './modes.js';
import { getSpecialist, listSpecialists, qualityTierFromModelId, type SpecialistAgent, type SpecialistQualityTier } from './specialists.js';
import {
  createBuiltinTools,
  resolveWorkspacePath,
  ToolRegistry,
  type ToolDefinition,
} from './tools.js';
import { applyUnifiedDiff, createUnifiedDiff } from './diff.js';
import {
  RECEIPT_ASSET,
  RECEIPT_SCALE,
  receiptLeafHash,
  receiptRowToLeafInput,
  sessionReceiptRoot,
} from './receipts.js';
import { RuntimeStore, DEFAULT_DB_PATH, type SessionRow } from './store.js';

const RUNTIME_VERSION = '2.4.19';
const DEFAULT_MODEL = 'capix/auto';
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

// ── Model access (injected by the host) ─────────────────────────────────────

export interface ModelRequest {
  modelId: string;
  mode: AgentMode;
  specialist?: SpecialistAgent;
  /**
   * Quality tier for this call: the specialist's own model preference when
   * the request is for a specialist child session, otherwise the runtime
   * default. Hosts forward it as `X-Capix-Quality-Tier`.
   */
  qualityTier?: SpecialistQualityTier;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
}

export type ModelChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown> }
  | { type: 'usage'; inputUnits: number; outputUnits: number; costMinor: string };

export type ModelInvoker = (req: ModelRequest) => AsyncIterable<ModelChunk>;

/**
 * Verdict returned by an `autoApprove` policy function. `true` approves; an
 * object decides immediately in either direction — `approved: false` is a
 * typed skip (the tool call is rejected with `reason`, which lands in the
 * transcript) rather than a wait for a human that will never come.
 */
export type AutoApprovalVerdict = boolean | { approved: boolean; reason?: string };

export interface RuntimeOptions {
  /** SQLite path; ':memory:' for tests. Defaults to ~/.capix-code/agent-runtime.db. */
  dbPath?: string;
  /** Fallback workspace root for sessions that don't attach one. */
  workspaceRoot?: string;
  /** Broker-backed model stream. Without one, turns fail with provider_error. */
  modelInvoker?: ModelInvoker;
  /** Approve tool calls without operator input (tests, trusted hosts). */
  autoApprove?: boolean | ((toolName: string, args: Record<string, unknown>) => AutoApprovalVerdict);
  /** Default quality tier for model calls without a specialist preference. */
  qualityTier?: SpecialistQualityTier;
  /** Max model↔tool rounds per turn. */
  maxToolRounds?: number;
}

function problem(
  status: number,
  capixCode: string,
  title: string,
  detail: string,
  extra?: Partial<CapixProblemDetail>
): CapixAgentError {
  return new CapixAgentError({
    type: `https://capix.network/problems/${capixCode}`,
    title,
    status,
    detail,
    capixCode,
    ...extra,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CapixAgentRuntime implements AgentRuntime {
  readonly version = RUNTIME_VERSION;

  readonly tools: ToolRegistry;
  private readonly store: RuntimeStore;
  private readonly modelInvoker?: ModelInvoker;
  private readonly autoApprove: RuntimeOptions['autoApprove'];
  private readonly qualityTier?: SpecialistQualityTier;
  private readonly maxToolRounds: number;
  private readonly defaultWorkspaceRoot: string;

  /** In-flight turn abort controllers, keyed by session id. */
  private readonly turnControllers = new Map<string, AbortController>();
  /** Pending approval waiters, keyed by tool call id. */
  private readonly approvalWaiters = new Map<
    string,
    { resolve: (approved: boolean, reason?: string) => void; timer: NodeJS.Timeout }
  >();
  /** Tool name for each pending approval (rows are inserted after the decision). */
  private readonly pendingApprovalTools = new Map<string, string>();
  /** Session-scoped tool grants ("always allow/deny"), keyed by session id. */
  private readonly sessionGrants = new Map<string, Map<string, PermissionDecision>>();

  constructor(options: RuntimeOptions = {}) {
    this.store = new RuntimeStore(options.dbPath ?? DEFAULT_DB_PATH);
    this.tools = new ToolRegistry();
    for (const tool of createBuiltinTools()) this.tools.register(tool);
    this.modelInvoker = options.modelInvoker;
    this.autoApprove = options.autoApprove;
    this.qualityTier = options.qualityTier;
    this.maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.defaultWorkspaceRoot = options.workspaceRoot ?? process.cwd();
  }

  /** Register a host tool (codebase search, MCP, deploy verbs, …). */
  registerTool(tool: ToolDefinition): void {
    this.tools.register(tool);
  }

  /** Close the underlying database. */
  close(): void {
    for (const [id, waiter] of this.approvalWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false, 'runtime shutting down');
      this.approvalWaiters.delete(id);
    }
    this.store.close();
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = input.sessionId ?? `ses_${randomUUID()}`;
    if (this.store.getSession(id)) {
      throw problem(
        409,
        CAPIX_ERROR_CODES.CONFLICT,
        'Session exists',
        `session already exists: ${id}`
      );
    }
    if (input.mode !== undefined && !isAgentMode(input.mode)) {
      throw problem(
        400,
        CAPIX_ERROR_CODES.INTERNAL_ERROR,
        'Invalid mode',
        `unknown mode: ${input.mode}`
      );
    }
    const now = nowIso();
    const row: SessionRow = {
      id,
      model_id: input.modelId || DEFAULT_MODEL,
      project_id: input.projectId ?? null,
      route_mode: input.routeMode || 'auto',
      mode: input.mode ?? 'build',
      status: 'active',
      workspace_root: input.workspaceRoot ?? null,
      instructions: input.instructions ?? null,
      parent_session_id: input.parentSessionId ?? null,
      specialist_role: input.specialistRole ?? null,
      created_at: now,
      updated_at: now,
      total_input_units: 0,
      total_output_units: 0,
      total_cost_minor: '0',
    };
    this.store.insertSession(row);
    this.recordEvent(
      this.makeEvent(id, randomUUID(), 'session.started', 'public', {
        type: 'session.started',
        modelId: row.model_id,
        projectId: row.project_id ?? undefined,
        routeMode: row.route_mode,
      } as unknown as AgentEvent)
    );
    return this.toSession(row);
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const row = this.requireSession(sessionId);
    this.store.updateSession(sessionId, { status: 'active', updated_at: nowIso() });
    return this.toSession({ ...row, status: 'active' });
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsOutput> {
    const limit = input.limit || 50;
    const offset = input.cursor ? Number(Buffer.from(input.cursor, 'base64').toString('utf8')) : 0;
    const rows = this.store.listSessions(limit + 1, Number.isFinite(offset) ? offset : 0);
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? Buffer.from(String((Number.isFinite(offset) ? offset : 0) + limit), 'utf8').toString(
            'base64'
          )
        : undefined;
    return { sessions: page.map((r) => this.toSession(r)), nextCursor };
  }

  async disposeSession(sessionId: string): Promise<void> {
    const row = this.store.getSession(sessionId);
    if (!row) return;
    this.store.updateSession(sessionId, { status: 'completed', updated_at: nowIso() });
    const controller = this.turnControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.turnControllers.delete(sessionId);
    }
  }

  // ── Modes ───────────────────────────────────────────────────────────────

  async setMode(sessionId: string, mode: AgentMode): Promise<void> {
    this.requireSession(sessionId);
    if (!isAgentMode(mode)) {
      throw problem(400, CAPIX_ERROR_CODES.INTERNAL_ERROR, 'Invalid mode', `unknown mode: ${mode}`);
    }
    this.store.updateSession(sessionId, { mode, updated_at: nowIso() });
  }

  async getMode(sessionId: string): Promise<AgentMode> {
    return this.requireSession(sessionId).mode as AgentMode;
  }

  // ── Turns ───────────────────────────────────────────────────────────────

  async *sendMessage(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    const row = this.requireSession(input.sessionId);
    const sessionId = input.sessionId;
    const turnId = randomUUID();
    const modelId = input.modelId || row.model_id;
    const mode = row.mode as AgentMode;
    const workspaceRoot = row.workspace_root ?? this.defaultWorkspaceRoot;
    const specialist = row.specialist_role ? getSpecialist(row.specialist_role) : null;

    const controller = new AbortController();
    this.turnControllers.set(sessionId, controller);

    const emit = (type: string, redaction: RedactionClass, data: object): AgentEvent => {
      const event = this.makeEvent(sessionId, turnId, type, redaction, data);
      this.recordEvent(event);
      return event;
    };

    this.store.insertMessage({
      session_id: sessionId,
      turn_id: turnId,
      role: 'user',
      content: input.content,
      created_at: nowIso(),
    });
    this.store.updateSession(sessionId, { status: 'active', updated_at: nowIso() });

    yield emit('turn.started', 'public', {
      type: 'turn.started',
      promptLength: input.content.length,
      modelId,
    } as unknown as AgentEvent);

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = BigInt(0);
    let finishReason: 'stop' | 'length' | 'tool_calls' | 'cancelled' = 'stop';
    let assistantText = '';

    try {
      if (!this.modelInvoker) {
        throw problem(
          502,
          CAPIX_ERROR_CODES.PROVIDER_ERROR,
          'Model unavailable',
          'no model invoker is configured for this runtime'
        );
      }

      const history = this.store
        .listMessages(sessionId)
        .map((m) => ({ role: m.role, content: m.content }));
      const conversation = specialist
        ? [{ role: 'system', content: specialist.systemPrompt }, ...history]
        : history;

      for (let round = 0; round <= this.maxToolRounds; round++) {
        let toolCall: { toolName: string; args: Record<string, unknown> } | null = null;

        for await (const chunk of this.modelInvoker({
          modelId,
          mode,
          specialist: specialist ?? undefined,
          // Specialist child sessions route at their own model's tier; plain
          // sessions use the runtime default (host falls back to balanced).
          qualityTier:
            (specialist ? qualityTierFromModelId(specialist.model) : undefined) ??
            this.qualityTier,
          messages: conversation,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          if (chunk.type === 'text') {
            assistantText += chunk.delta;
            yield emit('content.delta', 'public', {
              type: 'content.delta',
              content: chunk.delta,
              role: 'assistant',
            } as unknown as AgentEvent);
          } else if (chunk.type === 'reasoning') {
            yield emit('reasoning.delta', 'masked', {
              type: 'reasoning.delta',
              delta: chunk.delta,
            } as unknown as AgentEvent);
          } else if (chunk.type === 'tool_call') {
            toolCall = chunk;
          } else if (chunk.type === 'usage') {
            totalInput += chunk.inputUnits;
            totalOutput += chunk.outputUnits;
            totalCost += BigInt(chunk.costMinor);
            yield emit('usage.updated', 'public', {
              type: 'usage.updated',
              inputUnits: totalInput,
              outputUnits: totalOutput,
              costMinor: totalCost.toString(),
              asset: RECEIPT_ASSET,
              scale: RECEIPT_SCALE,
            } as unknown as AgentEvent);
          }
        }

        if (controller.signal.aborted) {
          finishReason = 'cancelled';
          break;
        }

        if (!toolCall) break; // model is done
        finishReason = 'tool_calls';

        const toolResult = yield* this.executeToolCall(
          emit,
          sessionId,
          turnId,
          mode,
          workspaceRoot,
          toolCall.toolName,
          toolCall.args,
          controller.signal
        );

        conversation.push({
          role: 'tool',
          content: `tool ${toolCall.toolName}: ${toolResult}`,
        });
      }

      if (assistantText) {
        this.store.insertMessage({
          session_id: sessionId,
          turn_id: turnId,
          role: 'assistant',
          content: assistantText,
          created_at: nowIso(),
        });
      }

      // Record the turn's inference receipt (integer minor units).
      if (totalInput > 0 || totalOutput > 0 || totalCost > BigInt(0)) {
        this.recordReceipt(sessionId, turnId, {
          kind: 'inference',
          modelCapability: modelId,
          costMinor: totalCost.toString(),
          summary: `turn ${turnId} inference (${totalInput} in / ${totalOutput} out)`,
          outcome: finishReason === 'cancelled' ? 'partial' : 'success',
        });
        this.store.updateSession(sessionId, {
          total_input_units: row.total_input_units + totalInput,
          total_output_units: row.total_output_units + totalOutput,
          total_cost_minor: (BigInt(row.total_cost_minor) + totalCost).toString(),
          updated_at: nowIso(),
        });
      }

      yield emit('turn.completed', 'public', {
        type: 'turn.completed',
        finishReason,
        totalInputUnits: totalInput,
        totalOutputUnits: totalOutput,
        totalCostMinor: totalCost.toString(),
      } as unknown as AgentEvent);
    } catch (err) {
      const p =
        err instanceof CapixAgentError
          ? err.problem
          : problem(500, CAPIX_ERROR_CODES.INTERNAL_ERROR, 'Turn failed', String(err)).problem;
      yield emit('turn.failed', 'public', {
        type: 'turn.failed',
        error: {
          capixCode: p.capixCode,
          message: p.detail,
          retryClass: p.retryClass ?? 'none',
          retryAfterMs: p.retryAfterMs,
          supportId: p.supportId,
        },
      } as unknown as AgentEvent);
    } finally {
      this.turnControllers.delete(sessionId);
      const current = this.store.getSession(sessionId);
      if (current && current.status === 'active') {
        this.store.updateSession(sessionId, { status: 'idle', updated_at: nowIso() });
      }
    }
  }

  /**
   * Run one tool call through the permission pipeline:
   * mode profile → session grants → operator approval → execute.
   * Persists the tool call row and any file diffs the tool caused.
   */
  private async *executeToolCall(
    emit: (type: string, redaction: RedactionClass, data: object) => AgentEvent,
    sessionId: string,
    turnId: string,
    mode: AgentMode,
    workspaceRoot: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, string> {
    const tool = this.tools.get(toolName);
    const toolCallId = `tc_${randomUUID()}`;
    const now = nowIso();

    if (!tool) {
      this.store.insertToolCall({
        tool_call_id: toolCallId,
        session_id: sessionId,
        turn_id: turnId,
        tool_name: toolName,
        args: JSON.stringify(args),
        permission: 'deny',
        status: 'rejected',
        decision_reason: 'unknown tool',
        output: null,
        is_error: 1,
        created_at: now,
        completed_at: now,
      });
      yield emit('tool.rejected', 'public', {
        type: 'tool.rejected',
        toolCallId,
        toolName,
        reason: `unknown tool: ${toolName}`,
      } as unknown as AgentEvent);
      return `unknown tool: ${toolName}`;
    }

    const grants = this.sessionGrants.get(sessionId);
    const check = checkModePermission(mode, toolName, tool.riskClass, grants);
    let decision = check.decision;
    let reason = check.reason;
    if (decision === 'allow' && tool.alwaysRequiresApproval && grants?.get(toolName) !== 'allow') {
      decision = 'ask';
      reason = `tool "${toolName}" always requires approval`;
    }

    const requiresApproval = decision === 'ask';

    // Register the approval waiter BEFORE emitting tool.requested so a client
    // that answers immediately (synchronously on the event) can never race
    // ahead of the waiter's registration.
    let approvalPromise: Promise<{ ok: boolean; reason?: string }> | null = null;
    if (decision === 'ask') {
      this.pendingApprovalTools.set(toolCallId, toolName);
      approvalPromise = this.waitForApproval(toolCallId, toolName, args, signal);
    }

    yield emit('tool.requested', 'public', {
      type: 'tool.requested',
      toolCallId,
      toolName,
      args,
      network: tool.riskClass === 'network',
      billable: tool.riskClass === 'billing',
      requiresApproval,
    } as unknown as AgentEvent);

    if (decision === 'deny') {
      this.store.insertToolCall({
        tool_call_id: toolCallId,
        session_id: sessionId,
        turn_id: turnId,
        tool_name: toolName,
        args: JSON.stringify(args),
        permission: 'deny',
        status: 'rejected',
        decision_reason: reason,
        output: null,
        is_error: 1,
        created_at: now,
        completed_at: nowIso(),
      });
      yield emit('tool.rejected', 'public', {
        type: 'tool.rejected',
        toolCallId,
        toolName,
        reason,
      } as unknown as AgentEvent);
      return `denied: ${reason}`;
    }

    if (decision === 'ask' && approvalPromise) {
      const approved = await approvalPromise;
      this.pendingApprovalTools.delete(toolCallId);
      if (!approved.ok) {
        this.store.insertToolCall({
          tool_call_id: toolCallId,
          session_id: sessionId,
          turn_id: turnId,
          tool_name: toolName,
          args: JSON.stringify(args),
          permission: 'ask',
          status: 'rejected',
          decision_reason: approved.reason ?? 'rejected by operator',
          output: null,
          is_error: 1,
          created_at: now,
          completed_at: nowIso(),
        });
        yield emit('tool.rejected', 'public', {
          type: 'tool.rejected',
          toolCallId,
          toolName,
          reason: approved.reason ?? 'rejected by operator',
        } as unknown as AgentEvent);
        return `rejected: ${approved.reason ?? 'rejected by operator'}`;
      }
    }

    this.store.insertToolCall({
      tool_call_id: toolCallId,
      session_id: sessionId,
      turn_id: turnId,
      tool_name: toolName,
      args: JSON.stringify(args),
      permission: decision,
      status: 'running',
      decision_reason: reason,
      output: null,
      is_error: 0,
      created_at: now,
      completed_at: null,
    });
    yield emit('tool.approved', 'public', {
      type: 'tool.approved',
      toolCallId,
      toolName,
    } as unknown as AgentEvent);
    yield emit('tool.started', 'public', {
      type: 'tool.started',
      toolName,
    } as unknown as AgentEvent);

    // Capture before-images of files the tool may change, for diff tracking.
    const targetPath = typeof args.path === 'string' ? args.path : undefined;
    let beforeContent: string | null = null;
    if ((tool.riskClass === 'write' || tool.riskClass === 'execute') && targetPath) {
      try {
        beforeContent = await readFile(resolveWorkspacePath(workspaceRoot, targetPath), 'utf8');
      } catch {
        beforeContent = null; // new file
      }
    }

    let output: string;
    let isError = false;
    try {
      const result = await tool.execute(args, {
        sessionId,
        turnId,
        workspaceRoot,
        signal,
      });
      output = result.output;
      isError = result.isError ?? false;

      if (tool.riskClass === 'write' && targetPath && !isError) {
        const afterContent = await readFile(
          resolveWorkspacePath(workspaceRoot, targetPath),
          'utf8'
        );
        const diff = createUnifiedDiff(targetPath, beforeContent ?? '', afterContent);
        if (diff) {
          this.store.insertDiff({
            session_id: sessionId,
            turn_id: turnId,
            file_path: targetPath,
            before: beforeContent ?? '',
            after: afterContent,
            diff,
            created_at: nowIso(),
          });
          yield emit('file.diff', 'public', {
            type: 'file.diff',
            filePath: targetPath,
            before: beforeContent ?? '',
            after: afterContent,
            diff,
          } as unknown as AgentEvent);
        }
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    this.store.updateToolCall(toolCallId, {
      status: isError ? 'failed' : 'completed',
      output,
      is_error: isError ? 1 : 0,
      completed_at: nowIso(),
    });
    yield emit('tool.output', isError ? 'masked' : 'public', {
      type: 'tool.output',
      toolName,
      output,
      isError,
      redaction: isError ? 'masked' : 'public',
    } as unknown as AgentEvent);
    return output;
  }

  /** Wait for the operator (or autoApprove policy) to decide a tool call. */
  private waitForApproval(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.autoApprove === true) return Promise.resolve({ ok: true });
    if (typeof this.autoApprove === 'function') {
      const verdict = this.autoApprove(toolName, args);
      if (verdict === true) return Promise.resolve({ ok: true });
      // A policy object decides immediately in both directions; a denial is a
      // typed skip (recorded with its reason), never a silent approval and
      // never a wait for a human.
      if (typeof verdict === 'object' && verdict !== null) {
        return Promise.resolve({
          ok: verdict.approved,
          reason: verdict.approved ? undefined : (verdict.reason ?? 'denied by policy'),
        });
      }
    }
    if (signal.aborted) return Promise.resolve({ ok: false, reason: 'turn cancelled' });

    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(toolCallId);
        resolvePromise({ ok: false, reason: 'approval timed out' });
      }, APPROVAL_TIMEOUT_MS);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.approvalWaiters.delete(toolCallId);
        resolvePromise({ ok: false, reason: 'turn cancelled' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvalWaiters.set(toolCallId, {
        resolve: (approved, reason) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolvePromise({ ok: approved, reason });
        },
        timer,
      });
    });
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const controller = this.turnControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.turnControllers.delete(sessionId);
    }
    const row = this.store.getSession(sessionId);
    if (row) this.store.updateSession(sessionId, { status: 'idle', updated_at: nowIso() });
  }

  async approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    this.requireSession(sessionId);
    const waiter = this.approvalWaiters.get(toolCallId);
    if (!waiter) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Approval not found',
        `no pending tool approval: ${toolCallId}`
      );
    }
    this.approvalWaiters.delete(toolCallId);
    clearTimeout(waiter.timer);
    // "always" grants persist for the rest of the session.
    if (reason === 'always') {
      const toolName = this.pendingApprovalTools.get(toolCallId);
      if (toolName) {
        const grants = this.sessionGrants.get(sessionId) ?? new Map<string, PermissionDecision>();
        grants.set(toolName, approved ? 'allow' : 'deny');
        this.sessionGrants.set(sessionId, grants);
      }
    }
    waiter.resolve(approved, approved ? undefined : (reason ?? 'rejected by operator'));
  }

  // ── Models ──────────────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    // Customer-facing output never names upstream providers: the only target
    // is capix/auto, resolved server-authoritatively per request.
    return [
      {
        id: DEFAULT_MODEL,
        name: 'Capix Auto (smart route)',
        provider: 'capix',
        contextWindow: 128000,
        maxOutput: 64000,
        isAuto: true,
      },
    ];
  }

  async selectModel(sessionId: string, modelId: string): Promise<void> {
    this.requireSession(sessionId);
    if (modelId !== DEFAULT_MODEL) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.MODEL_NOT_FOUND,
        'Model not found',
        `unknown model target: ${modelId}`
      );
    }
    this.store.updateSession(sessionId, { model_id: modelId, updated_at: nowIso() });
  }

  // ── Usage, receipts, settlement ─────────────────────────────────────────

  async getUsage(sessionId: string): Promise<UsageSummary> {
    const row = this.requireSession(sessionId);
    return {
      totalInputUnits: row.total_input_units,
      totalOutputUnits: row.total_output_units,
      totalCostMinor: row.total_cost_minor,
      asset: RECEIPT_ASSET,
      scale: RECEIPT_SCALE,
      receiptIds: this.store.listReceipts(sessionId).map((r) => r.receipt_id),
    };
  }

  async getReceipts(sessionId: string): Promise<ReceiptInfo[]> {
    this.requireSession(sessionId);
    return this.store.listReceipts(sessionId).map((r) => ({
      id: r.receipt_id,
      modelCapability: r.model_capability,
      region: 'global',
      privacyClass: 'public',
      costMinor: r.cost_minor,
      asset: r.asset,
      scale: r.scale,
      timestamp: r.created_at,
    }));
  }

  async getSettlementStatus(sessionId: string): Promise<SettlementStatus> {
    this.requireSession(sessionId);
    return {
      epoch: '0',
      root: sessionReceiptRoot(this.store.listReceipts(sessionId)),
      cluster: 'mainnet-beta',
      // Local root only — on-chain anchoring is not enabled in this build.
      paused: true,
    };
  }

  async verifyReceipt(receiptId: string): Promise<ReceiptVerification> {
    const row = this.store.getReceipt(receiptId);
    if (!row) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Receipt not found',
        `unknown receipt: ${receiptId}`
      );
    }
    // Recompute the leaf hash locally and compare against the stored value;
    // then re-anchor against the session's Merkle root. No API trust.
    const recomputed = receiptLeafHash(receiptRowToLeafInput(row));
    const verified = recomputed === row.leaf_hash;
    return {
      verified,
      root: sessionReceiptRoot(this.store.listReceipts(row.session_id)),
    };
  }

  async getEpoch(sessionId: string, epoch: bigint): Promise<SettlementEpoch> {
    this.requireSession(sessionId);
    const receipts = this.store.listReceipts(sessionId);
    return {
      epoch: epoch.toString(),
      root: sessionReceiptRoot(receipts),
      cluster: 'mainnet-beta',
      startedAt: receipts[0]?.created_at ?? nowIso(),
      finalizedAt: undefined,
      leafCount: receipts.length.toString(),
      paused: true,
    };
  }

  private recordReceipt(
    sessionId: string,
    turnId: string,
    input: {
      kind: string;
      modelCapability: string;
      costMinor: string;
      summary: string;
      outcome: string;
    }
  ): string {
    const receiptId = `rcpt_${randomUUID()}`;
    const createdAt = nowIso();
    const leaf = {
      receiptId,
      sessionId,
      turnId,
      kind: input.kind,
      modelCapability: input.modelCapability,
      costMinor: input.costMinor,
      asset: RECEIPT_ASSET,
      scale: RECEIPT_SCALE,
      summary: input.summary,
      outcome: input.outcome,
      createdAt,
    };
    this.store.insertReceipt({
      receipt_id: receiptId,
      session_id: sessionId,
      turn_id: turnId,
      kind: input.kind,
      model_capability: input.modelCapability,
      cost_minor: input.costMinor,
      asset: RECEIPT_ASSET,
      scale: RECEIPT_SCALE,
      summary: input.summary,
      outcome: input.outcome,
      leaf_hash: receiptLeafHash(leaf),
      created_at: createdAt,
    });
    return receiptId;
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  async createPlan(sessionId: string, input: CreatePlanInput): Promise<RuntimePlan> {
    this.requireSession(sessionId);
    const now = nowIso();
    const planId = `plan_${randomUUID()}`;
    const steps = (input.steps ?? []).map((s, idx) => ({
      plan_id: planId,
      step_id: `step-${idx + 1}`,
      idx,
      description: s.description,
      status: 'pending',
      files: JSON.stringify(s.files ?? []),
      tests: JSON.stringify(s.tests ?? []),
    }));
    this.store.insertPlan(
      {
        plan_id: planId,
        session_id: sessionId,
        goal: input.goal,
        status: 'draft',
        definition_of_done: JSON.stringify(input.definitionOfDone ?? []),
        created_at: now,
        updated_at: now,
      },
      steps
    );
    return this.getPlan(planId);
  }

  async getPlan(planId: string): Promise<RuntimePlan> {
    const row = this.store.getPlan(planId);
    if (!row) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Plan not found',
        `unknown plan: ${planId}`
      );
    }
    const steps: RuntimePlanStep[] = this.store.getPlanSteps(planId).map((s) => ({
      stepId: s.step_id,
      idx: s.idx,
      description: s.description,
      status: s.status as PlanStepStatus,
      files: JSON.parse(s.files) as string[],
      tests: JSON.parse(s.tests) as string[],
    }));
    return {
      planId: row.plan_id,
      sessionId: row.session_id,
      goal: row.goal,
      status: row.status as RuntimePlan['status'],
      definitionOfDone: JSON.parse(row.definition_of_done) as string[],
      steps,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listPlans(sessionId: string): Promise<RuntimePlan[]> {
    this.requireSession(sessionId);
    const rows = this.store.listPlans(sessionId);
    const plans: RuntimePlan[] = [];
    for (const row of rows) plans.push(await this.getPlan(row.plan_id));
    return plans;
  }

  async updatePlanStep(
    planId: string,
    stepId: string,
    status: PlanStepStatus
  ): Promise<RuntimePlan> {
    const plan = await this.getPlan(planId);
    if (!plan.steps.some((s) => s.stepId === stepId)) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Plan step not found',
        `unknown step ${stepId} on plan ${planId}`
      );
    }
    this.store.updatePlanStep(planId, stepId, { status });
    this.store.updatePlan(planId, { updated_at: nowIso() });
    return this.getPlan(planId);
  }

  // ── Workspace, diffs, patches ───────────────────────────────────────────

  async attachWorkspace(sessionId: string, workspaceRoot: string): Promise<void> {
    this.requireSession(sessionId);
    if (!existsSync(workspaceRoot)) {
      throw problem(
        400,
        CAPIX_ERROR_CODES.INTERNAL_ERROR,
        'Workspace not found',
        `workspace root does not exist: ${workspaceRoot}`
      );
    }
    this.store.updateSession(sessionId, { workspace_root: workspaceRoot, updated_at: nowIso() });
  }

  async getDiff(
    sessionId: string,
    filePath?: string
  ): Promise<{ filePath: string; diff: string }[]> {
    this.requireSession(sessionId);
    const rows = this.store.listDiffs(sessionId, filePath);
    // Collapse to the latest diff per file for a current-state view.
    const latest = new Map<string, string>();
    for (const row of rows) latest.set(row.file_path, row.diff);
    return [...latest.entries()].map(([path, diff]) => ({ filePath: path, diff }));
  }

  async applyPatch(sessionId: string, filePath: string, patch: string): Promise<void> {
    const row = this.requireSession(sessionId);
    const mode = row.mode as AgentMode;
    const profile = getModeProfile(mode);
    if (!profile.canEditFiles) {
      throw problem(
        403,
        CAPIX_ERROR_CODES.FORBIDDEN,
        'Mode forbids edits',
        `${mode} mode does not allow applying patches`
      );
    }
    const workspaceRoot = row.workspace_root ?? this.defaultWorkspaceRoot;
    const abs = resolveWorkspacePath(workspaceRoot, filePath);
    let before = '';
    try {
      before = await readFile(abs, 'utf8');
    } catch {
      before = '';
    }
    let after: string;
    try {
      after = applyUnifiedDiff(before, patch);
    } catch (err) {
      throw problem(
        409,
        CAPIX_ERROR_CODES.CONFLICT,
        'Patch does not apply',
        err instanceof Error ? err.message : String(err)
      );
    }
    await writeFile(abs, after, 'utf8');
    this.store.insertDiff({
      session_id: sessionId,
      turn_id: randomUUID(),
      file_path: filePath,
      before,
      after,
      diff: createUnifiedDiff(filePath, before, after),
      created_at: nowIso(),
    });
  }

  // ── Child sessions / specialists ────────────────────────────────────────

  listSpecialists(): SpecialistAgent[] {
    return listSpecialists();
  }

  getSpecialist(role: string): SpecialistAgent | null {
    return getSpecialist(role);
  }

  async createChildSession(
    parentSessionId: string,
    role: string,
    mandate: string
  ): Promise<Session> {
    const parent = this.requireSession(parentSessionId);
    const specialist = getSpecialist(role);
    if (!specialist) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.MODEL_NOT_FOUND,
        'Unknown specialist',
        `unknown specialist role: ${role}`
      );
    }
    return this.createSession({
      modelId: specialist.model,  // Use the specialist's assigned model, not the parent's
      projectId: parent.project_id ?? undefined,
      workspaceRoot: parent.workspace_root ?? undefined,
      routeMode: parent.route_mode as Session['routeMode'],
      mode: specialist.mode,
      parentSessionId,
      specialistRole: specialist.role,
      instructions: mandate,
    });
  }

  async listChildSessions(parentSessionId: string): Promise<Session[]> {
    this.requireSession(parentSessionId);
    return this.store.listChildSessions(parentSessionId).map((r) => this.toSession(r));
  }

  async cancelChildSession(sessionId: string): Promise<void> {
    const row = this.store.getSession(sessionId);
    if (!row) return;
    await this.cancelTurn(sessionId);
    this.store.updateSession(sessionId, { status: 'failed', updated_at: nowIso() });
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async runCommand(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<{ exitCode: number; output: string }> {
    const row = this.requireSession(sessionId);
    const mode = row.mode as AgentMode;
    const check = checkModePermission(mode, 'bash', 'execute', this.sessionGrants.get(sessionId));
    if (check.decision === 'deny') {
      throw problem(403, CAPIX_ERROR_CODES.FORBIDDEN, 'Mode forbids commands', check.reason);
    }
    const bash = this.tools.get('bash');
    if (!bash)
      throw problem(
        500,
        CAPIX_ERROR_CODES.INTERNAL_ERROR,
        'Tool missing',
        'bash tool not registered'
      );
    const workspaceRoot = row.workspace_root ?? this.defaultWorkspaceRoot;
    const result = await bash.execute(
      { command },
      { sessionId, turnId: randomUUID(), workspaceRoot: cwd ?? workspaceRoot }
    );
    this.recordEvent(
      this.makeEvent(sessionId, randomUUID(), 'command.output', 'public', {
        type: 'command.output',
        command,
        output: result.output,
        exitCode: result.isError ? 1 : 0,
        redaction: 'public',
      } as unknown as AgentEvent)
    );
    return { exitCode: result.isError ? 1 : 0, output: result.output };
  }

  // ── History / events (for ACP resume + UIs) ─────────────────────────────

  getHistory(sessionId: string): Array<{ role: string; content: string; timestamp: string }> {
    this.requireSession(sessionId);
    return this.store.listMessages(sessionId).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.created_at,
    }));
  }

  getEvents(sessionId: string): AgentEvent[] {
    this.requireSession(sessionId);
    return this.store.listEvents(sessionId).map((e) => JSON.parse(e.payload) as AgentEvent);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private requireSession(sessionId: string): SessionRow {
    const row = this.store.getSession(sessionId);
    if (!row) {
      throw problem(
        404,
        CAPIX_ERROR_CODES.SESSION_NOT_FOUND,
        'Session not found',
        `unknown session: ${sessionId}`
      );
    }
    return row;
  }

  private toSession(row: SessionRow): Session {
    return {
      id: row.id,
      modelId: row.model_id,
      projectId: row.project_id ?? undefined,
      routeMode: row.route_mode as Session['routeMode'],
      mode: row.mode as AgentMode,
      workspaceRoot: row.workspace_root ?? undefined,
      parentSessionId: row.parent_session_id ?? undefined,
      specialistRole: row.specialist_role ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      totalInputUnits: row.total_input_units,
      totalOutputUnits: row.total_output_units,
      totalCostMinor: row.total_cost_minor,
      status: row.status as Session['status'],
    };
  }

  private makeEvent(
    sessionId: string,
    turnId: string,
    type: string,
    redaction: RedactionClass,
    data: object
  ): AgentEvent {
    const base = {
      version: AGENT_EVENT_VERSION,
      eventId: randomUUID(),
      sessionId,
      turnId,
      timestamp: nowIso(),
      correlationId: randomUUID(),
      redaction,
    };
    return { ...base, ...data, type } as unknown as AgentEvent;
  }

  private recordEvent(event: AgentEvent): void {
    try {
      this.store.insertEvent({
        event_id: event.eventId,
        session_id: event.sessionId,
        turn_id: event.turnId,
        type: event.type,
        redaction: event.redaction,
        payload: JSON.stringify(event),
        created_at: event.timestamp,
      });
    } catch {
      // Event persistence is best-effort; never break a turn on it.
    }
  }
}
