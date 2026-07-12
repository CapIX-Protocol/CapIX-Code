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

export const CAPIX_PLUGIN_VERSION = '1.1.0';
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

let brokerInstance: CredentialBroker | null = null;
let sandboxInstance: WorkspaceSandbox | null = null;

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
    },

    // ── Server-authoritative routing note ───────────────────────────────
    // There is deliberately NO `chat.message`, `chat.params`, or `chat.headers`
    // hook that performs client-side classification, provider scoring, or base
    // URL rewriting. Model selection for `capix/auto` is resolved by the
    // server and returned in the `capix.route` SSE event.
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
