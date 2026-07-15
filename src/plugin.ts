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

import { tool, type Plugin, type PluginInput, type Hooks, type AuthHook } from '@opencode-ai/plugin';
import type { Permission } from '@opencode-ai/sdk';
import { join, sep, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import {
  capixProvider,
  createCapixProviderHook,
  capixAuthLoader,
  CAPIX_INFERENCE_BASE,
  stream as capixStream,
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
  type ModelInvoker,
  type SubagentConfig,
  type SubagentResult,
  type EngineCommandResolver,
  type PlanStep,
  type Plan,
} from './planner/index.js';
import { SkillsRuntime, BUILTIN_SKILLS } from './skills/index.js';

export const CAPIX_PLUGIN_VERSION = '1.2.7';
export const CAPIX_ACP_VERSION = '1';

/** Settings the launcher may pass via plugin options. */
export interface CapixPluginOptions {
  releaseId?: string;
  clientVersion?: string;
  sandbox?: SandboxProfile;
  workspaceRoot?: string;
  apiBaseUrl?: string;
  inferenceBaseUrl?: string;
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

let brokerInstance: CredentialBroker | null = null;
let sandboxInstance: WorkspaceSandbox | null = null;
let intelligenceWired = false;

function getBroker(): CredentialBroker {
  if (!brokerInstance) {
    brokerInstance = new CredentialBroker();
  }
  return brokerInstance;
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
    let text = '';
    for await (const chunk of capixStream(
      {
        model: process.env.CAPIX_PLANNER_MODEL ?? 'capix/auto',
        messages: [{ role: 'user', content: prompt }],
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
    lines.push(
      `STEP ${s.id}: ${s.description} [${s.status}] (~${s.estimatedTurns} turns${dep})`
    );
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
  'index.ts', 'index.tsx', 'index.js', 'index.jsx',
  'main.ts', 'main.js', 'server.ts', 'server.js', 'app.ts', 'app.tsx',
]);
const ENTRY_RELS = new Set([
  'app/layout.tsx', 'src/index.ts', 'src/main.ts',
  'pages/index.tsx', 'pages/index.ts',
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

  // Register the broker accessor and inference base resolver so the provider
  // module talks ONLY to the broker, never to a stored token.
  const { setBrokerAccessor, setInferenceBaseResolver } = await import('./capix-provider.js');
  setBrokerAccessor(() => broker);
  setInferenceBaseResolver(() => opts.inferenceBaseUrl ?? CAPIX_INFERENCE_BASE);

  // Wire the intelligence-client (chat.params context injection + the
  // /deploy + /cleanup covenant gate) to the same broker. This is the single
  // intelligence integration point with the chat engine.
  wireIntelligence(broker, opts, {
    releaseId,
    clientVersion,
    pluginVersion: CAPIX_PLUGIN_VERSION,
  });

  // ── Codebase indexer + retriever (agent brain: local codebase context) ──
  // The indexer parses the project into a symbol + import graph (regex-based,
  // Node built-ins only) and keeps it fresh via a debounced fs.watch. The
  // `chat.params` hook below injects retrieved context into each turn; the
  // `capix_*` tools let the model search the codebase on demand. Indexing
  // runs in the background and is non-blocking: the hooks degrade gracefully
  // (empty orientation) until the first index is ready.
  const indexerRoot = opts.workspaceRoot ?? input.directory ?? process.cwd();
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

  // ── Planner / SubagentManager / ContextCompactor / SkillsRuntime ──────
  // The planner decomposes a request into checkpointable steps; subagents run
  // steps in isolated git worktrees; the compactor summarizes long sessions;
  // the skills runtime selects first-party skills per message. The planner
  // reuses the codebase-index ContextRetriever (structurally compatible — it
  // exposes getOrientation() and findRelevantFiles() with the same shape).
  const modelInvoker = createModelInvoker(meta);
  const planner = new Planner(contextRetriever, modelInvoker, indexerRoot);
  const enginePath = process.env.CAPIX_CODE_ENGINE
    || join('/Users/ruiqbal/Desktop/capix-code/dist/customer/engine', 'capix-engine');
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
  }

  // Rolling transcript for loss-aware compaction + latest task for skill
  // auto-select. Populated by the `chat.message` hook; consumed by
  // `chat.params`. Persisted across turns within this plugin instance.
  const transcript: Array<{ role: string; content: string }> = [];
  let latestTask = '';
  const COMPACT_THRESHOLD_TOKENS = 6000;

  const z = tool.schema;

  const capixSearchCodebase = tool({
    description:
      'Search the workspace codebase for files and symbols relevant to a ' +
      'natural-language query, symbol name, or path fragment. Returns matching ' +
      'files ranked by relevance with reasons.',
    args: {
      query: z
        .string()
        .describe('Natural-language query, symbol name, or path fragment'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of files to return (default 10)'),
    },
    async execute(args) {
      const results = await contextRetriever.findRelevantFiles(
        args.query,
        args.limit ?? 10
      );
      if (results.length === 0) {
        return {
          title: `capix_search_codebase: ${args.query}`,
          output: 'No matching files found in the codebase index.',
        };
      }
      const lines = results.map(
        (r) => `${r.score.toFixed(2)}  ${r.path}  — ${r.reason}`
      );
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
      symbol: z
        .string()
        .describe('Exact symbol name (function, class, variable, etc.)'),
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
    async execute(args) {
      const plan = await planner.plan(args.request);
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
      const config: SubagentConfig = {
        role: 'implementation-agent',
        planStep,
        model: args.model ?? 'capix/auto',
        maxTurns: args.maxTurns ?? 8,
        maxElapsedMs: args.maxElapsedMs ?? 120_000,
        maxSpendUsdMinor: BigInt(args.maxSpendUsdMinor ?? '500'),
        worktreePath: join(worktreeRoot, '.capix', 'worktrees', stepId),
        parentSessionId: context.sessionID,
        allowedTools: ['read_file', 'edit_file', 'bash'],
        filesystemScope: worktreeRoot,
        approvalRules: 'ask-parent',
      };
      const result = await subagentManager.spawn(config);
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

  const capixHook = createCapixProviderHook();

  logger.info('capix plugin loaded', {
    provider: capixProvider.name,
    sandbox: sandbox.profile,
    releaseId,
  });

  const hooks: Hooks = {
    // ── Provider registration (real ProviderHook) ────────────────────────
    provider: capixHook as Hooks['provider'],

    // ── Config: zero-config Capix MCP registration ───────────────────────
    // The OpenCode config is user-owned, so instead of writing to the file we
    // inject the Capix MCP server programmatically here. The env is filled at
    // runtime with the broker access token (never persisted to the config
    // file); if the broker isn't logged in yet the env stays empty and is
    // rehydrated on the next session once auth completes. Non-throwing so a
    // broker miss can never block config resolution.
    config: async (input) => {
      try {
        if (!input.mcp) input.mcp = {};
        const servers = input.mcp as Record<string, unknown>;
        if (!servers.capix) {
          let apiKey = '';
          try {
            apiKey = (await broker.getAccessToken()).token;
          } catch {
            // Not logged in yet — env stays empty; the broker refreshes on
            // demand once auth completes.
          }
          servers.capix = {
            type: 'local',
            command: ['npx', '-y', '@capix/mcp', 'server', '--stdio'],
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
    },

    // ── Auth: browser code+PKCE bridged to the credential broker ─────────
    auth: {
      provider: 'capix',
      methods: [
        {
          type: 'oauth',
          label: 'Sign in with Capix',
          async authorize() {
            await broker.login();
            const url = await broker.authorizationUrl();
            return {
              url,
              instructions: 'Complete sign-in in your browser, then return here.',
              method: 'auto',
              async callback() {
                const result = await broker.exchangeCode();
                if (result.type === 'success') {
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
            return result;
          },
        },
      ],
      loader: capixAuthLoader,
    } as AuthHook,

    // ── Tool hardening: close broker capabilities + root through sandbox ─
    'tool.execute.before': async (toolInput: ToolExecuteInput, output: ToolExecuteOutput) => {
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
    'chat.params': async (chatInput: ChatParamsInput, chatOutput: ChatParamsOutput) => {
      try {
        const ctx = await fetchIntelligenceContext(undefined);
        chatOutput.options = {
          ...(chatOutput.options ?? {}),
          capixIntelligenceContext: ctx,
        };
      } catch (err) {
        // Never break the chat turn because intelligence context fetch
        // failed — log and continue with no injection.
        logger.warn('capix plugin: chat.params intelligence injection failed', {
          error: (err as Error)?.message,
        });
      }

      // Inject locally-retrieved codebase context (files + symbols most
      // relevant to this turn's user message). Non-blocking: if the index
      // isn't ready yet or retrieval fails, we fall back to a compact project
      // orientation or nothing. This is the bridge between the local
      // CodebaseIndexer/ContextRetriever and the chat system prompt.
      try {
        const requestText = chatInput.message?.summary?.body ?? '';
        let codebaseContext: unknown;
        if (requestText.trim()) {
          const retrieved = await contextRetriever.retrieve(requestText, {
            maxTokens: 2000,
          });
          if (retrieved.files.length > 0) {
            codebaseContext = {
              type: 'retrieval',
              files: retrieved.files.map((f) => ({
                path: f.path,
                reason: f.reason,
                score: f.score,
                lines: f.lines,
              })),
              symbols: retrieved.symbols,
              sources: retrieved.sources,
              totalTokens: retrieved.totalTokens,
            };
          } else {
            codebaseContext = {
              type: 'orientation',
              summary: await contextRetriever.getOrientation(),
            };
          }
        } else {
          codebaseContext = {
            type: 'orientation',
            summary: await contextRetriever.getOrientation(),
          };
        }
        chatOutput.options = {
          ...(chatOutput.options ?? {}),
          capixCodebaseContext: codebaseContext,
        };
      } catch (err) {
        logger.warn('capix plugin: chat.params codebase context injection failed', {
          error: (err as Error)?.message,
        });
      }

      // Skills auto-select: pick a first-party skill whose trigger matches
      // the latest user task and inject its system-prompt fragment. Non-
      // blocking — if no skill matches, nothing is injected.
      try {
        const task = latestTask;
        if (task) {
          const sel = skillsRt.autoSelect(task);
          if (sel) {
            chatOutput.options = {
              ...(chatOutput.options ?? {}),
              capixSkill: {
                id: sel.skill.id,
                systemPrompt: sel.skill.systemPrompt,
                reason: sel.reason,
              },
            };
          }
        }
      } catch (err) {
        logger.warn('capix plugin: chat.params skills auto-select failed', {
          error: (err as Error)?.message,
        });
      }

      // Loss-aware compaction: when the rolling transcript exceeds the token
      // budget, compact it into a structured summary (decisions, files,
      // errors, preferences) and replace the transcript with the summary. The
      // compacted payload is also surfaced via `capixCompaction` so the
      // runtime's system-prompt builder can append it as context. Non-blocking.
      try {
        const chars = transcript.reduce((n, m) => n + m.content.length, 0);
        if (Math.ceil(chars / 4) > COMPACT_THRESHOLD_TOKENS) {
          const compacted = await compactor.compact(transcript);
          transcript.length = 0;
          transcript.push({ role: 'system', content: compacted.summary });
          chatOutput.options = {
            ...(chatOutput.options ?? {}),
            capixCompaction: compacted,
          };
        }
      } catch (err) {
        logger.warn('capix plugin: chat.params compaction failed', {
          error: (err as Error)?.message,
        });
      }
    },

    // ── Chat message: capture the user task transcript ────────────────────
    // This hook does NOT classify, route, or rewrite the message. It only
    // records the user-authored text so `chat.params` can drive skills
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
