import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBrokerAccessor, stream } from '../src/capix-provider.js';
import type { CredentialBroker } from '../src/broker.js';
import { SessionStatusStore, renderStatusLine } from '../src/tui/index.js';

const accessBroker = {
  getAccessToken: vi
    .fn()
    .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
  refreshToken: vi.fn(),
} as unknown as CredentialBroker;

setBrokerAccessor(() => accessBroker);

afterEach(() => vi.unstubAllGlobals());

const META = {
  meta: {
    client: 'capix-code' as const,
    clientVersion: '2.2.5',
    releaseId: 'test',
    pluginVersion: '2.2.5',
    acpVersion: '1',
  },
};

describe('P0 token/cost display — SSE usage capture', () => {
  it('captures real token counts and provisional cost from capix.usage events', async () => {
    const sse = [
      'data: {"type":"capix.route","receiptId":"rcpt_1","modelCapability":"auto","region":"us","privacyClass":"standard"}',
      '',
      'data: {"type":"content.delta","content":"hello"}',
      '',
      'data: {"type":"capix.usage","inputUnits":1200,"outputUnits":340,"cacheUnits":0,"provisionalCost":{"amount":"129900","asset":"USD","scale":2}}',
      '',
      'data: {"type":"capix.final","finishReason":"stop","finalUsage":{"inputUnits":1200,"outputUnits":340,"provisionalCost":{"amount":"129900","asset":"USD","scale":2}},"receiptId":"rcpt_1"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        )
    );

    const chunks = [];
    for await (const chunk of stream(
      { model: 'capix/auto', messages: [{ role: 'user', content: 'hello' }] },
      META
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'usage',
      input: 1200,
      output: 340,
      cacheRead: 0,
      cost: { amount: '129900', asset: 'USD', scale: 2 },
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'finish', finishReason: 'stop', receiptId: 'rcpt_1' })
    );
  });

  it('yields a usage event without cost when the gateway omits provisionalCost', async () => {
    const sse =
      'data: {"type":"capix.usage","inputUnits":10,"outputUnits":4}\n\n' + 'data: [DONE]\n\n';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        )
    );

    const chunks = [];
    for await (const chunk of stream(
      { model: 'capix/auto', messages: [{ role: 'user', content: 'hi' }] },
      META
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'usage',
      input: 10,
      output: 4,
      cacheRead: undefined,
      cost: undefined,
    });
  });
});

describe('P0 token/cost display — session status store', () => {
  it('accumulates real tokens and integer-minor-unit spend across usage events', () => {
    const store = new SessionStatusStore();

    store.recordUsage(1200, 340, { amount: '129900', asset: 'USD', scale: 2 });
    store.recordUsage(80, 12, { amount: '100', asset: 'USD', scale: 2 });

    const status = store.snapshot();
    expect(status.tokens).toEqual({ input: 1280, output: 352 });
    // Integer minor units only — no float arithmetic anywhere in the chain.
    expect(status.spend).toEqual({ amountMinor: '130000', currency: 'USD', scale: 2 });
  });

  it('usage without cost still moves the token counters', () => {
    const store = new SessionStatusStore();
    store.recordUsage(10, 4);

    const status = store.snapshot();
    expect(status.tokens).toEqual({ input: 10, output: 4 });
    expect(status.spend.amountMinor).toBe('0');
  });

  it('status line shows real tokens, cost, and MCP state after inference', () => {
    const store = new SessionStatusStore();
    store.setMcpHealth({
      state: 'connected',
      toolCount: 59,
      lastCheckedAt: new Date().toISOString(),
      restartCount: 0,
    });
    store.recordUsage(1200, 340, { amount: '129900', asset: 'USD', scale: 2 });

    const line = renderStatusLine(store.snapshot());
    expect(line).toContain('mcp connected (59 tools)');
    expect(line).toContain('1200 in / 340 out tokens');
    expect(line).toContain('USD 1299.00 spent');
  });

  it('status line omits the token segment before any usage is recorded', () => {
    const store = new SessionStatusStore();
    const line = renderStatusLine(store.snapshot());
    expect(line).not.toContain('tokens');
    expect(line).toContain('USD 0.00 spent');
  });
});
