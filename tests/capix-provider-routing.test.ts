import { afterEach, describe, expect, it, vi } from 'vitest';
import { models, setBrokerAccessor, stream } from '../src/capix-provider.js';
import type { CredentialBroker } from '../src/broker.js';

const accessBroker = {
  getAccessToken: vi
    .fn()
    .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
  refreshToken: vi.fn(),
} as unknown as CredentialBroker;

setBrokerAccessor(() => accessBroker);

afterEach(() => vi.unstubAllGlobals());

describe('canonical Capix routing', () => {
  it('discovers and maps the production model catalogue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              id: 'capix/auto',
              label: 'Capix Auto',
              contextWindow: 128000,
              maxModelLen: 64000,
              pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 6 },
              capabilities: ['chat', 'streaming', 'tool-calls', 'vision', 'extended-thinking'],
              available: true,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalogue = await models();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.capix.network/api/v1/models',
      expect.any(Object)
    );
    expect(catalogue.auto).toMatchObject({ id: 'capix/auto', name: 'Capix Auto' });
    expect(catalogue.auto.capabilities).toMatchObject({
      toolcall: true,
      reasoning: true,
      attachment: true,
    });
  });

  it('streams through the canonical remote inference endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('data: {"type":"content.delta","content":"hello"}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const chunks = [];
    for await (const chunk of stream(
      { model: 'capix/auto', messages: [{ role: 'user', content: 'hello' }] },
      {
        meta: {
          client: 'capix-code',
          clientVersion: '1.2.2',
          releaseId: 'test',
          pluginVersion: '1.2.2',
          acpVersion: '1',
        },
      }
    ))
      chunks.push(chunk);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://www.capix.network/api/v1/chat/completions'
    );
    expect(chunks).toContainEqual({ type: 'text', delta: 'hello' });
  });
});
