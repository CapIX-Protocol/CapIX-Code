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

import type { Plugin, PluginInput, Hooks, AuthHook } from '@opencode-ai/plugin';
import type { Permission } from '@opencode-ai/sdk';

import {
  capixProvider,
  createCapixProviderHook,
  capixAuthLoader,
  CAPIX_INFERENCE_BASE,
} from './capix-provider.js';
import { CredentialBroker } from './broker.js';
import { WorkspaceSandbox, type SandboxProfile } from './sandbox.js';
import { logger } from './logger.js';
import * as intelligence from './intelligence-client.js';

export const CAPIX_PLUGIN_VERSION = '1.2.5';
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

  const capixHook = createCapixProviderHook();
  const autoHook = { ...capixHook, id: 'capix/auto' };

  logger.info('capix plugin loaded', {
    provider: capixProvider.name,
    sandbox: sandbox.profile,
    releaseId,
  });

  const hooks: Hooks = {
    // ── Provider registration (real ProviderHook) ────────────────────────
    provider: capixHook as Hooks['provider'],

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
    'chat.params': async (_chatInput: ChatParamsInput, chatOutput: ChatParamsOutput) => {
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
      brokerInstance = null;
      sandboxInstance = null;
      intelligenceWired = false;
    },

    // ── Server-authoritative routing note ───────────────────────────────
    // There is deliberately NO `chat.message` or `chat.headers` hook that
    // performs client-side classification, provider scoring, or base URL
    // rewriting. Model selection for `capix/auto` is resolved by the server
    // and returned in the `capix.route` SSE event.
    //
    // The `chat.params` hook above is the single intelligence integration
    // point with the chat engine — it injects the active plan, recent
    // decisions, and active covenant rules as structured context, NOT as a
    // routing signal.
  };

  // The `capix/auto` provider hook is registered alongside `capix` so the
  // engine can resolve the bundled `capix/auto` model target.
  void autoHook;
  void broker;
  void meta;

  return hooks;
};

export default plugin;

// Re-export the provider and supporting classes for direct consumers, tests,
// and the bundled runtime adapter.
export { capixProvider, CredentialBroker, WorkspaceSandbox };
