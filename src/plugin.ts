/**
 * Capix Code plugin — real entry point.
 *
 * This replaces the former `capixSmartRoute` object which used an invented
 * `onMessage` interface against a fake `@capix/plugin` ambient declaration.
 * The real OpenCode plugin contract (`@opencode-ai/plugin`) is a function
 * `(input, options?) => Promise<Hooks>`. This file exports exactly that.
 *
 * Refs:
 * - architecture §12.4 (provider/routing contract), §12.5 (local tool security)
 * - master prompt C2 (real plugin/provider), C3 (credential broker), C5 (sandbox)
 *
 * What this plugin does (and deliberately does NOT):
 * - registers the `capix` provider and `capix/auto` target via the real
 *   `provider` hook (ProviderHook), with model discovery from the broker;
 * - registers an `auth` hook that bridges browser code+PKCE to CredentialBroker;
 * - hardens tool execution: `tool.execute.before` closes broker capabilities and
 *   roots commands through the WorkspaceSandbox; `shell.env` scrubs secrets;
 * - `permission.ask` enforces the selected sandbox profile;
 * - never classifies prompts, scores providers, rewrites base URLs, or retains
 *   a separate router memory. Routing is server-authoritative.
 */

import {
  tool,
  type Plugin,
  type PluginInput,
  type Hooks,
  type AuthHook,
} from '@opencode-ai/plugin';
import { z } from 'zod';
import type { Permission } from '@opencode-ai/sdk';
import { join, sep, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import {
  capixProvider,
  createCapixProviderHook,
  capixAuthLoader,
  CAPIX_INFERENCE_BASE,
  stream as capixStream,
  readQualityTier,
  type CapixClientMeta,
} from './capix-provider.js';
import { CredentialBroker } from './broker.js';
import { WorkspaceSandbox, type SandboxProfile } from './sandbox.js';
import { logger } from './logger.js';
import * as intelligence from './intelligence-client.js';
import type { ProjectContextCodebaseSummary } from './intelligence-client.js';
import { CodebaseIndexer, ContextRetriever } from './codebase-index/index.js';
import {
  Planner,
  SubagentManager,
  ContextCompactor,
  Architect,
  Deployer,
  Trainer,
  Sandpit,
  PrivateModelManager,
  MvpPlanner,
  MvpDeployer,
  FullSolutionPlanner,
  type ModelInvoker,
  type SubagentConfig,
  type SubagentResult,
  type EngineCommandResolver,
  type PlanStep,
  type Plan,
  type ArchitecturePlan,
  type DeployProgressEvent,
  type TrainProgressEvent,
} from './planner/index.js';
import { createSandpitTools } from './tools/sandpit-tools.js';
import { createModelTools } from './tools/model-tools.js';
import type { ToolDefinition } from '@capix/agent-runtime';

/** Convert an agent-runtime ToolDefinition to the OpenCode plugin tool format. */
function adaptRuntimeTool(def: ToolDefinition) {
  return tool({
    description: def.description,
    args: {
      // Runtime tools accept arbitrary args; the plugin validates loosely.
      input: z.string().optional().describe('Tool input as JSON string'),
    },
    async execute(args, context) {
      const parsed = args.input ? JSON.parse(args.input) : {};
      const result = await def.execute(parsed, {
        sessionId: context.sessionID ?? 'unknown',
        turnId: `turn_${Date.now()}`,
        workspaceRoot: context.directory ?? process.cwd(),
        signal: context.abort,
      });
      return {
        title: def.name,
        output: result.output,
        metadata: result.metadata,
      };
    },
  });
}

/** Convert an array of agent-runtime ToolDefinitions to OpenCode plugin tools. */
function adaptRuntimeTools(defs: ToolDefinition[]): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {};
  for (const def of defs) {
    result[def.name] = adaptRuntimeTool(def);
  }
  return result;
}
import * as routing from './routing-client.js';
import { sessionStatus } from './tui/index.js';
import { intelligenceContext } from './tui/intelligence-context.js';
import { McpSupervisor } from './mcp-supervisor.js';
import { InlineCompletionSession } from './completion/inline-completion.js';
import { SkillsRuntime, BUILTIN_SKILLS } from './skills/index.js';
import {
  CapixAgentRuntime,
  checkModePermission,
  createAutoApprovalPolicy,
  isAgentMode,
  qualityTierFromModelId,
  canonicalGatewayModelId,
  type AgentMode,
  type ModelChunk as RuntimeModelChunk,
  type ModelInvoker as RuntimeModelInvoker,
  type ToolRiskClass,
} from '@capix/agent-runtime';

/** True when the launcher started this process via `capix-code run --auto`. */
export function isAutonomousMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAPIX_AUTONOMOUS === '1';
}

export const CAPIX_PLUGIN_VERSION = '2.4.19';
export const CAPIX_ACP_VERSION = '1';

/** Settings the launcher may pass via plugin options. */
export interface CapixPluginOptions {
  releaseId?: string;
  clientVersion?: string;
  sandbox?: SandboxProfile;
  workspaceRoot?: string;
  apiBaseUrl?: string;
  inferenceBaseUrl?: string;
  /** Agent mode (ask/plan/build/debug/review) enforced on tool execution. */
  mode?: AgentMode;
}

type ToolBefore = NonNullable<Hooks['tool.execute.before']>;
type ToolExecuteInput = Parameters<ToolBefore>[0];
type ToolExecuteOutput = Parameters<ToolBefore>[1];
type ShellEnv = NonNullable<Hooks['shell.env']>;
type ShellEnvOutput = Parameters<ShellEnv>[1];
type PermissionAsk = NonNullable<Hooks['permission.ask']>;
type PermissionResult = Parameters<PermissionAsk>[1];
type ChatParams = NonNullable<Hooks['chat.params']>;
type ChatParamsInput = Parameters<ChatParams>[0];
type ChatParamsOutput = Parameters<ChatParams>[1];
type ChatMessage = NonNullable<Hooks['chat.message']>;
type ChatMessageInput = Parameters<ChatMessage>[0];
type ChatMessageOutput = Parameters<ChatMessage>[1];
type SystemTransform = NonNullable<Hooks['experimental.chat.system.transform']>;
type SystemTransformInput = Parameters<SystemTransform>[0];
type SystemTransformOutput = Parameters<SystemTransform>[1];

let brokerInstance: CredentialBroker | null = null;
let sandboxInstance: WorkspaceSandbox | null = null;
let runtimeInstance: CapixAgentRuntime | null = null;
let mcpSupervisorInstance: McpSupervisor | null = null;
let intelligenceWired = false;

const EVIDENCE_FIRST_SYSTEM_PROMPT = `Capix Code operating policy:
- For questions about the current repository, architecture, implementation, bugs, upgrades, or plans, inspect the relevant workspace files with tools before making recommendations.
- A directory listing alone is not codebase analysis. Read the relevant manifests, entry points, implementation files, tests, and documentation, then cite concrete workspace paths in the answer.
- Repository work is a multi-step loop: discover relevant files, read them, trace dependencies and tests, verify claims with further searches or commands, then answer. Do not stop after the discovery/listing step while relevant files remain unread.
- Before finalizing a repository plan or review, gather evidence from at least the project manifest, one relevant entry point, the relevant implementation area, and its tests when those files exist.
- Clearly distinguish observed facts from inferences and proposed work. Never claim a feature is missing until you have searched for it.
- Prefer repository-specific findings over generic advice. If inspection is blocked, say exactly what was inspected and what remains unknown.
- The selected target may be the logical alias capix/auto. If asked which exact model served the request, use the exact routed-model identity supplied by Capix routing metadata; never present capix/auto as the physical model.`;

/** Pure formatter kept exported so the engine bridge has a regression seam. */
export function formatCapixSystemContext(input: {
  intelligence?: unknown;
  codebase?: unknown;
  skill?: { id: string; systemPrompt: string; reason: string } | null;
  compaction?: unknown;
}): string {
  const blocks = [EVIDENCE_FIRST_SYSTEM_PROMPT];
  const encode = (value: unknown, max = 12_000) => {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n[context truncated]` : text;
  };
  if (input.intelligence) blocks.push(`Capix Intelligence Context:\n${encode(input.intelligence)}`);
  if (input.codebase) blocks.push(`Capix Codebase Context:\n${encode(input.codebase)}`);
  if (input.skill) {
    blocks.push(
      `Active Capix Skill (${input.skill.id}; ${input.skill.reason}):\n${input.skill.systemPrompt}`
    );
  }
  if (input.compaction) blocks.push(`Capix Session Compaction:\n${encode(input.compaction)}`);
  return blocks.join('\n\n');
}

function getBroker(): CredentialBroker {
  if (!brokerInstance) {
    brokerInstance = new CredentialBroker();
  }
  return brokerInstance;
}

/**
 * The shared MCP supervisor. One per process: repeated plugin loads must not
 * spawn duplicate MCP servers. Its health feed is mirrored into the session
 * status store, which is what the TUI status line renders
 * ("mcp connected (N tools)" vs "mcp disconnected").
 */
function getMcpSupervisor(): McpSupervisor {
  if (!mcpSupervisorInstance) {
    mcpSupervisorInstance = new McpSupervisor();
    mcpSupervisorInstance.onHealthChange((health) => sessionStatus.setMcpHealth(health));
  }
  return mcpSupervisorInstance;
}

/** Resolve the Capix MCP server entry point (same resolution as the config hook). */
function mcpServerEntry(): string {
  return (
    process.env.CAPIX_MCP_PATH ||
    join(process.env.HOME || '/home/user', '.capix-code', 'mcp', 'capix-mcp.js')
  );
}

/**
 * Start supervising the Capix MCP server so the customer-facing status line
 * reflects real health. Never blocks plugin load: a missing entry point (dev
 * checkouts, pre-install) leaves the status at its disconnected default, and
 * spawn failures degrade inside the supervisor itself.
 */
function startMcpSupervision(): void {
  const entry = mcpServerEntry();
  if (!existsSync(entry)) return;
  const supervisor = getMcpSupervisor();
  if (supervisor.getHealth().state !== 'disconnected') return;
  const env: Record<string, string> = {};
  const apiKey = process.env.CAPIX_API_KEY?.trim();
  if (apiKey) env.CAPIX_API_KEY = apiKey;
  try {
    supervisor.start(entry, env);
  } catch (err) {
    logger.warn('capix plugin: MCP supervisor start failed', { error: (err as Error)?.message });
  }
}

/**
 * Rehydrate MCP immediately after an interactive or API-key login succeeds.
 *
 * Plugin startup is allowed to happen while signed out. In that state the
 * supervisor starts without a credential so the UI can report honest health,
 * but a successful login must replace that child process with one carrying the
 * broker's newly-issued short-lived access token. Waiting for an application
 * restart here left first-run customers permanently disconnected.
 */
async function reconnectMcpAfterAuth(broker: CredentialBroker): Promise<void> {
  const entry = mcpServerEntry();
  if (!existsSync(entry)) return;
  try {
    const access = await broker.getAccessToken();
    if (!access?.token) return;
    getMcpSupervisor().reconnect(entry, { CAPIX_API_KEY: access.token });
  } catch (err) {
    logger.warn('capix plugin: MCP reconnect after authentication failed', {
      error: (err as Error)?.message,
    });
  }
}

function getSandbox(opts: CapixPluginOptions): WorkspaceSandbox {
  if (!sandboxInstance) {
    const profile = opts.sandbox ?? 'restricted';
    const root = opts.workspaceRoot ?? process.cwd();
    sandboxInstance = new WorkspaceSandbox(profile, root);
  }
  return sandboxInstance;
}

/**
 * The shared agent runtime (`@capix/agent-runtime`). The plugin delegates
 * specialist definitions, mode permission checks, plan persistence, and
 * session bookkeeping to it instead of keeping its own in-memory stub.
 * Constructed lazily so plugin load never touches the filesystem; tests can
 * point `CAPIX_AGENT_RUNTIME_DB` at `:memory:`.
 */
function getAgentRuntime(meta: CapixClientMeta, workspaceRoot: string): CapixAgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new CapixAgentRuntime({
      dbPath: process.env.CAPIX_AGENT_RUNTIME_DB,
      workspaceRoot,
      modelInvoker: createRuntimeModelInvoker(meta),
      // Autonomous runs decide every approval by policy — no waiter, ever.
      autoApprove: isAutonomousMode() ? createAutoApprovalPolicy() : undefined,
      qualityTier: isAutonomousMode() ? readQualityTier() : undefined,
    });
  }
  return runtimeInstance;
}

/** The plugin's active agent mode: option, then env, then 'build'. */
function getAgentMode(opts: CapixPluginOptions): AgentMode {
  const raw = opts.mode ?? process.env.CAPIX_AGENT_MODE ?? 'build';
  return isAgentMode(raw) ? raw : 'build';
}

/**
 * Map an engine tool name to a runtime risk class so `checkModePermission`
 * can enforce the active mode in `tool.execute.before`.
 */
function engineToolRiskClass(toolName: string): ToolRiskClass {
  switch (toolName) {
    case 'bash':
    case 'task':
      return 'execute';
    case 'edit':
    case 'write':
    case 'patch':
      return 'write';
    case 'webfetch':
    case 'websearch':
      return 'network';
    default:
      return 'read';
  }
}

/**
 * Bridge the broker-backed capix stream into the runtime's ModelInvoker
 * shape, so runtime-driven turns (e.g. specialist child sessions over ACP)
 * use the same server-authoritative route as the engine. Exported for the
 * autonomous driver (`auto-run.ts`), which runs the same wiring.
 */
export function createRuntimeModelInvoker(meta: CapixClientMeta): RuntimeModelInvoker {
  return async function* (req) {
    // Retry the whole request ONLY when the stream died before any content
    // was emitted (a mid-stream error after text flowed is not retryable —
    // retrying would duplicate content). Transient classes: 429/5xx/timeouts
    // and the gateway's retry-classified route failures.
    const maxAttempts = 4;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let emittedContent = false;
      let pendingError: { message?: string; capixCode?: string; retryClass?: 'none' | 'retry' | 'retry-after'; retryAfterMs?: number } | null = null;
      // A stalled upstream must never hang a run: each attempt gets a hard
      // 90s timeout, merged with the caller's cancellation signal. Timeout
      // aborts surface as transient and retry like any other lane stall.
      const attemptController = new AbortController();
      const attemptTimeout = setTimeout(() => attemptController.abort(new Error('attempt timed out after 90s')), 90_000);
      const onCallerAbort = () => attemptController.abort(req.signal?.reason ?? new Error('cancelled'));
      if (req.signal) {
        if (req.signal.aborted) onCallerAbort();
        else req.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
      try {
        const stream = capixStream(
          {
            // Tier-suffixed logical ids (capix/auto-best etc.) collapse to the
            // canonical gateway target; the tier travels on the header instead.
            model: canonicalGatewayModelId(req.modelId),
            messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          },
          {
            meta,
            signal: attemptController.signal,
            // Specialist sessions carry their role's tier; the provider falls
            // back to CAPIX_QUALITY_TIER / balanced otherwise.
            qualityTier: req.qualityTier ?? qualityTierFromModelId(req.modelId),
            // Router has no task-class field today; the role is sent as
            // X-Capix-Agent-Class request metadata.
            agentClass: req.specialist?.role,
          }
        );
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            emittedContent = true;
            yield { type: 'text', delta: chunk.delta } as RuntimeModelChunk;
          } else if (chunk.type === 'reasoning') {
            emittedContent = true;
            yield { type: 'reasoning', delta: chunk.delta } as RuntimeModelChunk;
          } else if (chunk.type === 'usage') {
            // Mirror real token/cost usage into the session status store so the
            // TUI shows actual usage after inference instead of zeros.
            sessionStatus.recordUsage(chunk.input, chunk.output, chunk.cost);
            yield {
              type: 'usage',
              inputUnits: chunk.input,
              outputUnits: chunk.output,
              costMinor: chunk.cost?.amount ?? '0',
            } as RuntimeModelChunk;
          } else if (chunk.type === 'error') {
            pendingError = chunk;
            break;
          }
        }
      } catch (err) {
        const e = err as { message?: string; capixCode?: string; retryClass?: 'none' | 'retry' | 'retry-after'; retryAfterMs?: number };
        // Preserve the gateway's retry classification — it is the server's
        // authoritative signal (e.g. 503 ledger_unavailable retry-after).
        pendingError = { message: e.message, capixCode: e.capixCode, retryClass: e.retryClass, retryAfterMs: e.retryAfterMs };
      } finally {
        clearTimeout(attemptTimeout);
        req.signal?.removeEventListener('abort', onCallerAbort);
      }
      if (!pendingError) return; // stream completed cleanly
      const transient = isTransientRouteError(pendingError);
      if (emittedContent || !transient || attempt >= maxAttempts || req.signal?.aborted) {
        throw new Error(pendingError.message || `capix inference error: ${pendingError.capixCode ?? 'unknown'}`);
      }
      const backoff = Math.min(8000, (pendingError.retryAfterMs ?? 0) || 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  };
}

/** 429/5xx/timeout and gateway retry-classified route failures are retryable. */
function isTransientRouteError(err: { message?: string; capixCode?: string; retryClass?: 'none' | 'retry' | 'retry-after' }): boolean {
  // The gateway's RFC 9457 retry classification is authoritative when present.
  if (err.retryClass === 'retry' || err.retryClass === 'retry-after') return true;
  if (err.retryClass === 'none') return false;
  const code = err.capixCode ?? '';
  if (code === 'provider_rate_limited' || code === 'inference_route_failed' || code === 'ledger_unavailable') return true;
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('route temporarily unavailable') ||
    msg.includes(' 429') || msg.includes('status 429') ||
    msg.includes(' 500') || msg.includes(' 502') || msg.includes(' 503') || msg.includes(' 504') ||
    msg.includes('timeout') || msg.includes('timed out')
  );
}

/**
 * Wire the intelligence-client so `chat.params` context injection and the
 * `/deploy` + `/cleanup` covenant gate can talk to the intelligence API via
 * the same broker. Idempotent — safe to call on every plugin load.
 */
function wireIntelligence(
  broker: CredentialBroker,
  opts: CapixPluginOptions,
  meta: { releaseId: string; clientVersion: string; pluginVersion: string }
): void {
  if (intelligenceWired) return;
  intelligenceWired = true;
  intelligence.setBrokerAccessor(() => broker);
  const base = opts.apiBaseUrl ?? intelligence.CAPIX_INTELLIGENCE_BASE;
  intelligence.setIntelligenceBaseResolver(() => base);
  intelligence.setClientMetaAccessor(() => ({
    client: 'capix-code',
    clientVersion: meta.clientVersion,
    pluginVersion: meta.pluginVersion,
    releaseId: meta.releaseId,
  }));
}

/**
 * Fetch the intelligence context that gets injected into the chat system
 * prompt on every turn. This is the single intelligence integration point
 * with the chat engine — see `chat.params` below.
 *
 * Returns a structured payload that the runtime's system-prompt builder is
 * expected to read from `chat.params` output `options.capixIntelligenceContext`
 * and append verbatim (with section headers) to the system prompt sent to the
 * model.
 *
 * Failures are NON-BLOCKING: a transient 5xx on `/v1/plans` must not break
 * the chat turn. Each fetch is best-effort with a short timeout; if any
 * sub-call fails, that section is omitted from the injected context and a
 * `warnings` entry records the failure.
 */
async function fetchIntelligenceContext(projectId?: string): Promise<{
  plan?: { id: string; goal: string; definitionOfDone: string[] };
  decisions?: Array<{ id: string; content: string; confidence: number }>;
  covenantRules?: Array<{ id: string; invariant: string; effect: string }>;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const signal = AbortSignal.timeout?.(4_000) ?? undefined;

  const [plansRes, memRes, covRes] = await Promise.allSettled([
    intelligence.listPlans({ status: 'active', limit: 1 }, { projectId, signal }),
    intelligence.retrieveMemory(
      { type: 'decision', status: 'active', limit: 5 },
      { projectId, signal }
    ),
    intelligence.getActiveCovenant({ projectId, signal }),
  ]);

  let plan: { id: string; goal: string; definitionOfDone: string[] } | undefined;
  if (plansRes.status === 'fulfilled' && plansRes.value.plans.length > 0) {
    const p = plansRes.value.plans[0]!;
    plan = { id: p.id, goal: p.goal, definitionOfDone: p.definitionOfDone };
  } else if (plansRes.status === 'rejected') {
    warnings.push(`plan fetch failed: ${(plansRes.reason as Error)?.message ?? 'unknown'}`);
  }

  let decisions: Array<{ id: string; content: string; confidence: number }> | undefined;
  if (memRes.status === 'fulfilled' && memRes.value.nodes.length > 0) {
    decisions = memRes.value.nodes.map((n) => ({
      id: n.id,
      content: n.content,
      confidence: n.confidence,
    }));
  } else if (memRes.status === 'rejected') {
    warnings.push(`decisions fetch failed: ${(memRes.reason as Error)?.message ?? 'unknown'}`);
  }

  let covenantRules: Array<{ id: string; invariant: string; effect: string }> | undefined;
  if (covRes.status === 'fulfilled' && covRes.value && covRes.value.rules.length > 0) {
    covenantRules = covRes.value.rules.map((r) => ({
      id: r.id,
      invariant: r.invariant,
      effect: r.effect,
    }));
  } else if (covRes.status === 'rejected') {
    warnings.push(`covenant fetch failed: ${(covRes.reason as Error)?.message ?? 'unknown'}`);
  }

  return { plan, decisions, covenantRules, warnings };
}

/**
 * Covenant gate for `/deploy` and `/cleanup`. Called from the
 * `tool.execute.before` hook when a bash/task invocation appears to be
 * running one of those commands. Throws if the active covenant `deny`s the
 * corresponding `infra:deploy` / `infra:destroy` action.
 *
 * On `ask`, the existing sandbox/permission.ask flow handles the user
 * prompt — we do not block here. On any fetch failure (broker not logged in,
 * network error), we default to `deny` for infra operations because they are
 * side-effectful and the architecture demands fail-closed behavior.
 *
 * Returns the decision so the caller can branch on `ask` if it wants to
 * surface a custom prompt.
 */
async function checkInfraCovenant(
  action: 'infra:deploy' | 'infra:destroy',
  projectId?: string
): Promise<'allow' | 'deny' | 'ask'> {
  try {
    const env = action === 'infra:deploy' ? 'dev' : undefined;
    const perm = await intelligence.checkPermission({ action, environment: env }, { projectId });
    return perm.decision;
  } catch (err) {
    logger.warn('capix plugin: covenant check failed — fail-closed for infra', {
      action,
      error: (err as Error)?.message,
    });
    return 'deny';
  }
}

/** Patterns that detect `/deploy` or `/cleanup` invocations inside bash command args. */
const INFRA_COMMAND_PATTERNS: Array<{ pattern: RegExp; action: 'infra:deploy' | 'infra:destroy' }> =
  [
    { pattern: /(^|\s|;|&&|\|\|)\/deploy(\s|$)/, action: 'infra:deploy' },
    { pattern: /(^|\s|;|&&|\|\|)\/cleanup(\s|$)/, action: 'infra:destroy' },
  ];

// ── Planner / subagent / compactor / skills helpers ──────────────────────────

/**
 * Build a `ModelInvoker` backed by the capix provider stream. Used by the
 * planner and the context compactor to make single-shot model calls. Stays
 * decoupled from broker internals — it just consumes text deltas and surfaces
 * `error` chunks as thrown errors.
 */
function createModelInvoker(meta: CapixClientMeta): ModelInvoker {
  return async (prompt, opts) => {
    // Intelligence context: inject relevant memory into the prompt when loaded.
    // Failures are non-blocking — an intelligence outage never stops inference.
    let augmented = prompt;
    try {
      augmented = await intelligenceContext.augmentPrompt(prompt);
    } catch {
      augmented = prompt;
    }
    let text = '';
    for await (const chunk of capixStream(
      {
        model: process.env.CAPIX_PLANNER_MODEL ?? 'capix/auto',
        messages: [{ role: 'user', content: augmented }],
      },
      { meta, signal: opts?.signal }
    )) {
      if (chunk.type === 'text') {
        text += chunk.delta;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.message || `capix inference error: ${chunk.capixCode}`);
      }
    }
    return text;
  };
}

/** Render a `Plan` as a human-readable block for tool output. */
function renderPlan(plan: Plan): string {
  const lines: string[] = [`goal: ${plan.goal}`];
  if (plan.nonGoals.length) lines.push(`non-goals: ${plan.nonGoals.join(', ')}`);
  if (plan.assumptions.length) lines.push(`assumptions: ${plan.assumptions.join(', ')}`);
  if (plan.securityImplications.length)
    lines.push(`security: ${plan.securityImplications.join('; ')}`);
  if (plan.billingImplications.length)
    lines.push(`billing: ${plan.billingImplications.join('; ')}`);
  if (plan.rollbackStrategy) lines.push(`rollback: ${plan.rollbackStrategy}`);
  if (plan.definitionOfDone.length) {
    lines.push('definition of done:');
    for (const d of plan.definitionOfDone) lines.push(`  - ${d}`);
  }
  for (const s of plan.steps) {
    const dep = s.dependsOn?.length ? ` depends on ${s.dependsOn.join(',')}` : '';
    lines.push(`STEP ${s.id}: ${s.description} [${s.status}] (~${s.estimatedTurns} turns${dep})`);
    if (s.filesToRead.length) lines.push(`  READ: ${s.filesToRead.join(', ')}`);
    if (s.filesToEdit.length) lines.push(`  EDIT: ${s.filesToEdit.join(', ')}`);
    if (s.filesToCreate.length) lines.push(`  CREATE: ${s.filesToCreate.join(', ')}`);
    if (s.testsToRun.length) lines.push(`  TEST: ${s.testsToRun.join(', ')}`);
  }
  return lines.join('\n');
}

/** Render a `SubagentResult` as a human-readable block for tool output. */
function renderResult(result: SubagentResult): string {
  const lines: string[] = [
    `subagent ${result.subagentId} (step ${result.stepId})`,
    `status: ${result.status}`,
    `duration: ${result.durationMs}ms | turns: ${result.turns} | cost (USD minor): ${result.costMinor}`,
  ];
  if (result.filesChanged.length) {
    lines.push('changed files:');
    for (const f of result.filesChanged) lines.push(`  - ${f}`);
  }
  lines.push('summary:', result.summary);
  return lines.join('\n');
}

/** Render an `ArchitecturePlan` as a human-readable block for tool output. */
function renderArchitecturePlan(plan: ArchitecturePlan): string {
  const lines: string[] = [
    `architecture: ${plan.summary}`,
    `region: ${plan.region} | trust tier: ${plan.trustTier} | status: ${plan.status}`,
  ];
  if (plan.services.length) {
    lines.push('services:');
    for (const s of plan.services)
      lines.push(`  - ${s.name}: ${s.purpose} (runs on ${s.workload})`);
  }
  if (plan.dataStores.length) {
    lines.push('data stores:');
    for (const d of plan.dataStores) lines.push(`  - ${d.name} (${d.engine}): ${d.purpose}`);
  }
  if (plan.models.length) {
    lines.push('models:');
    for (const m of plan.models) lines.push(`  - ${m.name} [${m.modelRef}]: ${m.purpose}`);
  }
  lines.push('workloads:');
  for (const w of plan.workloads) {
    const best = w.quote ? routing.bestCandidate(w.quote) : null;
    const price = best
      ? `${routing.formatMoney(best.pricePerUnit)} / ${best.meteringUnit}`
      : w.quoteError
        ? `quote failed: ${w.quoteError}`
        : 'no candidate';
    lines.push(`  - ${w.name} (${w.kind}): ${w.purpose} — ${price}`);
  }
  if (plan.costEstimate?.total) {
    lines.push(
      `cost estimate: ${routing.formatMoney(plan.costEstimate.total)} per metering unit ` +
        `(quotes valid until ${plan.costEstimate.quotesExpireAt ?? 'unknown'})`
    );
  }
  if (plan.assumptions.length) lines.push(`assumptions: ${plan.assumptions.join('; ')}`);
  return lines.join('\n');
}

/** Render a deploy progress event as one human-readable line. */
function renderDeployEvent(event: DeployProgressEvent): string {
  switch (event.type) {
    case 'quoting':
      return `[quoting] ${event.workload}: requesting live quote from the smart router`;
    case 'quoted': {
      const c = event.candidate;
      const price = c
        ? `${routing.formatMoney(c.pricePerUnit)} / ${c.meteringUnit}`
        : 'no candidate';
      return `[quoted] ${event.workload}: ${price} in ${c?.region ?? 'unknown'} (${c?.trustTier ?? 'unknown'} tier), valid until ${event.expiresAt}`;
    }
    case 'committing':
      return `[committing] ${event.workload}: locking placement`;
    case 'committed':
      return `[committed] ${event.workload}: deployment ${event.deploymentId}`;
    case 'state':
      return `[state] ${event.workload}: ${event.state}${event.summary ? ` — ${event.summary}` : ''}`;
    case 'healthy': {
      const eps = event.endpoints.map((e) => e.url).join(', ') || 'no endpoints yet';
      return `[healthy] ${event.workload}: running at ${eps} (spend to date ${routing.formatMoney(event.spendToDate)})`;
    }
    case 'failed':
      return `[failed] ${event.workload}: ${event.error}`;
    case 'done':
      return `[done] ${event.succeeded} running, ${event.failed} failed`;
  }
}

/** Render a training progress event as one human-readable line. */
function renderTrainEvent(event: TrainProgressEvent): string {
  switch (event.type) {
    case 'validating':
      return '[validating] hashing dataset and checking covenant';
    case 'submitting':
      return `[submitting] ${event.baseModel}: creating training job…`;
    case 'submitted':
      return `[submitted] job ${event.jobId}`;
    case 'state': {
      const epoch =
        event.currentEpoch !== undefined
          ? `epoch ${event.currentEpoch}/${event.totalEpochs ?? '?'} · `
          : '';
      const percent = event.percent !== undefined ? ` · ${event.percent}%` : '';
      return `[${event.state}] ${epoch}${event.jobId}${percent}`;
    }
    case 'checkpoint':
      return `[training] epoch ${event.epoch} · checkpoint ${event.checkpointId}`;
    case 'registered':
      return `[ready] model registered: ${event.modelId}`;
    case 'failed':
      return `[failed]${event.jobId ? ` job ${event.jobId}:` : ''} ${event.message}`;
    case 'done':
      return `[done]${event.modelId ? ` model ${event.modelId}` : ''}`;
  }
}

/** Best-effort extraction of user-authored text from a chat message's parts. */
function extractUserText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => p as { type?: string; text?: string })
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .filter((t) => t.length > 0)
    .join('\n')
    .trim();
}

// ── Cross-surface brain sync helpers ──────────────────────────────────────────
// The local CodebaseIndexer keeps a symbol + import graph in memory. These
// helpers distill it into a compact codebase summary + active-files list that
// get pushed to the server via `intelligence.syncProjectContext`, so the web
// chat (and any other surface) can answer "what is the user working on?".

const ENTRY_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'main.ts',
  'main.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.tsx',
]);
const ENTRY_RELS = new Set([
  'app/layout.tsx',
  'src/index.ts',
  'src/main.ts',
  'pages/index.tsx',
  'pages/index.ts',
]);

/** Read package.json deps and best-effort guess a framework label. */
function inferFramework(root: string): string {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
    if (has('next')) return 'next.js';
    if (has('nuxt')) return 'nuxt';
    if (has('@remix-run/react') || has('@remix-run/node')) return 'remix';
    if (has('@sveltejs/kit') || has('svelte')) return 'svelte';
    if (has('vue')) return 'vue';
    if (has('@nestjs/core')) return 'nestjs';
    if (has('react')) return 'react';
    if (has('express')) return 'express';
    if (has('fastify')) return 'fastify';
    if (has('astro')) return 'astro';
    if (has('commander') || has('yargs') || has('@oclif/command')) return 'node-cli';
    return 'node.js';
  } catch {
    return 'unknown';
  }
}

/** Build a compact codebase summary from the local index. */
function buildCodebaseSummary(indexer: CodebaseIndexer): ProjectContextCodebaseSummary | null {
  const index = indexer.getIndex();
  if (!index || index.files.size === 0) return null;

  const byLang = new Map<string, number>();
  const moduleCount = new Map<string, number>();
  const entryPoints: string[] = [];

  for (const fi of index.files.values()) {
    byLang.set(fi.language, (byLang.get(fi.language) ?? 0) + 1);
    const rel = indexer.getRelativePath(fi.path);
    const top = rel.split(sep)[0] ?? '';
    if (top && top !== '.') moduleCount.set(top, (moduleCount.get(top) ?? 0) + 1);
    if (ENTRY_BASENAMES.has(basename(fi.path)) || ENTRY_RELS.has(rel)) {
      if (!entryPoints.includes(rel)) entryPoints.push(rel);
    }
  }

  const languages = [...byLang.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const keyModules = [...moduleCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([m]) => m);

  return {
    totalFiles: index.files.size,
    languages,
    keyModules,
    entryPoints: entryPoints.slice(0, 8),
    framework: inferFramework(index.rootPath),
  };
}

/** Files most recently modified, as relative paths (proxy for "active files"). */
function extractActiveFiles(indexer: CodebaseIndexer, limit = 15): string[] {
  const index = indexer.getIndex();
  if (!index) return [];
  return [...index.files.values()]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, limit)
    .map((fi) => indexer.getRelativePath(fi.path));
}

/**
 * Read a bounded set of high-signal repository files for broad questions
 * such as "map this codebase". A structural orientation is useful, but a
 * coding agent must also see actual manifests, entry points, docs, and tests
 * before it can make repository-specific claims.
 */
function buildOrientationEvidence(indexer: CodebaseIndexer): Array<{
  path: string;
  reason: string;
  content: string;
}> {
  const index = indexer.getIndex();
  if (!index) return [];

  const candidates = [...index.files.values()]
    .map((file) => ({ file, path: indexer.getRelativePath(file.path) }))
    .filter(({ path }) =>
      /(^|\/)(readme[^/]*|package\.json|cargo\.toml|pyproject\.toml|go\.mod|[^/]*(?:config|entry|main|index)\.[^/]+|[^/]*\.test\.[^/]+)$/i.test(
        path,
      ),
    )
    .sort((a, b) => {
      const rank = (path: string) => {
        if (/^readme/i.test(path)) return 0;
        if (/^(package\.json|cargo\.toml|pyproject\.toml|go\.mod)$/i.test(path)) return 1;
        if (/(^|\/)(main|index|entry)\.[^/]+$/i.test(path)) return 2;
        if (/\.test\.[^/]+$/i.test(path)) return 3;
        return 4;
      };
      return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
    });

  const evidence: Array<{ path: string; reason: string; content: string }> = [];
  let remaining = 12_000;
  for (const candidate of candidates.slice(0, 10)) {
    if (remaining <= 0) break;
    try {
      const raw = readFileSync(candidate.file.path, 'utf8');
      const content = raw.slice(0, Math.min(2_500, remaining));
      if (!content.trim()) continue;
      evidence.push({
        path: candidate.path,
        reason: 'automatic repository orientation',
        content,
      });
      remaining -= content.length;
    } catch {
      // Binary, removed, or transient files do not block the turn.
    }
  }
  return evidence;
}

/**
 * Real plugin factory. Returns Hooks wired to the broker-backed provider,
 * the OAuth/auth bridge, and the workspace sandbox.
 *
 * The `capix/auto` target delegates model selection to the server: it reuses
 * the same provider hook and catalog; the server resolves `auto` to a real
 * stable model id per request.
 */
export const plugin: Plugin = async (
  input: PluginInput,
  options?: Record<string, unknown>
): Promise<Hooks> => {
  const opts = (options ?? {}) as CapixPluginOptions;

  const releaseId =
    opts.releaseId ?? process.env.CAPIX_RELEASE_ID ?? process.env.CAPIX_CODE_RELEASE_ID ?? 'dev';
  const clientVersion = opts.clientVersion ?? CAPIX_PLUGIN_VERSION;
  const meta = {
    releaseId,
    client: 'capix-code' as const,
    clientVersion,
    pluginVersion: CAPIX_PLUGIN_VERSION,
    acpVersion: CAPIX_ACP_VERSION,
  };

  const broker = getBroker();
  const sandbox = getSandbox(opts);
  const agentMode = getAgentMode(opts);

  // Register the broker accessor and inference base resolver so the provider
  // module talks ONLY to the broker, never to a stored token.
  const { setBrokerAccessor, setInferenceBaseResolver } = await import('./capix-provider.js');
  setBrokerAccessor(() => broker);
  setInferenceBaseResolver(() => opts.inferenceBaseUrl ?? CAPIX_INFERENCE_BASE);
  const { setRouteObserver } = await import('./ai-sdk-provider.js');
  setRouteObserver((servedModel) => sessionStatus.setModel(servedModel));

  // Wire the intelligence-client (chat.params context injection + the
  // /deploy + /cleanup covenant gate) to the same broker. This is the single
  // intelligence integration point with the chat engine.
  wireIntelligence(broker, opts, {
    releaseId,
    clientVersion,
    pluginVersion: CAPIX_PLUGIN_VERSION,
  });

  // Wire the routing-client (smart router quotes, deployment lifecycle,
  // balance, managed model catalog) to the same broker and base URL.
  routing.setBrokerAccessor(() => broker);
  routing.setRoutingBaseResolver(() => opts.apiBaseUrl ?? routing.CAPIX_ROUTING_BASE);
  routing.setClientMetaAccessor(() => ({
    client: 'capix-code',
    clientVersion,
    pluginVersion: CAPIX_PLUGIN_VERSION,
    releaseId,
  }));

  // Feed the shared TUI session status store with what is known at load.
  sessionStatus.setMode(agentMode);

  // ── Codebase indexer + retriever (agent brain: local codebase context) ──
  // The indexer parses the project into a symbol + import graph (regex-based,
  // Node built-ins only) and keeps it fresh via a debounced fs.watch. The
  // `chat.params` hook below injects retrieved context into each turn; the
  // `capix_*` tools let the model search the codebase on demand. Indexing
  // runs in the background and is non-blocking: the hooks degrade gracefully
  // (empty orientation) until the first index is ready.
  const indexerRoot = opts.workspaceRoot ?? input.directory ?? process.cwd();
  const hasExplicitWorkspace = Boolean(opts.workspaceRoot ?? input.directory);
  const codebaseIndexer = new CodebaseIndexer(indexerRoot);
  const contextRetriever = new ContextRetriever(codebaseIndexer);

  // Cross-surface brain sync: after indexing (and on every re-index from a
  // file change) push the local orientation + codebase summary + active
  // files to the server. The web chat can then query what the user is working
  // on in the IDE/CLI. Debounced so a burst of edits triggers one sync.
  let contextSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let contextSyncInFlight = false;
  async function pushProjectContext(): Promise<void> {
    const index = codebaseIndexer.getIndex();
    if (!index || index.files.size === 0) return;
    let orientation: string;
    try {
      orientation = await contextRetriever.getOrientation();
    } catch {
      return;
    }
    const codebaseSummary = buildCodebaseSummary(codebaseIndexer);
    if (!codebaseSummary) return;
    const activeFiles = extractActiveFiles(codebaseIndexer);
    await intelligence.syncProjectContext({
      orientation,
      codebaseSummary,
      activeFiles,
      sessionSource: 'capix-code',
    });
  }
  function scheduleContextSync(): void {
    if (contextSyncTimer) clearTimeout(contextSyncTimer);
    contextSyncTimer = setTimeout(() => {
      contextSyncTimer = null;
      if (contextSyncInFlight) return;
      contextSyncInFlight = true;
      pushProjectContext()
        .catch((err) => {
          logger.warn('capix plugin: project context sync failed', {
            error: (err as Error)?.message,
          });
        })
        .finally(() => {
          contextSyncInFlight = false;
        });
    }, 1500);
  }
  codebaseIndexer.onIndexUpdated(() => scheduleContextSync());
  if (hasExplicitWorkspace) {
    codebaseIndexer
      .indexAll()
      .then(() => {
        codebaseIndexer.startWatch();
        scheduleContextSync();
      })
      .catch((err) =>
        logger.warn('capix plugin: codebase indexAll failed', {
          error: (err as Error)?.message,
        })
      );
  }

  // ── Planner / SubagentManager / ContextCompactor / SkillsRuntime ──────
  // The planner decomposes a request into checkpointable steps; subagents run
  // steps in isolated git worktrees; the compactor summarizes long sessions;
  // the skills runtime selects first-party skills per message. The planner
  // reuses the codebase-index ContextRetriever (structurally compatible — it
  // exposes getOrientation() and findRelevantFiles() with the same shape).
  const modelInvoker = createModelInvoker(meta);
  const planner = new Planner(contextRetriever, modelInvoker, indexerRoot);
  // Architect mode: intent → system architecture with live router quotes.
  // Deploy mode: approved architecture → workloads dispatched via the smart
  // router, with health monitoring and streamed progress.
  const architect = new Architect(modelInvoker);
  const deployer = new Deployer(architect);
  // Train mode: fine-tune a base model on a dataset, register the result.
  const trainer = new Trainer();
  // Sandpit: isolated refactor/review/test environment.
  const sandpit = new Sandpit();
  // Private models: deploy and fine-tune owner-only models.
  const privateModelManager = new PrivateModelManager();
  // MVP: idea → deployed product.
  const mvpPlanner = new MvpPlanner(modelInvoker);
  const mvpDeployer = new MvpDeployer(mvpPlanner);
  // Full solution: MVP → production architecture.
  const fullSolutionPlanner = new FullSolutionPlanner(modelInvoker);
  // Resolve the engine binary path from (1) env var set by launcher, (2) relative
  // to the plugin's own directory, (3) standard install locations.
  const enginePath =
    process.env.CAPIX_CODE_ENGINE ||
    join(process.env.HOME || '/home/user', '.capix-code', 'engine', 'capix-engine') ||
    join(process.cwd(), 'dist', 'customer', 'engine', 'capix-engine');
  const engineCommandResolver: EngineCommandResolver = (config) => {
    if (!existsSync(enginePath)) return null;
    const prompt = `Implement this step: ${config.planStep.description}\n\nFiles to read: ${config.planStep.filesToRead.join(', ') || 'none specified'}\nFiles to edit: ${config.planStep.filesToEdit.join(', ') || 'none specified'}\nFiles to create: ${config.planStep.filesToCreate.join(', ') || 'none specified'}\n\nAfter implementing, run: ${config.planStep.testsToRun.join(' && ') || 'echo no tests'}`;
    return {
      command: enginePath,
      args: ['--non-interactive', '--prompt', prompt, '--max-turns', String(config.maxTurns)],
    };
  };
  const subagentManager = new SubagentManager(indexerRoot, engineCommandResolver);
  const compactor = new ContextCompactor(modelInvoker);
  const skillsRt = new SkillsRuntime();
  for (const s of BUILTIN_SKILLS) {
    await skillsRt.install(s);
    // Register with the server-backed skill registry off the startup path.
    // Network/auth latency must never delay provider initialization.
    void import('./intelligence-client.js')
      .then((intelligence) =>
        intelligence.registerSkill({
          id: s.id,
          source: `first-party:${s.id}`,
          version: s.version,
          description: s.description,
          riskClass: s.permissions.includes('bash') ? 'side-effect' : 'informational',
          permissions: s.permissions,
          trustFloor: 'untrusted',
        })
      )
      .catch(() => {});
  }

  // Rolling transcript for loss-aware compaction + latest task for skill
  // auto-select. Populated by the `chat.message` hook; consumed by
  // `chat.params`. Persisted across turns within this plugin instance.
  const transcript: Array<{ role: string; content: string }> = [];
  let latestTask = '';
  const COMPACT_THRESHOLD_TOKENS = 6000;

  async function buildTurnSystemContext(): Promise<string> {
    const intelligenceContext = await fetchIntelligenceContext(undefined).catch((err) => {
      logger.warn('capix plugin: system intelligence injection failed', {
        error: (err as Error)?.message,
      });
      return undefined;
    });

    let codebaseContext: unknown;
    try {
      if (latestTask.trim()) {
        const retrieved = await contextRetriever.retrieve(latestTask, { maxTokens: 3000 });
        codebaseContext = retrieved.files.length > 0
          ? {
              type: 'retrieval',
              files: retrieved.files.map((file) => ({
                path: file.path,
                reason: file.reason,
                score: file.score,
                lines: file.lines,
                content: file.content,
              })),
              symbols: retrieved.symbols,
              sources: retrieved.sources,
              totalTokens: retrieved.totalTokens,
            }
          : {
              type: 'orientation',
              summary: await contextRetriever.getOrientation(),
              evidence: buildOrientationEvidence(codebaseIndexer),
            };
      } else {
        codebaseContext = {
          type: 'orientation',
          summary: await contextRetriever.getOrientation(),
          evidence: buildOrientationEvidence(codebaseIndexer),
        };
      }
    } catch (err) {
      logger.warn('capix plugin: system codebase injection failed', {
        error: (err as Error)?.message,
      });
    }

    let selectedSkill: { id: string; systemPrompt: string; reason: string } | null = null;
    if (latestTask) {
      const selected = skillsRt.autoSelect(latestTask);
      if (selected) {
        selectedSkill = {
          id: selected.skill.id,
          systemPrompt: selected.skill.systemPrompt,
          reason: selected.reason,
        };
      }
    }

    let compacted: unknown;
    const chars = transcript.reduce((total, message) => total + message.content.length, 0);
    if (Math.ceil(chars / 4) > COMPACT_THRESHOLD_TOKENS) {
      compacted = await compactor.compact(transcript).catch((err) => {
        logger.warn('capix plugin: system compaction failed', { error: (err as Error)?.message });
        return undefined;
      });
      if (compacted && typeof compacted === 'object' && 'summary' in compacted) {
        transcript.length = 0;
        transcript.push({ role: 'system', content: String((compacted as { summary: unknown }).summary) });
      }
    }

    return formatCapixSystemContext({
      intelligence: intelligenceContext,
      codebase: codebaseContext,
      skill: selectedSkill,
      compaction: compacted,
    });
  }

  const z = tool.schema;

  const capixSearchCodebase = tool({
    description:
      'Search the workspace codebase for files and symbols relevant to a ' +
      'natural-language query, symbol name, or path fragment. Returns matching ' +
      'files ranked by relevance with reasons.',
    args: {
      query: z.string().describe('Natural-language query, symbol name, or path fragment'),
      limit: z.number().optional().describe('Maximum number of files to return (default 10)'),
    },
    async execute(args) {
      const results = await contextRetriever.findRelevantFiles(args.query, args.limit ?? 10);
      if (results.length === 0) {
        return {
          title: `capix_search_codebase: ${args.query}`,
          output: 'No matching files found in the codebase index.',
        };
      }
      const lines = results.map((r) => `${r.score.toFixed(2)}  ${r.path}  — ${r.reason}`);
      return {
        title: `capix_search_codebase: ${args.query}`,
        output: lines.join('\n'),
        metadata: { results },
      };
    },
  });

  const capixFindReferences = tool({
    description:
      'Find the definition and all references to a named symbol across the ' +
      'workspace codebase. Returns file:line locations and the symbol type.',
    args: {
      symbol: z.string().describe('Exact symbol name (function, class, variable, etc.)'),
    },
    async execute(args) {
      const def = codebaseIndexer.findDefinition(args.symbol);
      const refs = codebaseIndexer.findReferences(args.symbol);
      const lines: string[] = [];
      if (def) {
        lines.push(`definition: ${def.type} ${def.name} — ${def.filePath}:${def.line}`);
      }
      for (const r of refs) {
        lines.push(`${r.type}  ${r.filePath}:${r.line}  (${r.name})`);
      }
      return {
        title: `capix_find_references: ${args.symbol}`,
        output: lines.length ? lines.join('\n') : 'No references found.',
        metadata: { definition: def ?? null, references: refs },
      };
    },
  });

  const capixGetOrientation = tool({
    description:
      'Get a compact summary of the project: detected frameworks, entry ' +
      'points, key modules, and notable exports. Call this first when you ' +
      'need a high-level understanding of the codebase.',
    args: {},
    async execute() {
      const orientation = await contextRetriever.getOrientation();
      return { title: 'capix_get_orientation', output: orientation };
    },
  });

  const capixPlan = tool({
    description:
      'Create a structured, checkpointable plan from a natural-language ' +
      'request. Decomposes the request into ordered steps with file ' +
      'read/edit/create lists, tests, dependencies, and estimated turns. ' +
      'Returns the plan as text for review before execution.',
    args: {
      request: z.string().describe('The user request to decompose into a plan.'),
    },
    async execute(args, context) {
      const plan = await planner.plan(args.request);
      // Persist the plan durably in the agent runtime so it survives restarts
      // and is visible to other clients (IDE, ACP) — best-effort, never
      // blocks plan rendering.
      try {
        const rt = getAgentRuntime(meta, indexerRoot);
        const sessionId = context.sessionID ?? `plugin-${releaseId}`;
        try {
          await rt.createSession({ sessionId, mode: agentMode, workspaceRoot: indexerRoot });
        } catch {
          // Session already adopted — fine.
        }
        await rt.createPlan(sessionId, {
          goal: plan.goal,
          definitionOfDone: plan.definitionOfDone,
          steps: plan.steps.map((s) => ({
            description: s.description,
            files: [...s.filesToRead, ...s.filesToEdit, ...s.filesToCreate],
            tests: s.testsToRun,
          })),
        });
      } catch (err) {
        logger.warn('capix plugin: plan persistence failed', {
          error: (err as Error)?.message,
        });
      }
      return {
        title: `capix_plan: ${plan.goal}`,
        output: renderPlan(plan),
        metadata: { planId: plan.id, stepCount: plan.steps.length, status: plan.status },
      };
    },
  });

  const capixDelegate = tool({
    description:
      'Delegate a plan step to an isolated subagent running in its own git ' +
      'worktree, bounded by turns / elapsed time / spend. The subagent runs ' +
      'the step autonomously; the parent reviews the resulting diff afterwards ' +
      '(capix_checkpoint) and merges or discards. Returns changed files and ' +
      'completion status.',
    args: {
      stepDescription: z.string().describe('Description of the step to delegate.'),
      filesToRead: z.array(z.string()).optional().describe('Files the subagent should read first.'),
      filesToEdit: z.array(z.string()).optional().describe('Files the subagent will modify.'),
      filesToCreate: z.array(z.string()).optional().describe('New files the subagent will create.'),
      testsToRun: z.array(z.string()).optional().describe('Test commands to run after the step.'),
      maxTurns: z.number().optional().describe('Hard turn limit (default 8).'),
      maxElapsedMs: z.number().optional().describe('Hard time limit in ms (default 120000).'),
      maxSpendUsdMinor: z
        .string()
        .optional()
        .describe('Hard spend limit in USD minor units (default "500").'),
      model: z.string().optional().describe('Model target (default capix/auto).'),
    },
    async execute(args, context) {
      const worktreeRoot = context.worktree ?? context.directory ?? indexerRoot;
      const stepId = `del-${Date.now()}`;
      const planStep: PlanStep = {
        id: stepId,
        description: args.stepDescription,
        filesToRead: args.filesToRead ?? [],
        filesToEdit: args.filesToEdit ?? [],
        filesToCreate: args.filesToCreate ?? [],
        testsToRun: args.testsToRun ?? [],
        estimatedTurns: args.maxTurns ?? 8,
        status: 'in-progress',
      };
      // Use specialist agent if specified, otherwise default to implement.
      // Specialist definitions come from the shared agent runtime.
      const rt = getAgentRuntime(meta, indexerRoot);
      const specialistRole =
        ((args as Record<string, unknown>).specialist as string) || 'implement';
      const specialist = rt.getSpecialist(specialistRole) ?? rt.getSpecialist('implement')!;

      const config: SubagentConfig = {
        role: specialist.role,
        planStep,
        model: args.model ?? 'capix/auto',
        maxTurns: specialist.maxTurns,
        maxElapsedMs: specialist.maxElapsedMs,
        maxSpendUsdMinor: specialist.maxSpendUsdMinor,
        worktreePath: join(worktreeRoot, '.capix', 'worktrees', stepId),
        parentSessionId: context.sessionID,
        allowedTools: specialist.allowedTools,
        filesystemScope: worktreeRoot,
        approvalRules: specialist.fileScope === 'read-only' ? 'auto' : 'ask-parent',
      };
      const result = await subagentManager.spawn(config);
      // Record the delegation as a specialist child session in the runtime so
      // the agents panel / IDE can list lineage (best-effort).
      try {
        if (context.sessionID) {
          try {
            await rt.createSession({
              sessionId: context.sessionID,
              mode: agentMode,
              workspaceRoot: indexerRoot,
            });
          } catch {
            // Session already adopted — fine.
          }
          await rt.createChildSession(context.sessionID, specialist.role, planStep.description);
        }
      } catch (err) {
        logger.warn('capix plugin: child session bookkeeping failed', {
          error: (err as Error)?.message,
        });
      }
      return {
        title: `capix_delegate: ${args.stepDescription}`,
        output: renderResult(result),
        metadata: {
          subagentId: result.subagentId,
          status: result.status,
          filesChanged: result.filesChanged,
          costMinor: result.costMinor.toString(),
          durationMs: result.durationMs,
        },
      };
    },
  });

  const capixArchitect = tool({
    description:
      'Architect mode: turn a natural-language intent into a deployable ' +
      'system architecture — services, data stores, models, infrastructure, ' +
      'trust tier, region — with live cost quotes from the smart router. ' +
      'The plan is returned for review; nothing is provisioned until it is ' +
      'approved and deployed with capix_deploy.',
    args: {
      intent: z.string().describe('What the user wants to build or run, in natural language.'),
      approve: z
        .boolean()
        .optional()
        .describe('Approve the resulting plan for deployment (default false).'),
    },
    async execute(args, context) {
      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('planning');
      try {
        const plan = await architect.design(args.intent);
        if (args.approve) {
          architect.approve(plan.id);
        }
        sessionStatus.setAgentState(plan.status === 'approved' ? 'idle' : 'awaiting-approval');
        return {
          title: `capix_architect: ${plan.summary.slice(0, 60)}`,
          output: renderArchitecturePlan(plan),
          metadata: {
            planId: plan.id,
            status: plan.status,
            workloads: plan.workloads.length,
            costEstimate: plan.costEstimate?.total ?? null,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  const capixDeploy = tool({
    description:
      'Deploy mode: convert the approved architecture plan into workloads ' +
      'and dispatch them through the smart router. Monitors each deployment ' +
      'until it is healthy and streams progress. Requires an approved plan ' +
      'from capix_architect; spend is always confirmed by that approval.',
    args: {
      planId: z
        .string()
        .optional()
        .describe('Architecture plan id to deploy (default: the current approved plan).'),
    },
    async execute(args, context) {
      const plan = architect.getCurrentPlan();
      if (!plan || (args.planId && plan.id !== args.planId)) {
        return {
          title: 'capix_deploy',
          output: 'No matching architecture plan. Run capix_architect first and approve the plan.',
        };
      }

      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('deploying');
      const progress: string[] = [];
      try {
        const result = await deployer.deploy(plan, {
          onEvent: (event) => {
            progress.push(renderDeployEvent(event));
            if (event.type === 'healthy') {
              sessionStatus.recordSpend(
                event.spendToDate.amountMinor,
                event.spendToDate.currency,
                event.spendToDate.scale
              );
            }
          },
        });
        sessionStatus.setAgentState('idle');
        const lines = [`deploy plan ${result.planId}: ${result.status}`, ...progress, 'workloads:'];
        for (const w of result.workloads) {
          lines.push(
            `  - ${w.name}: ${w.state}${w.deploymentId ? ` (${w.deploymentId})` : ''}${w.error ? ` — ${w.error}` : ''}`
          );
        }
        return {
          title: `capix_deploy: ${result.status}`,
          output: lines.join('\n'),
          metadata: {
            planId: result.planId,
            status: result.status,
            workloads: result.workloads,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  const capixTrain = tool({
    description:
      'Train mode: fine-tune a base model on a dataset via Capix — submit, ' +
      'monitor progress, register the model in your catalog. Streams ' +
      'checkpoints and epoch progress until the job reaches a terminal state.',
    args: {
      model: z.string().describe('Base model id to fine-tune (e.g. llama-3.1-8b-instruct).'),
      dataset: z.string().describe('Path to the dataset file (.jsonl, .parquet, .csv, or text).'),
      specialize: z
        .string()
        .describe('Specialization prompt describing the behavior to train for.'),
      epochs: z.number().optional().describe('Training epochs (server default otherwise).'),
      learningRate: z.number().optional().describe('Learning rate (server default otherwise).'),
      loraRank: z.number().optional().describe('LoRA rank (server default otherwise).'),
    },
    async execute(args, context) {
      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('training');
      const progress: string[] = [];
      try {
        const hyperparameters: Record<string, number> = {};
        if (args.epochs !== undefined) hyperparameters.epochs = args.epochs;
        if (args.learningRate !== undefined) hyperparameters.learningRate = args.learningRate;
        if (args.loraRank !== undefined) hyperparameters.loraRank = args.loraRank;
        const result = await trainer.train({
          baseModel: args.model,
          datasetPath: args.dataset,
          specialize: args.specialize,
          ...(Object.keys(hyperparameters).length > 0 ? { hyperparameters } : {}),
          onEvent: (event) => progress.push(renderTrainEvent(event)),
        });
        sessionStatus.setAgentState('idle');
        if (result.costMinor !== undefined && result.asset && result.scale !== undefined) {
          sessionStatus.recordSpend(result.costMinor, result.asset, result.scale);
        }
        const lines = [`train ${args.model}: ${result.status}`, ...progress];
        if (result.modelId) {
          lines.push(`registered model: ${result.modelId}`);
        }
        if (result.costMinor !== undefined && result.asset && result.scale !== undefined) {
          lines.push(
            `cost: ${routing.formatMoney({ amountMinor: result.costMinor, currency: result.asset, scale: result.scale })}`
          );
        }
        if (result.error) lines.push(`error: ${result.error}`);
        return {
          title: `capix_train: ${result.status}`,
          output: lines.join('\n'),
          metadata: {
            jobId: result.jobId ?? null,
            status: result.status,
            modelId: result.modelId ?? null,
            error: result.error ?? null,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  // ── Inline completion tool ───────────────────────────────────────────
  // The completion engine is invocable explicitly by the agent and by users
  // (full ghost-text TUI rendering wires into the OpenCode keymap layer in a
  // later round). Sessions are per-file and cached by path.
  const completionSessions = new Map<string, InlineCompletionSession>();
  const capixComplete = tool({
    description:
      'Inline code completion: get a smart completion for a file at a cursor ' +
      'position. Uses the cheapest code-capable model from the managed catalog ' +
      'via the smart router. Provide the file content and cursor position.',
    args: {
      filePath: z.string().describe('Path of the file being edited.'),
      content: z.string().describe('Current file content.'),
      cursorOffset: z.number().describe('Cursor position as a character offset into content.'),
    },
    async execute(args) {
      let session = completionSessions.get(args.filePath);
      if (!session) {
        session = new InlineCompletionSession({ meta });
        completionSessions.set(args.filePath, session);
      }
      await session.update({
        filePath: args.filePath,
        content: args.content,
        cursorOffset: args.cursorOffset,
        projectSnippets: [],
      });
      const suggestion = session.getCurrent();
      if (!suggestion) {
        return { title: 'capix_complete', output: 'No completion available for this position.' };
      }
      return {
        title: `capix_complete (${suggestion.model})`,
        output: suggestion.text,
        metadata: { model: suggestion.model, fromCache: suggestion.fromCache },
      };
    },
  });

  const capixMvpArchitect = tool({
    description:
      'MVP architect: turn a product idea into a deployable MVP plan — ' +
      'Next.js frontend, auth, Postgres database, and deployment topology. ' +
      'Returns the plan for review; nothing is provisioned until approved.',
    args: {
      intent: z.string().describe('The product idea in natural language.'),
      approve: z.boolean().optional().describe('Approve the resulting plan for deployment.'),
    },
    async execute(args, context) {
      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('planning');
      try {
        const mvp = await mvpPlanner.design(args.intent);
        const plan = mvp.architecture;
        if (args.approve) {
          mvpPlanner.approve(plan.id);
        }
        sessionStatus.setAgentState(plan.status === 'approved' ? 'idle' : 'awaiting-approval');
        return {
          title: `capix_mvp_architect: ${plan.summary.slice(0, 60)}`,
          output: renderArchitecturePlan(plan),
          metadata: {
            planId: plan.id,
            status: plan.status,
            workloads: plan.workloads.length,
            costEstimate: plan.costEstimate?.total ?? null,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  const capixMvpDeploy = tool({
    description:
      'MVP deploy: deploy an approved MVP plan — provisions the website, ' +
      'auth service, and database. Returns the product URL, admin access, ' +
      'and cost tracking.',
    args: {
      planId: z
        .string()
        .optional()
        .describe('MVP plan id to deploy (default: current approved plan).'),
    },
    async execute(args, context) {
      const plan = mvpPlanner.getCurrentPlan();
      if (!plan || (args.planId && plan.architecture.id !== args.planId)) {
        return {
          title: 'capix_mvp_deploy',
          output: 'No matching MVP plan. Run capix_mvp_architect first and approve the plan.',
        };
      }
      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('deploying');
      const progress: string[] = [];
      try {
        const result = await mvpDeployer.deploy(plan, {
          onEvent: (event) => progress.push(renderDeployEvent(event)),
        });
        sessionStatus.setAgentState('idle');
        const lines = [`mvp deploy: ${result.status}`, ...progress];
        if (result.url) lines.push(`url: ${result.url}`);
        if (result.adminAccess) lines.push(`admin: ${result.adminAccess.consolePath}`);
        if (result.spendToDate) lines.push(`spend: ${routing.formatMoney(result.spendToDate)}`);
        return {
          title: `capix_mvp_deploy: ${result.status}`,
          output: lines.join('\n'),
          metadata: {
            planId: result.planId,
            status: result.status,
            url: result.url ?? null,
            adminAccess: result.adminAccess ?? null,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  const capixFullSolution = tool({
    description:
      'Full solution architect: analyze an existing MVP directory and produce ' +
      'a production architecture — microservices, caching, CDN, monitoring, ' +
      'and scaling topology.',
    args: {
      mvpPath: z.string().describe('Path to the existing MVP directory.'),
      scaleIntent: z
        .string()
        .describe('How to scale it (e.g. "to production", "handle 10k users").'),
      approve: z.boolean().optional().describe('Approve the resulting plan for deployment.'),
    },
    async execute(args, context) {
      sessionStatus.setSession(context.sessionID ?? null);
      sessionStatus.setAgentState('planning');
      try {
        const result = await fullSolutionPlanner.design(args.scaleIntent, {
          fromMvp: args.mvpPath,
        });
        const plan = result.architecture;
        if (args.approve) {
          fullSolutionPlanner.approve(plan.id);
        }
        sessionStatus.setAgentState(plan.status === 'approved' ? 'idle' : 'awaiting-approval');
        return {
          title: `capix_full_solution: ${plan.summary.slice(0, 60)}`,
          output: renderArchitecturePlan(plan),
          metadata: {
            planId: plan.id,
            status: plan.status,
            workloads: plan.workloads.length,
            costEstimate: plan.costEstimate?.total ?? null,
          },
        };
      } catch (err) {
        sessionStatus.setAgentState('idle');
        throw err;
      }
    },
  });

  // ── MCP Supervisor ─────────────────────────────────────────────────────
  // Feed real MCP health into the session status store so the TUI shows
  // "mcp connected (N tools)" instead of a stale disconnected state.
  startMcpSupervision();

  const capixHook = createCapixProviderHook();

  logger.info('capix plugin loaded', {
    provider: capixProvider.name,
    sandbox: sandbox.profile,
    releaseId,
  });

  const hooks: Hooks = {
    // ── Provider registration (real ProviderHook) ────────────────────────
    provider: capixHook as Hooks['provider'],

    // ── Config: zero-config Capix MCP registration with supervision ────────
    // The OpenCode config is user-owned, so instead of writing to the file we
    // inject the Capix MCP server programmatically here. The env is filled at
    // runtime with the broker access token (never persisted to the config
    // file); if the broker isn't logged in yet the env stays empty and is
    // rehydrated on the next session once auth completes. Non-throwing so a
    // broker miss can never block config resolution.
    config: async (input) => {
      try {
        // Inject CAPIX_API_KEY into the provider config so the V2 provider
        // system passes it as apiKey to createCapix or the generic fallback.
        const envKey = process.env.CAPIX_API_KEY?.trim();
        if (envKey && input.provider?.capix) {
          if (!input.provider.capix.options) input.provider.capix.options = {};
          if (!input.provider.capix.options.apiKey) {
            input.provider.capix.options.apiKey = envKey;
          }
        }
        if (!input.mcp) input.mcp = {};
        const servers = input.mcp as Record<string, unknown>;
        if (!servers.capix) {
          let apiKey = '';
          try {
            apiKey = process.env.CAPIX_API_KEY?.trim() || '';
          } catch {
            // Not logged in yet — env stays empty; the broker refreshes on
            // demand once auth completes.
          }
          servers.capix = {
            type: 'local',
            command: [mcpServerEntry(), 'server', '--stdio'],
            enabled: true,
            ...(apiKey ? { environment: { CAPIX_API_KEY: apiKey } } : {}),
          };
        }
      } catch (err) {
        logger.warn('capix plugin: MCP config hook failed', { error: (err as Error)?.message });
      }
    },

    // ── Tools: codebase search + planner delegation ───────────────────────
    tool: {
      capix_search_codebase: capixSearchCodebase,
      capix_find_references: capixFindReferences,
      capix_get_orientation: capixGetOrientation,
      capix_plan: capixPlan,
      capix_delegate: capixDelegate,
      capix_architect: capixArchitect,
      capix_deploy: capixDeploy,
      capix_train: capixTrain,
      capix_complete: capixComplete,
      ...adaptRuntimeTools(createSandpitTools(sandpit)),
      ...adaptRuntimeTools(createModelTools(privateModelManager)),
      capix_mvp_architect: capixMvpArchitect,
      capix_mvp_deploy: capixMvpDeploy,
      capix_full_solution: capixFullSolution,
    },

    // ── Auth: browser code+PKCE bridged to the credential broker ─────────
    auth: {
      provider: 'capix',
      methods: [
        {
          type: 'oauth',
          label: 'Sign in with Capix',
          async authorize() {
            // Check if already authenticated via CAPIX_API_KEY (set by launcher)
            // or if the broker has a valid refresh token
            const existingKey = process.env.CAPIX_API_KEY?.trim();
            if (existingKey) {
              try {
                const access = await broker.getAccessToken();
                if (access?.token) {
                  return {
                    type: 'success' as const,
                    provider: 'capix',
                    refresh: '',
                    access: access.token,
                    expires: access.expiresAt.getTime(),
                  };
                }
              } catch {
                // Token might be expired, fall through to login
              }
            }
            await broker.login();
            const url = await broker.authorizationUrl();
            return {
              url,
              instructions: 'Complete sign-in in your browser, then return here.',
              method: 'auto',
              async callback() {
                const result = await broker.exchangeCode();
                if (result.type === 'success') {
                  await reconnectMcpAfterAuth(broker);
                  return result;
                }
                return { type: 'failed' as const };
              },
            };
          },
        },
        {
          type: 'api',
          label: 'Use a project API key',
          async authorize(inputs: Record<string, unknown> | undefined) {
            const key = (inputs?.['apiKey'] as string) ?? '';
            if (!key) return { type: 'failed' as const };
            const result = await broker.registerApiKey(key);
            if (result.type === 'success') {
              await reconnectMcpAfterAuth(broker);
            }
            return result;
          },
        },
      ],
      loader: capixAuthLoader,
    } as AuthHook,

    // ── Tool hardening: close broker capabilities + root through sandbox ─
    'tool.execute.before': async (toolInput: ToolExecuteInput, output: ToolExecuteOutput) => {
      // Mode enforcement (ask/plan/build/debug/review) from the shared agent
      // runtime: deny-decisions are hard failures; ask-decisions fall through
      // to the sandbox / permission.ask flow below.
      const modeCheck = checkModePermission(
        agentMode,
        toolInput.tool,
        engineToolRiskClass(toolInput.tool)
      );
      if (modeCheck.decision === 'deny') {
        throw new Error('capix: ' + modeCheck.reason);
      }

      // For bash/task tools, validate the command against the sandbox.
      if (toolInput.tool === 'bash' || toolInput.tool === 'task') {
        if (output.args && typeof output.args === 'object') {
          const args = output.args as {
            command?: string;
            cwd?: string;
            env?: Record<string, string>;
          };

          // Covenant gate for /deploy and /cleanup. These are infrastructure-
          // side-effect commands; before any sandbox pass we consult the
          // active Project Covenant and hard-deny if `infra:deploy` or
          // `infra:destroy` is denied for this session. On `ask` we leave the
          // decision to the existing permission.ask flow below; on fetch
          // failure we fail closed (see checkInfraCovenant).
          if (args.command) {
            for (const { pattern, action } of INFRA_COMMAND_PATTERNS) {
              if (pattern.test(args.command)) {
                const decision = await checkInfraCovenant(action);
                if (decision === 'deny') {
                  throw new Error(
                    'capix: ' +
                      action +
                      ' denied by Project Covenant (use /covenant to inspect rules)'
                  );
                }
                break;
              }
            }
          }

          const allowed = sandbox.shouldApproveCommand({
            executable: 'bash',
            args: args.command ? ['-c', args.command] : [],
            cwd: args.cwd ?? process.cwd(),
            envDelta: args.env ?? {},
            network: false,
          });
          if (!allowed) {
            throw new Error(
              'capix: command rejected by workspace sandbox (profile: ' + sandbox.profile + ')'
            );
          }
        }
      }
      // Validate first, then close inherited broker descriptors immediately
      // before the engine launches the tool. Closing first permanently denied
      // the command being evaluated.
      sandbox.closeToolCapabilities();
    },

    // ── Intelligence context injection (single integration point) ────────
    // This is the ONLY place intelligence context is wired into the chat
    // engine. We fetch the active plan, recent decisions, and active
    // covenant rules and place them under
    // `output.options.capixIntelligenceContext`. The runtime's system-prompt
    // builder is expected to read from there and append a structured
    // "Capix Intelligence Context" block to the system prompt sent to the
    // model. Failures are non-blocking — see fetchIntelligenceContext.
    //
    // Note: this hook does NOT perform client-side classification, provider
    // scoring, or base-URL rewriting. Server-authoritative routing for
    // `capix/auto` remains unchanged (the `capix.route` SSE event still
    // resolves the model).
    'experimental.chat.system.transform': async (
      _systemInput: SystemTransformInput,
      systemOutput: SystemTransformOutput
    ) => {
      // This is the engine-supported prompt bridge. `chat.params.options`
      // contains provider-specific request options and is not a system-prompt
      // channel; placing Capix context there silently discarded it.
      systemOutput.system.push(await buildTurnSystemContext());
    },

    // Keep the stable hook surface for provider parameter customization. All
    // semantic context belongs in the system-transform hook above.
    'chat.params': async (_chatInput: ChatParamsInput, _chatOutput: ChatParamsOutput) => {},

    // ── Chat message: capture the user task transcript ────────────────────
    // This hook does NOT classify, route, or rewrite the message. It only
    // records the user-authored text so the system transform can drive skills
    // auto-select and loss-aware compaction. Server-authoritative routing
    // for `capix/auto` is unchanged (resolved via the `capix.route` SSE
    // event).
    'chat.message': async (_msgInput: ChatMessageInput, msgOutput: ChatMessageOutput) => {
      try {
        const text = extractUserText(msgOutput.parts);
        if (text) {
          latestTask = text;
          transcript.push({ role: 'user', content: text });
        }
      } catch {
        // non-blocking
      }
    },

    // ── Shell environment scrub: never leak Capix/cloud/wallet/SSH secrets
    'shell.env': async (_shellInput: unknown, shellOutput: ShellEnvOutput) => {
      if (shellOutput.env) {
        shellOutput.env = sandbox.scrubEnvironment(shellOutput.env);
      }
    },

    // ── Permission: enforce sandbox profile on file/network actions ──────
    'permission.ask': async (perm: Permission, out: PermissionResult) => {
      const action = 'action' in perm ? (perm as { action: string }).action : '';
      if (isAutonomousMode()) {
        // Autonomous runs have no operator: every engine-level permission is
        // decided here, mirroring the agent-runtime sandbox policy. Denials
        // are typed skips — the engine records them in the transcript.
        const autoPolicy = createAutoApprovalPolicy();
        if (action === 'webfetch' || action === 'websearch') {
          out.status = 'deny';
          return;
        }
        if (action === 'bash' || action === 'task') {
          const command =
            'command' in perm ? String((perm as { command?: unknown }).command ?? '') : '';
          const verdict = autoPolicy('bash', { command });
          out.status = verdict === true || (typeof verdict === 'object' && verdict.approved)
            ? 'allow'
            : 'deny';
          return;
        }
        if (action === 'edit' || action === 'write' || action === 'patch') {
          const patterns =
            'patterns' in perm ? (perm as { patterns?: string[] }).patterns : undefined;
          out.status = patterns?.some((p) => sandbox.isSecretPath(p)) ? 'deny' : 'allow';
          return;
        }
        if (action === 'read') {
          const patterns =
            'patterns' in perm ? (perm as { patterns?: string[] }).patterns : undefined;
          out.status = patterns?.some((p) => sandbox.isSecretPath(p)) ? 'deny' : 'allow';
          return;
        }
        // Anything else (billing verbs, unknown actions) is skipped, never
        // approved silently and never left waiting on a human.
        out.status = 'deny';
        return;
      }
      if (sandbox.profile === 'restricted') {
        // Restricted default: deny network, ask for edits, deny secret paths.
        if (action === 'webfetch' || action === 'websearch') {
          out.status = 'deny';
          return;
        }
        if (action === 'read') {
          const patterns =
            'patterns' in perm ? (perm as { patterns?: string[] }).patterns : undefined;
          if (patterns?.some((p) => sandbox.isSecretPath(p))) {
            out.status = 'deny';
            return;
          }
        }
      }
      // Leave the engine's default ask/allow decision otherwise.
      if (out.status === undefined) {
        out.status = 'ask';
      }
    },

    // ── Dispose: revoke the session-only broker on plugin unload ────────
    dispose: async () => {
      codebaseIndexer.stopWatch();
      if (runtimeInstance) {
        runtimeInstance.close();
        runtimeInstance = null;
      }
      brokerInstance = null;
      sandboxInstance = null;
      intelligenceWired = false;
    },

    // ── Server-authoritative routing note ───────────────────────────────
    // There is deliberately NO `chat.headers` hook that performs client-side
    // classification, provider scoring, or base URL rewriting. Model selection
    // for `capix/auto` is resolved by the server and returned in the
    // `capix.route` SSE event.
    //
    // The `chat.message` hook above ONLY records the user-authored text to
    // drive skills auto-select and loss-aware compaction in `chat.params` —
    // it does not classify or route.
    //
    // The `chat.params` hook is the single intelligence integration point
    // with the chat engine — it injects the active plan, recent decisions,
    // covenant rules, codebase context, selected skill, and (when needed)
    // compacted session as structured context, NOT as a routing signal.
  };

  // The `capix/auto` model target is resolved server-authoritatively via the
  // `capix.route` SSE event — no separate provider hook is needed.
  void broker;
  void meta;

  return hooks;
};

export default plugin;

// Re-export the provider and supporting classes for direct consumers, tests,
// and the bundled runtime adapter.
export { capixProvider, CredentialBroker, WorkspaceSandbox };
export * as routing from './routing-client.js';
export { Architect, Deployer, Trainer } from './planner/index.js';
export { sessionStatus, renderStatusLine } from './tui/index.js';
export {
  orchestrationPanel,
  renderOrchestrationPanel,
  renderOrchestrationLine,
  intelligenceContext,
  intelligencePanel,
  renderIntelligencePanel,
  DelegationManager,
} from './tui/index.js';
export { getMcpSupervisor };
