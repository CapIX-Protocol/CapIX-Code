import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs before importing the plugin (which imports SmartRouter)
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock logger
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { capixSmartRoute, getSmartRouter } from '../src/plugin';
import * as fs from 'node:fs';

// ── Helpers ───────────────────────────────────────────────────────────────

function mockFetchResponse(data: unknown) {
  return { json: async () => data } as unknown as Response;
}

function mockCatalogResponse(
  models: Array<{ model: string; provider: string; spotPrice: number; status: string }>
) {
  return mockFetchResponse({ listings: models });
}

function mockClassifyResponse(content: string) {
  return mockFetchResponse({ choices: [{ message: { content } }] });
}

interface MockMessage {
  messages?: Array<{ role: string; content: string }>;
  model?: string;
  [key: string]: unknown;
}

interface MockContext {
  sessionId?: string;
  model?: string;
}

function makeMessage(content: string): MockMessage {
  return { messages: [{ role: 'user', content }] };
}

function makeContext(model = 'capix/auto'): MockContext {
  return { sessionId: 'test-session', model };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

  // Reset router memory state
  getSmartRouter().resetMemory();

  // Clear env
  delete process.env.CAPIX_ROUTE_MODE;
  delete process.env.CAPIX_BASE_URL;
  delete process.env.CAPIX_API_KEY;
  process.env.CAPIX_API_KEY = 'test-api-key';
  process.env.CAPIX_BASE_URL = 'https://capix.network/api/v1';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// C4: This entire test file exercises the deprecated `capixSmartRoute` /
// `getSmartRouter` API that was an invented client-side router. The plugin
// (src/plugin.ts) has been rewritten to use the real @opencode-ai/plugin
// contract and no longer exports `capixSmartRoute` or `getSmartRouter`.
// These tests are skipped until they are rewritten against the new contract
// or removed entirely as part of the C4 workstream (server-authoritative
// routing replaces client-side classification/scoring).

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skip('Plugin — Lifecycle', () => {
  it('should export a capixSmartRoute plugin object', () => {
    expect(capixSmartRoute).toBeDefined();
    expect(capixSmartRoute.name).toBe('capix-smart-route');
    expect(typeof capixSmartRoute.onMessage).toBe('function');
    expect(typeof capixSmartRoute.info).toBe('function');
  });

  it('should return info with mode, memory, and hasPrivateEndpoint', () => {
    const info = capixSmartRoute.info!();
    expect(info.mode).toBe('auto');
    expect(typeof info.memory).toBe('string');
    expect(info.memory).toContain('Smart Router Memory:');
    expect(info.hasPrivateEndpoint).toBe(false);
  });

  it('should reflect private mode in info when env is set', () => {
    process.env.CAPIX_ROUTE_MODE = 'private';
    const info = capixSmartRoute.info!();
    expect(info.mode).toBe('private');
  });

  it('should reflect loop mode in info when env is set', () => {
    process.env.CAPIX_ROUTE_MODE = 'loop';
    const info = capixSmartRoute.info!();
    expect(info.mode).toBe('loop');
  });
});

describe.skip('Plugin — Route interception (auto mode)', () => {
  it('should return default model when no API key is set', async () => {
    delete process.env.CAPIX_API_KEY;
    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext() as any);
    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });

  it('should pass through when model is not capix/auto', async () => {
    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('custom-model') as any);
    expect(result).toBe(msg);
    expect(result.model).toBeUndefined();
  });

  it('should pass through when model is not auto (bare)', async () => {
    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(
      msg as any,
      makeContext('openai/gpt-4o') as any
    );
    expect(result).toBe(msg);
  });

  it('should intercept when model is capix/auto', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write a binary search');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result.model).toBe('qwen2.5-coder-7b');
  });

  it('should intercept when model is bare auto', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('auto') as any);
    expect(result.model).toBe('qwen2.5-coder-7b');
  });

  it('should return default model when no user message exists', async () => {
    const msg: MockMessage = { messages: [] };
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);
    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });

  it('should return default model when user message content is not a string', async () => {
    const msg: MockMessage = {
      messages: [{ role: 'user', content: 12345 as unknown as string }],
    };
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);
    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });

  it('should return default model when messages is undefined', async () => {
    const msg: MockMessage = {};
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);
    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });
});

describe.skip('Plugin — Private mode', () => {
  it('should signal deploy when no private endpoint exists', async () => {
    process.env.CAPIX_ROUTE_MODE = 'private';

    // routeAuto fallback needs fetch
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write code');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result._capixDeployPrivate).toBe(true);
    expect(result.model).toBe('qwen2.5-coder-7b');
  });

  it('should route to private endpoint when one is registered', async () => {
    process.env.CAPIX_ROUTE_MODE = 'private';
    getSmartRouter().setPrivateEndpoint({
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'endpoint-key',
      instanceId: 77,
      modelLabel: 'capix/private-llm',
    });

    const msg = makeMessage('Write code');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result.model).toBe('capix/private-llm');
    expect(result._capixPrivateEndpoint).toEqual({
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'endpoint-key',
    });
    expect(result._capixDeployPrivate).toBeUndefined();
  });
});

describe.skip('Plugin — Loop mode', () => {
  it('should signal deploy in loop mode when no endpoint', async () => {
    process.env.CAPIX_ROUTE_MODE = 'loop';

    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write code');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result._capixDeployPrivate).toBe(true);
  });

  it('should route to private endpoint in loop mode', async () => {
    process.env.CAPIX_ROUTE_MODE = 'loop';
    getSmartRouter().setPrivateEndpoint({
      baseUrl: 'http://localhost:8888/v1',
      apiKey: 'loop-key',
      instanceId: 88,
      modelLabel: 'capix/loop-llm',
    });

    const msg = makeMessage('Write code');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result.model).toBe('capix/loop-llm');
    expect(result._capixPrivateEndpoint).toEqual({
      baseUrl: 'http://localhost:8888/v1',
      apiKey: 'loop-key',
    });
  });
});

describe.skip('Plugin — Error propagation', () => {
  it('should gracefully handle fetch failures and return fallback model', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    let failedOnce = false;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) {
        return Promise.resolve(mockCatalogResponse(catalog));
      }
      if (url.includes('chat/completions')) {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error('classify timeout'));
        }
        return Promise.resolve(mockClassifyResponse('coding'));
      }
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    // classify failed, should default to coding and still return a routed model
    expect(result.model).toBeDefined();
    expect(result.model).toBe('qwen2.5-coder-7b');
  });

  it('should handle total fetch failure and return fallback', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new Error('total network failure'));
    }) as unknown as typeof fetch;

    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    // All fetches fail — should still get a fallback model
    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });

  it('should not throw when API key is missing (graceful degradation)', async () => {
    delete process.env.CAPIX_API_KEY;
    const msg = makeMessage('Write a function');
    const result = await capixSmartRoute.onMessage!(msg as any, makeContext('capix/auto') as any);

    expect(result.model).toBe('capix/supergemma-gemma3-4b');
  });
});
