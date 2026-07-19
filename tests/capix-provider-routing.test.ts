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
    const fetchMock = vi.fn().mockResolvedValue(
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
      'https://www.capix.network/api/v1/inference/chat/completions'
    );
    expect(chunks).toContainEqual({ type: 'text', delta: 'hello' });
  });

  it('surfaces RFC 7807 detail instead of collapsing errors to HTTP status text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'https://www.capix.network/problems/inference-unavailable',
            title: 'Inference unavailable',
            detail: 'No live route is currently available for this model.',
            status: 503,
            code: 'NO_LIVE_ROUTE',
            supportId: 'support-test',
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'content-type': 'application/problem+json' },
          }
        )
      )
    );

    const consume = async () => {
      for await (const _chunk of stream(
        { model: 'capix/auto', messages: [{ role: 'user', content: 'hello' }] },
        {
          meta: {
            client: 'capix-code',
            clientVersion: '2.2.5',
            releaseId: 'test',
            pluginVersion: '2.2.5',
            acpVersion: '1',
          },
        }
      )) {
        // The request must fail before yielding customer-visible output.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      status: 503,
      capixCode: 'NO_LIVE_ROUTE',
      message: 'No live route is currently available for this model.',
      supportId: 'support-test',
      retryClass: 'retry',
    });
  });

  it('surfaces traceId and honors the server retry classification on problem details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'https://capix.network/errors/capacity',
            title: 'Capacity unavailable',
            detail: 'No candidate passed the hard filter.',
            status: 503,
            capixCode: 'CAPIX_CAPACITY_UNAVAILABLE',
            traceId: '01J4ZA1C4XJ2M3N4P5Q6R7S8T9',
            retryClass: 'retry-after',
            retryAfterSeconds: 30,
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          }
        )
      )
    );

    const consume = async () => {
      for await (const _chunk of stream(
        { model: 'capix/auto', messages: [{ role: 'user', content: 'hello' }] },
        {
          meta: {
            client: 'capix-code',
            clientVersion: '2.2.5',
            releaseId: 'test',
            pluginVersion: '2.2.5',
            acpVersion: '1',
          },
        }
      )) {
        // The request must fail before yielding customer-visible output.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      status: 503,
      capixCode: 'CAPIX_CAPACITY_UNAVAILABLE',
      message: 'No candidate passed the hard filter.',
      supportId: '01J4ZA1C4XJ2M3N4P5Q6R7S8T9',
      retryClass: 'retry-after',
      retryAfterMs: 30_000,
    });
  });
});
