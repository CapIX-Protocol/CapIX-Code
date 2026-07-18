/**
 * Inference E2E (inference-e2e P0): login → inference → streamed response → receipt.
 *
 * Drives the REAL CredentialBroker and the REAL capix-provider stream against a
 * hermetic stub of the Capix control plane that implements the exact production
 * wire contract:
 *
 *   POST /oauth/token                        (refresh_token grant with rotation)
 *   POST /api/v1/auth/api-key/verify         (project API-key sign-in)
 *   GET  /api/v1/models                      (catalog discovery)
 *   POST /api/v1/inference/chat/completions  (SSE: route → delta → usage → final)
 *
 * Any request outside that contract is answered 404 and recorded — the
 * "Not Found" regression guard: if the client ever calls a path the control
 * plane does not serve (the original P0), these tests fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CredentialBroker } from '../src/broker.js';
import {
  models,
  setBrokerAccessor,
  stream,
  type CapixClientMeta,
  type CapixProviderChunk,
} from '../src/capix-provider.js';

const META: CapixClientMeta = {
  client: 'capix-code',
  clientVersion: '2.2.5',
  releaseId: 'e2e-test',
  pluginVersion: '2.2.5',
  acpVersion: '1',
};

const API_KEY = `cpxk_${'a'.repeat(48)}`;
const API_KEY_DIGEST = createHash('sha256').update(API_KEY).digest('base64url');
const EXPIRED_SESSION = 'cpxs_expired_session';
const FRESH_SESSION = 'cpxs_fresh_session';
const SEED_REFRESH = 'cpxsr_seed_refresh';
const ROTATED_REFRESH = 'cpxsr_rotated_refresh';
const RECEIPT_ID = 'rr_e2e_1';

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: string;
}

/** Build the SSE payload the canonical inference route emits. */
function sseBody(): string {
  const frames = [
    {
      type: 'capix.route',
      receiptId: RECEIPT_ID,
      modelCapability: 'capix/auto',
      region: 'authenticated-gateway',
      privacyClass: 'standard',
    },
    { type: 'content.delta', content: 'Hello', role: 'assistant' },
    { type: 'content.delta', content: ' world', role: 'assistant' },
    {
      type: 'capix.usage',
      inputUnits: 12,
      outputUnits: 7,
      provisionalCost: { amount: '150', asset: 'USD-credit', scale: 6 },
    },
    {
      type: 'capix.final',
      finishReason: 'stop',
      receiptId: RECEIPT_ID,
      finalUsage: {
        inputUnits: 12,
        outputUnits: 7,
        provisionalCost: { amount: '150', asset: 'USD-credit', scale: 6 },
      },
      retryCount: 0,
      fallbackCount: 0,
    },
  ];
  return frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
}

function problem(status: number, capixCode: string, title: string): Response {
  return new Response(JSON.stringify({ status, capixCode, title }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/** Hermetic control plane. 404s every path outside the production contract. */
function installControlPlane(): { requests: RecordedRequest[]; notFound: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const notFound: RecordedRequest[] = [];

  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    const recorded: RecordedRequest = {
      url,
      method,
      authorization: headers.get('authorization'),
      idempotencyKey: headers.get('idempotency-key'),
      body,
    };
    requests.push(recorded);

    const { pathname } = new URL(url);
    if (url.startsWith('https://www.capix.network/')) {
      if (pathname === '/oauth/token' && method === 'POST') {
        const form = new URLSearchParams(body);
        if (
          form.get('grant_type') === 'refresh_token' &&
          form.get('refresh_token') === SEED_REFRESH &&
          form.get('client_id') === 'capix-code'
        ) {
          return Response.json({
            access_token: FRESH_SESSION,
            refresh_token: ROTATED_REFRESH,
            token_type: 'Bearer',
            expires_in: 900,
            account_id: 'acct_e2e',
            project_id: 'prj_e2e',
          });
        }
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }

      if (pathname === '/api/v1/auth/api-key/verify' && method === 'POST') {
        const payload = JSON.parse(body) as { key_digest?: string };
        if (payload.key_digest === API_KEY_DIGEST) {
          return Response.json({ ok: true, key_id: 'key_e2e', project_id: 'prj_e2e', scopes: [] });
        }
        return problem(401, 'invalid_api_key', 'API key verification failed');
      }

      const bearer = recorded.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const authenticated = bearer === API_KEY || bearer === FRESH_SESSION;

      if (pathname === '/api/v1/models' && method === 'GET') {
        if (!authenticated) return problem(401, 'unauthorized', 'Authentication required');
        return Response.json({
          models: [
            {
              id: 'capix/auto',
              label: 'Capix Auto',
              contextWindow: 128000,
              maxModelLen: 64000,
              pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 6 },
              capabilities: ['chat', 'streaming', 'tool-calls'],
              available: true,
            },
          ],
        });
      }

      if (pathname === '/api/v1/inference/chat/completions' && method === 'POST') {
        if (bearer === EXPIRED_SESSION) return problem(401, 'unauthorized', 'Session expired');
        if (!authenticated) return problem(401, 'unauthorized', 'Authentication required');
        if (!recorded.idempotencyKey) {
          return problem(400, 'missing_idempotency_key', 'Idempotency-Key header required');
        }
        return new Response(sseBody(), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            'x-capix-receipt-id': RECEIPT_ID,
          },
        });
      }
    }

    // The "Not Found" regression: any path outside the contract.
    notFound.push(recorded);
    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };

  vi.stubGlobal('fetch', vi.fn(fetchStub));
  return { requests, notFound };
}

async function collect(streamInput: AsyncGenerator<CapixProviderChunk>): Promise<CapixProviderChunk[]> {
  const chunks: CapixProviderChunk[] = [];
  for await (const chunk of streamInput) chunks.push(chunk);
  return chunks;
}

describe('inference E2E: login → inference → streamed response → receipt', () => {
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.CAPIX_API_KEY;
    delete process.env.CAPIX_API_KEY;
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.CAPIX_API_KEY;
    else process.env.CAPIX_API_KEY = savedApiKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('API-key login, catalog discovery, then a streamed inference with usage and receipt', async () => {
    const { requests, notFound } = installControlPlane();

    // 1. Login: the broker verifies the API key digest against the control plane.
    const broker = new CredentialBroker();
    setBrokerAccessor(() => broker);
    const login = await broker.registerApiKey(API_KEY);
    expect(login.type).toBe('success');
    if (login.type !== 'success') return;
    expect(login.metadata?.project_id).toBe('prj_e2e');

    // The raw key never crosses the wire — only its SHA-256 digest.
    const verifyReq = requests.find((r) => r.url.endsWith('/api/v1/auth/api-key/verify'));
    expect(verifyReq).toBeDefined();
    expect(verifyReq!.body).toContain(API_KEY_DIGEST);
    expect(verifyReq!.body).not.toContain(API_KEY);

    // 2. Model discovery with the session the login established.
    const catalogue = await models();
    expect(catalogue.auto).toMatchObject({ id: 'capix/auto', providerID: 'capix' });

    // 3. Inference: streamed response with route, deltas, usage and receipt.
    const chunks = await collect(
      stream(
        { model: 'capix/auto', messages: [{ role: 'user', content: 'Say hello' }] },
        { meta: META }
      )
    );

    expect(chunks[0]).toMatchObject({ type: 'route', receiptId: RECEIPT_ID });
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.delta : ''))
      .join('');
    expect(text).toBe('Hello world');
    expect(chunks).toContainEqual({
      type: 'usage',
      input: 12,
      output: 7,
      cacheRead: undefined,
      cost: { amount: '150', asset: 'USD-credit', scale: 6 },
    });
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      receiptId: RECEIPT_ID,
    });

    // Token delivery: bearer + idempotency key + client identity headers.
    const inferenceReq = requests.find((r) =>
      r.url.endsWith('/api/v1/inference/chat/completions')
    );
    expect(inferenceReq!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(inferenceReq!.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(inferenceReq!.body)).toMatchObject({
      model: 'capix/auto',
      stream: true,
    });

    // "Not Found" regression guard: no request left the production contract.
    expect(notFound).toEqual([]);
  });

  it('session login survives a 401: refreshes once, retries, and streams to a receipt', async () => {
    const { requests, notFound } = installControlPlane();

    // A logged-in desktop session: the launcher injected a now-expired access
    // token; the refresh token lives in the broker's credential store.
    const broker = new CredentialBroker();
    // Keep the test hermetic: never touch the real launcher IPC broker.
    broker.getBrokerToken = async () => null;
    (
      broker as unknown as { sessionRefresh: string | null }
    ).sessionRefresh = SEED_REFRESH;
    setBrokerAccessor(() => broker);
    process.env.CAPIX_API_KEY = EXPIRED_SESSION;

    const chunks = await collect(
      stream(
        { model: 'capix/auto', messages: [{ role: 'user', content: 'Say hello' }] },
        { meta: META }
      )
    );

    // The refresh grant rotated the seed refresh token exactly once.
    const refreshReqs = requests.filter((r) => r.url.endsWith('/oauth/token'));
    expect(refreshReqs).toHaveLength(1);
    const refreshForm = new URLSearchParams(refreshReqs[0]!.body);
    expect(refreshForm.get('grant_type')).toBe('refresh_token');
    expect(refreshForm.get('refresh_token')).toBe(SEED_REFRESH);
    expect(refreshForm.get('client_id')).toBe('capix-code');

    // The rotated refresh token replaced the consumed one in the broker store.
    expect((broker as unknown as { sessionRefresh: string | null }).sessionRefresh).toBe(
      ROTATED_REFRESH
    );

    // Inference ran twice: expired bearer → 401, fresh bearer → stream.
    const inferenceReqs = requests.filter((r) =>
      r.url.endsWith('/api/v1/inference/chat/completions')
    );
    expect(inferenceReqs).toHaveLength(2);
    expect(inferenceReqs[0]!.authorization).toBe(`Bearer ${EXPIRED_SESSION}`);
    expect(inferenceReqs[1]!.authorization).toBe(`Bearer ${FRESH_SESSION}`);
    // The idempotency key is stable across the retry (same logical request).
    expect(inferenceReqs[1]!.idempotencyKey).toBe(inferenceReqs[0]!.idempotencyKey);

    expect(chunks[0]).toMatchObject({ type: 'route', receiptId: RECEIPT_ID });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', receiptId: RECEIPT_ID });
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'usage', input: 12, output: 7 }));
    expect(notFound).toEqual([]);
  });

  it('fails login cleanly when the API key is rejected — no token is delivered', async () => {
    const { notFound } = installControlPlane();
    const broker = new CredentialBroker();
    const login = await broker.registerApiKey(`cpxk_${'b'.repeat(48)}`);
    expect(login.type).toBe('failed');
    await expect(broker.getAccessToken()).rejects.toThrow();
    expect(notFound).toEqual([]);
  });
});
