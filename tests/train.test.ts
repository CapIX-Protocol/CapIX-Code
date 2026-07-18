import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import * as intelligence from '../src/intelligence-client.js';
import { Trainer, type TrainProgressEvent } from '../src/planner/train.js';
import * as routing from '../src/routing-client.js';
import type { TrainingJob } from '../src/routing-client.js';

const accessBroker = {
  getAccessToken: vi
    .fn()
    .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
  refreshToken: vi.fn(),
} as unknown as CredentialBroker;

routing.setBrokerAccessor(() => accessBroker);
intelligence.setBrokerAccessor(() => accessBroker);

let tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeDataset(name = 'data.jsonl', content = '{"text":"hello"}\n'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capix-train-test-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function trainingJob(overrides: Partial<TrainingJob> = {}): TrainingJob {
  return {
    jobId: 'trn_1',
    status: 'queued',
    baseModel: 'llama-3.1-8b-instruct',
    dataset: { uri: 'file:///tmp/data.jsonl', format: 'jsonl' },
    specializationPrompt: 'answer support tickets',
    createdAt: '2026-07-18T12:00:00Z',
    updatedAt: '2026-07-18T12:00:00Z',
    ...overrides,
  };
}

/**
 * Fetch stub: covenant check allows, submit returns 202, polls walk the given
 * job sequence, and intelligence POSTs (hook events / receipts) are accepted.
 */
function trainFetchMock(jobSequence: Array<Partial<TrainingJob>>) {
  let poll = 0;
  const receiptCalls: unknown[] = [];
  const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/covenants/check-permission')) {
      return jsonResponse({ decision: 'allow' });
    }
    if (url.endsWith('/models/train') && method === 'POST') {
      return jsonResponse({ job: trainingJob() }, 202);
    }
    if (url.includes('/models/train/') && method === 'GET') {
      const overrides = jobSequence[Math.min(poll++, jobSequence.length - 1)];
      return jsonResponse({ job: trainingJob(overrides) });
    }
    if (url.endsWith('/receipts') && method === 'POST') {
      receiptCalls.push(init?.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ id: 'rcp_1' });
    }
    if (method === 'POST') return jsonResponse({ id: 'evt_1' });
    return jsonResponse({}, 404);
  });
  return { fetchMock, receiptCalls };
}

describe('trainer', () => {
  it('submits, polls to ready, and registers the model in the catalog', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock, receiptCalls } = trainFetchMock([
      { status: 'queued' },
      {
        status: 'training',
        progress: { percent: 34, currentEpoch: 1, totalEpochs: 3 },
        checkpoints: [
          { checkpointId: 'ckpt_1', epoch: 1, step: 100, createdAt: '2026-07-18T12:01:00Z' },
        ],
      },
      {
        status: 'training',
        progress: { percent: 67, currentEpoch: 2, totalEpochs: 3 },
        checkpoints: [
          { checkpointId: 'ckpt_1', epoch: 1, step: 100, createdAt: '2026-07-18T12:01:00Z' },
          { checkpointId: 'ckpt_2', epoch: 2, step: 200, createdAt: '2026-07-18T12:02:00Z' },
        ],
      },
      {
        status: 'ready',
        registeredModelId: 'private/trn_1',
        actualCost: { amountMinor: '150', currency: 'USD', scale: 2 },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const events: TrainProgressEvent[] = [];
    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      hyperparameters: { epochs: 3, learningRate: 0.0002, loraRank: 16 },
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('ready');
    expect(result.jobId).toBe('trn_1');
    expect(result.modelId).toBe('private/trn_1');
    expect(result.costMinor).toBe('150');
    expect(result.asset).toBe('USD');
    expect(result.scale).toBe(2);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('validating');
    expect(types).toContain('submitting');
    expect(types).toContain('submitted');
    expect(types).toContain('state');
    expect(types).toContain('checkpoint');
    expect(types).toContain('registered');
    expect(types[types.length - 1]).toBe('done');

    // Checkpoint events fire once per new checkpoint, in order.
    const checkpoints = events.filter((e) => e.type === 'checkpoint');
    expect(checkpoints.map((c) => (c.type === 'checkpoint' ? c.checkpointId : ''))).toEqual([
      'ckpt_1',
      'ckpt_2',
    ]);

    // The submit carried the dataset fingerprint + hyperparameters.
    const submitCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/models/train') && (init as RequestInit)?.method === 'POST'
    )!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body));
    expect(body.baseModel).toBe('llama-3.1-8b-instruct');
    expect(body.specializationPrompt).toBe('answer support tickets');
    expect(body.dataset.uri).toBe(`file://${datasetPath}`);
    expect(body.dataset.format).toBe('jsonl');
    expect(body.dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.dataset.bytes).toBe(String(Buffer.byteLength('{"text":"hello"}\n')));
    expect(body.hyperparameters).toEqual({ epochs: 3, learningRate: 0.0002, loraRank: 16 });

    // A model-training work receipt was attempted (best-effort).
    await vi.waitFor(() => expect(receiptCalls.length).toBeGreaterThan(0));
    expect(receiptCalls[0]).toMatchObject({
      kind: 'model-training',
      costMinor: '150',
      asset: 'USD',
      scale: 2,
      outcome: 'success',
      source: 'capix-code:train',
    });
  });

  it('returns failed with the job failureReason when training fails', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock } = trainFetchMock([
      { status: 'queued' },
      { status: 'failed', failureReason: 'dataset rejected: malformed row 7' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const events: TrainProgressEvent[] = [];
    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.jobId).toBe('trn_1');
    expect(result.error).toBe('dataset rejected: malformed row 7');
    expect(result.modelId).toBeUndefined();
    expect(events.some((e) => e.type === 'failed' && e.message.includes('malformed row 7'))).toBe(
      true
    );
  });

  it('fails without any network call when the dataset is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const events: TrainProgressEvent[] = [];
    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath: join(tmpdir(), 'definitely-not-here-capix-train.jsonl'),
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['validating', 'failed', 'done']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the covenant denies models:train', async () => {
    const datasetPath = await makeDataset();
    const fetchMock = vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/covenants/check-permission')) {
        return jsonResponse({ decision: 'deny', ruleId: 'rule_1', reason: 'training disabled' });
      }
      return jsonResponse({}, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: TrainProgressEvent[] = [];
    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('models:train denied');
    // No job was ever submitted.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/models/train'))
    ).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['validating', 'failed', 'done']);
  });

  it('reports cancelled when the job is cancelled server-side', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock } = trainFetchMock([{ status: 'training' }, { status: 'cancelled' }]);
    vi.stubGlobal('fetch', fetchMock);

    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('cancelled');
    expect(result.jobId).toBe('trn_1');
    expect(result.error).toContain('cancelled');
  });

  it('fails cleanly when job submission is rejected', async () => {
    const datasetPath = await makeDataset();
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/covenants/check-permission')) {
        return jsonResponse({ decision: 'allow' });
      }
      if (url.endsWith('/models/train') && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(
          {
            type: 'https://api.capix.dev/problems/CAPIX_INSUFFICIENT_BALANCE',
            title: 'Insufficient balance',
            detail: 'top up to start training',
            status: 402,
            code: 'CAPIX_INSUFFICIENT_BALANCE',
          },
          402
        );
      }
      return jsonResponse({ id: 'evt_1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.jobId).toBeUndefined();
    expect(result.error).toContain('top up to start training');
  });

  it('keeps polling through transient poll failures', async () => {
    const datasetPath = await makeDataset();
    let poll = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/covenants/check-permission')) {
        return jsonResponse({ decision: 'allow' });
      }
      if (url.endsWith('/models/train') && method === 'POST') {
        return jsonResponse({ job: trainingJob() }, 202);
      }
      if (url.includes('/models/train/') && method === 'GET') {
        poll += 1;
        if (poll === 1) return jsonResponse({ detail: 'server unavailable' }, 500);
        return jsonResponse({
          job: trainingJob({ status: 'ready', registeredModelId: 'private/trn_1' }),
        });
      }
      if (method === 'POST') return jsonResponse({ id: 'evt_1' });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('ready');
    expect(result.modelId).toBe('private/trn_1');
    expect(poll).toBeGreaterThan(1);
  });

  it('stops with an abort error when the signal fires', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock } = trainFetchMock([{ status: 'training' }]);
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'submitted') controller.abort();
      },
    });

    expect(result.status).toBe('failed');
    expect(result.jobId).toBe('trn_1');
    expect(result.error).toBe('training aborted');
  });

  it('times out when the job never reaches a terminal state', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock } = trainFetchMock([{ status: 'training' }]);
    vi.stubGlobal('fetch', fetchMock);

    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 1,
      timeoutMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
  });

  it('passes resumeFromCheckpointId through to the submit body', async () => {
    const datasetPath = await makeDataset('data.csv', 'a,b\n1,2\n');
    const { fetchMock } = trainFetchMock([
      { status: 'ready', registeredModelId: 'private/trn_1' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const trainer = new Trainer();
    const result = await trainer.train({
      baseModel: 'llama-3.1-8b-instruct',
      datasetPath,
      specialize: 'answer support tickets',
      resumeFromCheckpointId: 'ckpt_9',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('ready');
    const submitCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/models/train') && (init as RequestInit)?.method === 'POST'
    )!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body));
    expect(body.resumedFromCheckpointId).toBe('ckpt_9');
    expect(body.dataset.format).toBe('csv');
  });
});
