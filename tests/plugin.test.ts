import { describe, it, expect, vi } from 'vitest';
import type { PluginInput, Hooks } from '@opencode-ai/plugin';

// Mock logger to keep test output clean.
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock CredentialBroker — instantiated at plugin load, must not touch the network.
vi.mock('../src/broker', () => ({
  CredentialBroker: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue(undefined),
    authorizationUrl: vi.fn().mockResolvedValue('https://api.capix.network/v1/auth/authorize'),
    exchangeCode: vi.fn().mockResolvedValue({ type: 'success' as const }),
    registerApiKey: vi.fn().mockResolvedValue({ type: 'success' as const, key: 'cpk_test' }),
  })),
}));

// Mock WorkspaceSandbox — instantiated at plugin load, must not touch the fs.
const mockShouldApproveCommand = vi.fn().mockReturnValue(true);
const mockScrubEnvironment = vi.fn().mockImplementation((env: Record<string, string>) => env);
const mockIsSecretPath = vi.fn().mockReturnValue(false);
const mockCloseToolCapabilities = vi.fn();

vi.mock('../src/sandbox', () => ({
  WorkspaceSandbox: vi.fn().mockImplementation(() => ({
    profile: 'restricted' as const,
    shouldApproveCommand: mockShouldApproveCommand,
    scrubEnvironment: mockScrubEnvironment,
    isSecretPath: mockIsSecretPath,
    closeToolCapabilities: mockCloseToolCapabilities,
  })),
}));

// Mock capix-provider — both statically and dynamically imported by plugin.ts.
const mockProviderHook = { id: 'capix', models: vi.fn() };
vi.mock('../src/capix-provider', () => ({
  CapixHttpError: class CapixHttpError extends Error {},
  capixProvider: { name: 'capix' },
  createCapixProviderHook: vi.fn(() => mockProviderHook),
  capixAuthLoader: vi.fn(),
  CAPIX_INFERENCE_BASE: 'https://inference.capix.network',
  CAPIX_API_BASE: 'https://api.capix.network',
  setBrokerAccessor: vi.fn(),
  setInferenceBaseResolver: vi.fn(),
}));

import { plugin, CAPIX_PLUGIN_VERSION, CAPIX_ACP_VERSION } from '../src/plugin';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getHooks(options?: Record<string, unknown>): Promise<Hooks> {
  return plugin({} as unknown as PluginInput, options);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Plugin constants', () => {
  it('CAPIX_PLUGIN_VERSION is "1.2.6"', () => {
    expect(CAPIX_PLUGIN_VERSION).toBe('1.2.6');
  });

  it('CAPIX_ACP_VERSION is "1"', () => {
    expect(CAPIX_ACP_VERSION).toBe('1');
  });
});

describe('Plugin factory — Hooks structure', () => {
  it('returns a Hooks object with all expected hook keys', async () => {
    const hooks = await getHooks();

    expect(hooks).toBeDefined();
    expect(hooks.provider).toBeDefined();
    expect(hooks.auth).toBeDefined();
    expect(hooks['tool.execute.before']).toBeDefined();
    expect(typeof hooks['tool.execute.before']).toBe('function');
    expect(hooks['shell.env']).toBeDefined();
    expect(typeof hooks['shell.env']).toBe('function');
    expect(hooks['permission.ask']).toBeDefined();
    expect(typeof hooks['permission.ask']).toBe('function');
    expect(hooks.dispose).toBeDefined();
    expect(typeof hooks.dispose).toBe('function');
  });

  it('registers only the intelligence context chat.params hook', async () => {
    const hooks = await getHooks();
    expect(hooks['chat.message']).toBeUndefined();
    expect(typeof hooks['chat.params']).toBe('function');
    expect(hooks['chat.headers']).toBeUndefined();
  });
});

describe('Plugin factory — Provider hook', () => {
  it('provider hook has id "capix"', async () => {
    const hooks = await getHooks();
    expect(hooks.provider).toBeDefined();
    expect(hooks.provider?.id).toBe('capix');
  });

  it('provider hook has a models function', async () => {
    const hooks = await getHooks();
    expect(typeof hooks.provider?.models).toBe('function');
  });
});

describe('Plugin factory — Auth hook', () => {
  it('auth hook has provider "capix"', async () => {
    const hooks = await getHooks();
    expect(hooks.auth).toBeDefined();
    expect(hooks.auth?.provider).toBe('capix');
  });

  it('auth hook has exactly two methods: oauth and api', async () => {
    const hooks = await getHooks();
    const methods = hooks.auth?.methods ?? [];
    expect(methods).toHaveLength(2);
    const types = methods.map((m) => m.type);
    expect(types).toContain('oauth');
    expect(types).toContain('api');
  });

  it('oauth method has label "Sign in with Capix"', async () => {
    const hooks = await getHooks();
    const oauth = hooks.auth?.methods?.find((m) => m.type === 'oauth');
    expect(oauth).toBeDefined();
    expect(oauth?.label).toBe('Sign in with Capix');
  });

  it('api method has label "Use a project API key"', async () => {
    const hooks = await getHooks();
    const api = hooks.auth?.methods?.find((m) => m.type === 'api');
    expect(api).toBeDefined();
    expect(api?.label).toBe('Use a project API key');
  });

  it('auth hook has a loader function', async () => {
    const hooks = await getHooks();
    expect(typeof hooks.auth?.loader).toBe('function');
  });
});

describe('Plugin factory — tool.execute.before hook', () => {
  it('closes tool capabilities when invoked', async () => {
    const hooks = await getHooks();
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      { args: { command: 'ls', cwd: '/tmp', env: {} } }
    );
    expect(mockCloseToolCapabilities).toHaveBeenCalled();
  });

  it('rejects bash commands not approved by the sandbox', async () => {
    mockShouldApproveCommand.mockReturnValueOnce(false);
    const hooks = await getHooks();
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' },
        { args: { command: 'rm -rf /', cwd: '/tmp', env: {} } }
      )
    ).rejects.toThrow('rejected by workspace sandbox');
  });
});

describe('Plugin factory — shell.env hook', () => {
  it('scrubs the environment through the sandbox', async () => {
    const hooks = await getHooks();
    const env = { PATH: '/bin', CAPIX_TOKEN: 'secret' };
    await hooks['shell.env']!({ cwd: '/tmp' }, { env });
    expect(mockScrubEnvironment).toHaveBeenCalledWith(env);
  });
});

describe('Plugin factory — dispose hook', () => {
  it('completes without error', async () => {
    const hooks = await getHooks();
    await expect(hooks.dispose!()).resolves.toBeUndefined();
  });
});
