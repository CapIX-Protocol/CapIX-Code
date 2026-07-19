import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import { setBrokerAccessor as setProviderBroker } from '../src/capix-provider.js';
import { setBrokerAccessor as setRoutingBroker } from '../src/routing-client.js';
import {
  CompletionEngine,
  buildCompletionContext,
  buildCompletionMessages,
  detectLanguage,
  pickCompletionModel,
  postProcessCompletion,
  type CompletionContext,
} from '../src/completion/completion-engine.js';
import { InlineCompletionSession } from '../src/completion/inline-completion.js';

const accessBroker = {
  getAccessToken: vi
    .fn()
    .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
  refreshToken: vi.fn(),
} as unknown as CredentialBroker;

setProviderBroker(() => accessBroker);
setRoutingBroker(() => accessBroker);

const META = {
  client: 'capix-code' as const,
  clientVersion: 'test',
  pluginVersion: 'test',
  releaseId: 'test',
  acpVersion: '1',
};

const CATALOG = {
  models: [
    {
      modelId: 'cheap-chat',
      name: 'Cheap Chat',
      visibility: 'public',
      capabilities: ['chat'],
      pricePerInputToken: { amountMinor: '100', currency: 'USD', scale: 6 },
      pricePerOutputToken: { amountMinor: '200', currency: 'USD', scale: 6 },
      regions: ['global'],
    },
    {
      modelId: 'cheap-coder',
      name: 'Cheap Coder',
      visibility: 'public',
      capabilities: ['code', 'chat'],
      pricePerInputToken: { amountMinor: '50', currency: 'USD', scale: 6 },
      pricePerOutputToken: { amountMinor: '90', currency: 'USD', scale: 6 },
      regions: ['global'],
    },
    {
      modelId: 'private-coder',
      name: 'Private Coder',
      visibility: 'private',
      capabilities: ['code'],
      pricePerInputToken: { amountMinor: '1', currency: 'USD', scale: 6 },
      pricePerOutputToken: { amountMinor: '1', currency: 'USD', scale: 6 },
      regions: ['global'],
    },
  ],
};

function sseResponse(events: object[]): Response {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function completionStream(text: string): Response {
  return sseResponse([
    {
      type: 'capix.route',
      receiptId: 'r1',
      modelCapability: 'cheap-coder',
      region: 'global',
      privacyClass: 'standard',
    },
    { type: 'content.delta', content: text },
    { type: 'capix.usage', inputUnits: 10, outputUnits: 5 },
    { type: 'capix.final', finishReason: 'stop', receiptId: 'r1' },
  ]);
}

/** Fetch stub: catalog on /models, streamed completion on the inference route. */
function stubCapixFetch(completionText: string, opts: { failCatalog?: boolean } = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/models')) {
      if (opts.failCatalog) return Promise.resolve(new Response('boom', { status: 500 }));
      return Promise.resolve(
        new Response(JSON.stringify(CATALOG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    return Promise.resolve(completionStream(completionText));
  });
}

function makeContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    filePath: 'src/app.ts',
    language: 'typescript',
    prefix: 'function add(a: number, b: number) {\n  ',
    suffix: '\n}',
    cursorLine: 2,
    cursorColumn: 2,
    projectSnippets: [],
    recentEdits: [],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('context building', () => {
  it('detects languages from file extensions', () => {
    expect(detectLanguage('src/app.ts')).toBe('typescript');
    expect(detectLanguage('pkg/main.go')).toBe('go');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('no-extension')).toBe('text');
  });

  it('splits content at the cursor and tracks line/column', () => {
    const content = 'line one\nline two\nline three';
    const offset = content.indexOf('two') + 3;
    const ctx = buildCompletionContext({ filePath: 'a.ts', content, cursorOffset: offset });
    expect(ctx.prefix.endsWith('line two')).toBe(true);
    expect(ctx.suffix.startsWith('\nline three')).toBe(true);
    expect(ctx.cursorLine).toBe(2);
    expect(ctx.cursorColumn).toBe('line two'.length);
  });

  it('bounds prefix and suffix to the configured window', () => {
    const ctx = buildCompletionContext(
      {
        filePath: 'a.ts',
        content: `${'p'.repeat(5000)}CUR${'s'.repeat(5000)}`,
        cursorOffset: 5000,
      },
      { prefixChars: 100, suffixChars: 50 }
    );
    expect(ctx.prefix).toHaveLength(100);
    expect(ctx.suffix).toHaveLength(50);
  });

  it('clamps an out-of-range cursor offset', () => {
    const ctx = buildCompletionContext({ filePath: 'a.ts', content: 'abc', cursorOffset: 99 });
    expect(ctx.prefix).toBe('abc');
    expect(ctx.suffix).toBe('');
  });

  it('includes recent edits, related files, and the cursor marker in the prompt', () => {
    const messages = buildCompletionMessages(
      makeContext({
        projectSnippets: [{ path: 'src/util.ts', content: 'export const x = 1;' }],
        recentEdits: [{ path: 'src/app.ts', summary: 'renamed sum to add' }],
      })
    );
    expect(messages[0]?.role).toBe('system');
    const user = messages[1]?.content ?? '';
    expect(user).toContain('<recent-edit path="src/app.ts">');
    expect(user).toContain('<related-file path="src/util.ts">');
    expect(user).toContain('<CURSOR>');
    expect(user).toContain('language="typescript"');
  });
});

describe('post-processing', () => {
  it('strips a markdown fence wrapper', () => {
    expect(postProcessCompletion('```ts\nreturn a + b;\n```', makeContext(), 12)).toBe(
      'return a + b;'
    );
  });

  it('drops an echoed prefix tail', () => {
    const ctx = makeContext({ prefix: 'const total = computeTot' });
    expect(postProcessCompletion('computeTotal(items);', ctx, 12)).toBe('al(items);');
  });

  it('bounds multi-line completions and trims trailing blanks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n\n\n';
    const result = postProcessCompletion(text, makeContext(), 5);
    expect(result?.split('\n')).toHaveLength(5);
    expect(result?.endsWith('line 4')).toBe(true);
  });

  it('rejects empty or whitespace-only output', () => {
    expect(postProcessCompletion('   \n\n', makeContext(), 12)).toBeNull();
  });
});

describe('smart-router model selection', () => {
  it('prefers the cheapest public code-capable catalog model', () => {
    expect(pickCompletionModel(CATALOG.models as never)).toBe('cheap-coder');
  });

  it('falls back to any public model when none is code-capable', () => {
    const catalog = CATALOG.models.filter((m) => m.modelId !== 'cheap-coder');
    expect(pickCompletionModel(catalog as never)).toBe('cheap-chat');
  });

  it('returns null when the catalog has no public models', () => {
    expect(
      pickCompletionModel(CATALOG.models.filter((m) => m.visibility === 'private') as never)
    ).toBeNull();
  });
});

describe('completion engine', () => {
  it('completes through the smart router with a catalog-selected model', async () => {
    const fetchMock = stubCapixFetch('return a + b;');
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META });

    const result = await engine.complete(makeContext());

    expect(result).toMatchObject({ text: 'return a + b;', model: 'cheap-coder', fromCache: false });
    const inferenceCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/inference/chat/completions')
    );
    expect(inferenceCall).toBeDefined();
    const body = JSON.parse(inferenceCall?.[1]?.body as string);
    expect(body.model).toBe('cheap-coder');
    expect(body.stream).toBe(true);
    expect(body.messages[1].content).toContain('<CURSOR>');
  });

  it('falls back to capix/auto when the catalog is unavailable', async () => {
    const fetchMock = stubCapixFetch('return a + b;', { failCatalog: true });
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META });

    const result = await engine.complete(makeContext());

    expect(result?.model).toBe('capix/auto');
    const inferenceCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/inference/chat/completions')
    );
    const body = JSON.parse(inferenceCall?.[1]?.body as string);
    expect(body.model).toBe('capix/auto');
  });

  it('serves repeat contexts from cache without another inference request', async () => {
    const fetchMock = stubCapixFetch('return a + b;');
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META });
    const ctx = makeContext();

    const first = await engine.complete(ctx);
    const second = await engine.complete(ctx);

    expect(first?.fromCache).toBe(false);
    expect(second).toMatchObject({ text: 'return a + b;', fromCache: true });
    const inferenceCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/inference/chat/completions')
    );
    expect(inferenceCalls).toHaveLength(1);
  });

  it('debounces: only the last scheduled call hits the network', async () => {
    const fetchMock = stubCapixFetch('return a + b;');
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META, debounceMs: 10 });

    const stale = engine.schedule(makeContext({ prefix: 'const a = ' }));
    const fresh = engine.schedule(makeContext({ prefix: 'const ab = ' }));
    const [staleResult, freshResult] = await Promise.all([stale, fresh]);

    expect(staleResult).toBeNull();
    expect(freshResult?.text).toBe('return a + b;');
    const inferenceCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/inference/chat/completions')
    );
    expect(inferenceCalls).toHaveLength(1);
  });

  it('cancelPending resolves a scheduled call with null', async () => {
    const fetchMock = stubCapixFetch('return a + b;');
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META, debounceMs: 50 });

    const pending = engine.schedule(makeContext());
    engine.cancelPending();

    await expect(pending).resolves.toBeNull();
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/inference/chat/completions'))
    ).toHaveLength(0);
  });

  it('returns null when the model emits nothing usable', async () => {
    const fetchMock = stubCapixFetch('   \n\n');
    vi.stubGlobal('fetch', fetchMock);
    const engine = new CompletionEngine({ meta: META });

    await expect(engine.complete(makeContext())).resolves.toBeNull();
  });
});

describe('inline completion session', () => {
  function makeSession(completionText: string, debounceMs = 5) {
    const fetchMock = stubCapixFetch(completionText);
    vi.stubGlobal('fetch', fetchMock);
    const session = new InlineCompletionSession({ meta: META, debounceMs });
    return { session, fetchMock };
  }

  const snapshot = (content: string, cursorOffset = content.length) => ({
    filePath: 'src/app.ts',
    content,
    cursorOffset,
  });

  it('shows a suggestion after a debounced update', async () => {
    const { session } = makeSession('return a + b;');
    const states: string[] = [];
    session.onDidChange((state) => states.push(state));

    await session.update(snapshot('function add(a, b) {\n  '));

    expect(session.getState()).toBe('showing');
    expect(session.getCurrent()?.text).toBe('return a + b;');
    expect(states).toEqual(['pending', 'showing']);
  });

  it('exposes multi-line ghost text (inline first line, rest below)', async () => {
    const { session } = makeSession('const x = 1;\nconst y = 2;\nreturn x + y;');
    await session.update(snapshot(''));

    const ghost = session.getGhostText();
    expect(ghost?.inline).toBe('const x = 1;');
    expect(ghost?.below).toEqual(['const y = 2;', 'return x + y;']);
  });

  it('Tab accepts the whole suggestion and clears it', async () => {
    const { session } = makeSession('return a + b;');
    await session.update(snapshot('  '));

    expect(session.handleKey('tab')).toBe('accepted');
    expect(session.getState()).toBe('idle');
    expect(session.getCurrent()).toBeNull();
    expect(session.handleKey('tab')).toBe('ignored');
  });

  it('Escape rejects the suggestion and records the rejection', async () => {
    const { session } = makeSession('return a + b;');
    await session.update(snapshot('  '));

    expect(session.handleKey('escape')).toBe('rejected');
    expect(session.getState()).toBe('idle');
    expect(session.handleKey('escape')).toBe('ignored');
  });

  it('accept-line keeps the rest of a multi-line suggestion pending', async () => {
    const { session } = makeSession('const x = 1;\nreturn x;');
    await session.update(snapshot(''));

    const accepted = session.acceptLine();
    expect(accepted?.inserted).toBe('const x = 1;\n');
    expect(session.getState()).toBe('showing');
    expect(session.getCurrent()?.text).toBe('return x;');
  });

  it('accept-word accepts one word at a time', async () => {
    const { session } = makeSession('return total;');
    await session.update(snapshot('  '));

    const accepted = session.acceptWord();
    expect(accepted?.inserted).toBe('return');
    expect(session.getCurrent()?.text).toBe(' total;');
  });

  it('rejects while pending cancels the request', async () => {
    const { session, fetchMock } = makeSession('return a + b;', 50);
    const updatePromise = session.update(snapshot('  '));
    session.reject();
    await updatePromise;

    expect(session.getState()).toBe('idle');
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/inference/chat/completions'))
    ).toHaveLength(0);
  });

  it('a newer update supersedes an older one', async () => {
    const { session } = makeSession('return a + b;', 5);
    await Promise.all([
      session.update(snapshot('const a = ')),
      session.update(snapshot('const ab = ')),
    ]);

    expect(session.getState()).toBe('showing');
    expect(session.getCurrent()?.text).toBe('return a + b;');
  });
});
