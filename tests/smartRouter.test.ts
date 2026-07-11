import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs before importing SmartRouter
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock logger to keep test output clean
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SmartRouter } from '../src/smartRouter';
import * as fs from 'node:fs';
import { logger } from '../src/logger';

// ── Helpers ───────────────────────────────────────────────────────────────

interface LiveModelLike {
  id: string;
  model: string;
  pricePer1k: number;
  provider: string;
}

function makeModel(id: string, pricePer1k = 0.001, provider = 'test-provider'): LiveModelLike {
  return { id, model: id, pricePer1k, provider };
}

function mockFetchResponse(data: unknown) {
  return { json: async () => data } as unknown as Response;
}

function mockCatalogResponse(
  models: Array<{ model: string; provider: string; spotPrice: number; status: string }>
) {
  return mockFetchResponse({ listings: models });
}

function mockClassifyResponse(content: string) {
  return mockFetchResponse({
    choices: [{ message: { content } }],
  });
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SmartRouter — Construction & Memory', () => {
  it('should construct with blank memory when no memory file exists', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new SmartRouter();
    const mem = router.getMemoryState();
    expect(mem.ratings).toEqual({});
    expect(mem.blockedModels).toEqual([]);
    expect(mem.favoredModels).toEqual([]);
  });

  it('should load memory from disk when file exists', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        ratings: {
          'model-a': {
            reasoning: { score: 0, selections: 3, overrides: 1 },
            coding: { score: 0, selections: 0, overrides: 0 },
          },
        },
        blockedModels: ['bad-model'],
        favoredModels: ['good-model'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );

    const router = new SmartRouter();
    const mem = router.getMemoryState();
    expect(mem.blockedModels).toContain('bad-model');
    expect(mem.favoredModels).toContain('good-model');
    expect(mem.ratings['model-a'].reasoning.selections).toBe(3);
  });

  it('should fall back to blank memory on read error', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('read error');
    });

    const router = new SmartRouter();
    const mem = router.getMemoryState();
    expect(mem.ratings).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(
      'loadMemory failed — using blank memory',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('should fall back to blank memory on JSON parse error', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json');

    const router = new SmartRouter();
    expect(router.getMemoryState().ratings).toEqual({});
  });

  it('should call saveMemory (writeFileSync) when modifying state', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new SmartRouter();
    router.blockModel('test-block');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('test-block'),
      'utf-8'
    );
  });

  it('should log error when saveMemory fails', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('write error');
    });

    const router = new SmartRouter();
    router.blockModel('test-block');

    expect(logger.error).toHaveBeenCalledWith(
      'saveMemory failed — cannot persist router memory',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('SmartRouter — pickBestModel (catalog scoring)', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
  });

  it('should return fallback when catalog is empty (reasoning)', () => {
    expect(router.pickBestModel([], 'reasoning')).toBe('capix/supergemma-gemma3-27b');
  });

  it('should return fallback when catalog is empty (coding)', () => {
    expect(router.pickBestModel([], 'coding')).toBe('capix/supergemma-gemma3-4b');
  });

  it('should score models higher with keyword matches', () => {
    const models = [makeModel('qwen2.5-coder-7b'), makeModel('unknown-model')];
    const best = router.pickBestModel(models, 'coding');
    expect(best).toBe('qwen2.5-coder-7b');
  });

  it('should score reasoning keywords correctly', () => {
    const models = [makeModel('claude-sonnet-4'), makeModel('some-random-model')];
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('claude-sonnet-4');
  });

  it('should penalize expensive models', () => {
    const models = [makeModel('cheap-model', 0.001), makeModel('expensive-model', 0.1)];
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('cheap-model');
  });

  it('should apply double price penalty for very expensive models', () => {
    const models = [
      makeModel('model-a', 0.02), // -1 penalty
      makeModel('model-b', 0.1), // -3 penalty (not a real factor, just testing sorting)
    ];
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('model-a');
  });

  it('should return fallback when all models are blocked', () => {
    const models = [makeModel('claude-sonnet'), makeModel('llama-3')];
    router.blockModel('claude-sonnet');
    router.blockModel('llama-3');
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('capix/supergemma-gemma3-27b');
  });

  it('should skip blocked models in favor of non-blocked', () => {
    const models = [makeModel('claude-sonnet'), makeModel('some-model')];
    router.blockModel('claude-sonnet');
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('some-model');
  });

  it('should boost favored models', () => {
    const models = [makeModel('some-model'), makeModel('favor-me')];
    router.favorModel('favor-me');
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('favor-me');
  });

  it('should boost models from preferred provider', () => {
    const models = [
      makeModel('model-a', 0.001, 'provider-a'),
      makeModel('model-b', 0.001, 'provider-b'),
    ];
    router.setPreferredProvider('provider-b');
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('model-b');
  });

  it('should prefer cheaper model when scores are tied', () => {
    const models = [makeModel('model-x', 0.005), makeModel('model-y', 0.001)];
    const best = router.pickBestModel(models, 'reasoning');
    expect(best).toBe('model-y');
  });
});

describe('SmartRouter — Learning (memory updates)', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
  });

  it('should record override: penalize rejected, boost chosen', () => {
    router.recordOverride('rejected-model', 'chosen-model', 'coding');

    const mem = router.getMemoryState();
    expect(mem.ratings['rejected-model'].coding.overrides).toBe(1);
    expect(mem.ratings['chosen-model'].coding.selections).toBe(1);
  });

  // C4: Tests the deprecated client-side SmartRouter that will be removed.
  it.skip('should record override multiple times correctly', () => {
    router.recordOverride('m1', 'm2', 'reasoning');
    router.recordOverride('m1', 'm2', 'reasoning');
    router.recordOverride('m1', 'm3', 'reasoning');

    const mem = router.getMemoryState();
    expect(mem.ratings['m1'].reasoning.overrides).toBe(2);
    expect(mem.ratings['m2'].reasoning.selections).toBe(2);
    expect(mem.ratings['m3'].reasoning.selections).toBe(1);
  });

  it('should affect scoring after recording overrides', () => {
    router.recordOverride('model-a', 'model-b', 'coding');

    const models = [makeModel('model-a'), makeModel('model-b')];
    // model-a has 1 override (penalty), model-b has 1 selection (boost)
    // Neither matches coding keywords
    // model-a: netScore = 0 - 1*2 = -2, score = -2 * 0.5 = -1
    // model-b: netScore = 1 - 0*2 = 1, score = 1 * 0.5 = 0.5
    const best = router.pickBestModel(models, 'coding');
    expect(best).toBe('model-b');
  });

  it('should not duplicate blocked models', () => {
    router.blockModel('m1');
    router.blockModel('m1');
    expect(router.getMemoryState().blockedModels).toEqual(['m1']);
  });

  it('should not duplicate favored models', () => {
    router.favorModel('m1');
    router.favorModel('m1');
    expect(router.getMemoryState().favoredModels).toEqual(['m1']);
  });

  it('should reset all memory', () => {
    router.blockModel('m1');
    router.favorModel('m2');
    router.recordOverride('m3', 'm4', 'coding');
    router.resetMemory();

    const mem = router.getMemoryState();
    expect(mem.ratings).toEqual({});
    expect(mem.blockedModels).toEqual([]);
    expect(mem.favoredModels).toEqual([]);
    expect(router.hasPrivateEndpoint()).toBe(false);
  });
});

describe('SmartRouter — Private endpoint lifecycle', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
  });

  it('should register a private endpoint', () => {
    router.setPrivateEndpoint({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      instanceId: 42,
      modelLabel: 'capix/private-model',
    });

    expect(router.hasPrivateEndpoint()).toBe(true);
    const ep = router.getPrivateEndpoint();
    expect(ep?.modelLabel).toBe('capix/private-model');
    expect(ep?.baseUrl).toBe('http://localhost:1234/v1');
  });

  it('should route to private endpoint after registration', () => {
    router.setPrivateEndpoint({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      instanceId: 42,
      modelLabel: 'capix/private-model',
    });

    const result = router.routePrivate();
    expect(result.mode).toBe('private');
    expect(result.model).toBe('capix/private-model');
    expect(result.privateEndpoint).toBeDefined();
    expect(result.privateEndpoint?.baseUrl).toBe('http://localhost:1234/v1');
  });

  it('should signal NEEDS_DEPLOY when no private endpoint', () => {
    const result = router.routePrivate();
    expect(result.mode).toBe('private');
    expect(result.model).toBe('__NEEDS_DEPLOY__');
    expect(result.fromCache).toBe(false);
  });

  it('should clear private endpoint', () => {
    router.setPrivateEndpoint({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      instanceId: 42,
      modelLabel: 'capix/private-model',
    });
    router.clearPrivateEndpoint();

    expect(router.hasPrivateEndpoint()).toBe(false);
    expect(router.getMemoryState().lastPrivateEndpoint).toBeUndefined();
  });
});

describe('SmartRouter — routeLoop', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
  });

  it('should return mode loop with NEEDS_DEPLOY when no endpoint', () => {
    const result = router.routeLoop();
    expect(result.mode).toBe('loop');
    expect(result.model).toBe('__NEEDS_DEPLOY__');
  });

  it('should return mode loop with private endpoint when registered', () => {
    router.setPrivateEndpoint({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      instanceId: 42,
      modelLabel: 'capix/loop-model',
    });
    const result = router.routeLoop();
    expect(result.mode).toBe('loop');
    expect(result.model).toBe('capix/loop-model');
    expect(result.privateEndpoint).toBeDefined();
  });
});

describe('SmartRouter — routeAuto (classification + catalog)', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
  });

  it('should classify as reasoning and route to reasoning model', async () => {
    const catalog = [
      { model: 'claude-sonnet', provider: 'openrouter', spotPrice: 0.01, status: 'live' },
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) {
        return Promise.resolve(mockCatalogResponse(catalog));
      }
      if (url.includes('chat/completions')) {
        return Promise.resolve(mockClassifyResponse('reasoning'));
      }
      return Promise.resolve(mockFetchResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await router.routeAuto(
      'Explain how quicksort works',
      'session-1',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(result.mode).toBe('auto');
    expect(result.taskType).toBe('reasoning');
    expect(result.model).toBe('claude-sonnet');
  });

  it('should classify as coding and route to coding model', async () => {
    const catalog = [
      { model: 'claude-sonnet', provider: 'openrouter', spotPrice: 0.01, status: 'live' },
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) {
        return Promise.resolve(mockCatalogResponse(catalog));
      }
      if (url.includes('chat/completions')) {
        return Promise.resolve(mockClassifyResponse('coding'));
      }
      return Promise.resolve(mockFetchResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await router.routeAuto(
      'Write a sort function',
      'session-2',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(result.taskType).toBe('coding');
    expect(result.model).toBe('qwen2.5-coder-7b');
  });

  it('should default to coding on classify failure', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) {
        return Promise.resolve(mockCatalogResponse(catalog));
      }
      if (url.includes('chat/completions')) {
        return Promise.reject(new Error('network timeout'));
      }
      return Promise.resolve(mockFetchResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await router.routeAuto(
      'Explain something',
      'session-3',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(result.taskType).toBe('coding');
    expect(result.model).toBe('qwen2.5-coder-7b');
    expect(logger.warn).toHaveBeenCalledWith(
      'classify failed — defaulting to coding',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  // C4: Tests the deprecated client-side SmartRouter that will be removed.
  it.skip('should fall back to cached models on catalog fetch failure', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];

    let firstCall = true;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) {
        if (firstCall) {
          firstCall = false;
          return Promise.resolve(mockCatalogResponse(catalog));
        }
        return Promise.reject(new Error('network down'));
      }
      if (url.includes('chat/completions')) {
        return Promise.resolve(mockClassifyResponse('coding'));
      }
      return Promise.resolve(mockFetchResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First call — fetches and caches catalog
    await router.routeAuto('Write code', 'session-4', 'https://capix.network/api/v1', 'test-key');
    // Second call — catalog fetch fails but should use cache
    const result = await router.routeAuto(
      'Write more code',
      'session-5',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(result.model).toBe('qwen2.5-coder-7b');
    expect(logger.error).toHaveBeenCalledWith(
      'fetchCatalog failed — using cached/empty fallback',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('should use fallback model when catalog is empty and fetch fails', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string) => {
      return Promise.reject(new Error('network error'));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await router.routeAuto(
      'Write code',
      'session-6',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(result.model).toBe('capix/supergemma-gemma3-4b');
    expect(result.taskType).toBe('coding');
  });

  it('should cache classification per session', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions'))
        return Promise.resolve(mockClassifyResponse('reasoning'));
      return Promise.resolve(mockFetchResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First call — should classify
    await router.routeAuto(
      'Explain architecture',
      'session-7',
      'https://capix.network/api/v1',
      'test-key'
    );

    // Count classify calls so far
    const classifyCallsAfter1st = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('chat/completions')
    ).length;

    // Second call with same session — should use cache, not re-classify
    await router.routeAuto('Explain more', 'session-7', 'https://capix.network/api/v1', 'test-key');

    const classifyCallsAfter2nd = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('chat/completions')
    ).length;

    expect(classifyCallsAfter2nd).toBe(classifyCallsAfter1st);
  });
});

describe('SmartRouter — Memory summary', () => {
  it('should produce a readable summary string', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new SmartRouter();
    router.blockModel('bad-model');
    router.favorModel('good-model');
    router.recordOverride('rejected', 'chosen', 'coding');

    const summary = router.getMemorySummary();
    expect(summary).toContain('Smart Router Memory:');
    expect(summary).toContain('bad-model');
    expect(summary).toContain('good-model');
    expect(summary).toContain('rejected');
    expect(summary).toContain('chosen');
  });

  it('should show none when memory is empty', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new SmartRouter();
    const summary = router.getMemorySummary();
    expect(summary).toContain('Blocked: none');
    expect(summary).toContain('Favored: none');
    expect(summary).toContain('Preferred provider: none');
  });
});

describe('SmartRouter — Structured logging (W5-T1)', () => {
  let router: SmartRouter;

  beforeEach(() => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    router = new SmartRouter();
    vi.clearAllMocks();
  });

  it('should log route decisions in auto mode', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    await router.routeAuto('Write code', 'session-log', 'https://capix.network/api/v1', 'test-key');

    expect(logger.info).toHaveBeenCalledWith(
      'Route decision',
      expect.objectContaining({
        mode: 'auto',
        model: 'qwen2.5-coder-7b',
        taskType: 'coding',
        durationMs: expect.any(Number),
      })
    );
  });

  it('should log catalog fetch with source, count, duration', async () => {
    const catalog = [
      { model: 'model-a', provider: 'p1', spotPrice: 0.001, status: 'live' },
      { model: 'model-b', provider: 'p2', spotPrice: 0.002, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions')) return Promise.resolve(mockClassifyResponse('coding'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    await router.routeAuto('Write code', 'session-log2', 'https://test.example/v1', 'test-key');

    expect(logger.info).toHaveBeenCalledWith(
      'Catalog fetched',
      expect.objectContaining({
        source: expect.stringContaining('test.example'),
        count: 2,
        durationMs: expect.any(Number),
      })
    );
  });

  it('should log classification with task type and prompt', async () => {
    const catalog = [
      { model: 'qwen2.5-coder-7b', provider: 'capix', spotPrice: 0.001, status: 'live' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('trading-board')) return Promise.resolve(mockCatalogResponse(catalog));
      if (url.includes('chat/completions'))
        return Promise.resolve(mockClassifyResponse('reasoning'));
      return Promise.resolve(mockFetchResponse({}));
    }) as unknown as typeof fetch;

    await router.routeAuto(
      'Explain distributed systems',
      'session-log3',
      'https://capix.network/api/v1',
      'test-key'
    );

    expect(logger.info).toHaveBeenCalledWith(
      'Task classified',
      expect.objectContaining({
        taskType: 'reasoning',
        promptPreview: expect.any(String),
        durationMs: expect.any(Number),
      })
    );
  });

  it('should log route decisions in private mode', () => {
    router.routePrivate();
    expect(logger.info).toHaveBeenCalledWith(
      'Route decision',
      expect.objectContaining({ mode: 'private', model: '__NEEDS_DEPLOY__' })
    );
  });

  it('should log route decisions in loop mode', () => {
    router.routeLoop();
    expect(logger.info).toHaveBeenCalledWith(
      'Route decision',
      expect.objectContaining({ mode: 'loop' })
    );
  });
});
