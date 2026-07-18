import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import * as intelligence from '../src/intelligence-client.js';
import {
  PrivateModelManager,
  isPrivateModelRef,
  type PrivateLlmEvent,
} from '../src/planner/private-llm.js';
import * as routing from '../src/routing-client.js';
import type {
  Deployment,
  ManagedModel,
  RouteQuote,
  TrainingJob,
} from '../src/routing-client.js';
import { createModelTools } from '../src/tools/model-tools.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'capix-private-llm-test-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function baseModel(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    modelId: 'llama-3.1-8b-instruct',
    name: 'Llama 3.1 8B Instruct',
    visibility: 'public',
    capabilities: ['chat', 'fine-tune'],
    pricePerInputToken: { amountMinor: '10', currency: 'USD', scale: 4 },
    pricePerOutputToken: { amountMinor: '30', currency: 'USD', scale: 4 },
    regions: ['us-east'],
    ...overrides,
  };
}

function privateModel(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    modelId: 'private/mdl_1',
    name: 'My private Llama',
    visibility: 'private',
    capabilities: ['chat'],
    pricePerInputToken: { amountMinor: '15', currency: 'USD', scale: 4 },
    pricePerOutputToken: { amountMinor: '45', currency: 'USD', scale: 4 },
    regions: ['us-east'],
    deploymentId: 'dep_1',
    ...overrides,
  };
}

function quote(overrides: Partial<RouteQuote> = {}): RouteQuote {
  return {
    routeQuoteId: 'rq_1',
    quoteToken: 'qtok_1',
    specHash: 'sha_1',
    normalizedSpec: {
      kind: 'private_model',
      name: 'private-llama-3-1-8b-instruct',
      region: 'us-east',
      trustTier: 'verified',
      modelRef: 'llama-3.1-8b-instruct',
      minGpuMemoryGiB: 24,
    },
    filterOutcome: {
      considered: 1,
      rejectedCapacity: 0,
      rejectedRegion: 0,
      rejectedTrustTier: 0,
      rejectedBudget: 0,
    },
    candidates: [
      {
        candidateId: 'cand_1',
        region: 'us-east',
        trustTier: 'verified',
        capabilities: ['gpu'],
        pricePerUnit: { amountMinor: '250', currency: 'USD', scale: 4 },
        meteringUnit: 'gpu_second',
        score: 0.91,
        scoreBreakdown: { price: 0.9, latency: 0.9, reliability: 0.9, evidence: 0.9, utilization: 0.9 },
      },
    ],
    issuedAt: '2026-07-18T12:00:00Z',
    expiresAt: '2026-07-18T12:05:00Z',
    ...overrides,
  };
}

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    deploymentId: 'dep_1',
    projectId: 'proj_1',
    spec: quote().normalizedSpec,
    state: 'provisioning',
    meteringUnit: 'gpu_second',
    customerView: {
      summary: 'provisioning private model',
      state: 'provisioning',
      region: 'us-east',
      trustTier: 'verified',
      spendToDate: { amountMinor: '0', currency: 'USD', scale: 2 },
    },
    createdAt: '2026-07-18T12:00:00Z',
    updatedAt: '2026-07-18T12:00:00Z',
    ...overrides,
  };
}

function runningDeployment(): Deployment {
  return deployment({
    state: 'running',
    customerView: {
      summary: 'private model is serving',
      state: 'running',
      region: 'us-east',
      trustTier: 'verified',
      endpoints: [{ url: 'https://models.capix.example/dep_1', protocol: 'https' }],
      spendToDate: { amountMinor: '420', currency: 'USD', scale: 2 },
    },
  });
}

interface DeployMockOptions {
  catalog?: ManagedModel[];
  decision?: string;
  deploymentStates?: Array<Partial<Deployment>>;
  routeQuote?: RouteQuote;
}

/**
 * Fetch stub for the deploy flow: catalog lookup, covenant gate, quote,
 * commit, deployment polls walking `deploymentStates`, then catalog polls
 * (which return `catalog` again — include the private entry for success).
 */
function deployFetchMock(opts: DeployMockOptions = {}) {
  const catalog = opts.catalog ?? [baseModel(), privateModel()];
  const decision = opts.decision ?? 'allow';
  const states = opts.deploymentStates ?? [
    { state: 'provisioning' as const },
    { state: 'starting' as const },
    runningDeployment(),
  ];
  const routeQuote = opts.routeQuote ?? quote();
  let poll = 0;
  const receiptCalls: unknown[] = [];
  const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/covenants/check-permission')) {
      return jsonResponse({ decision });
    }
    if (url.endsWith('/models') && method === 'GET') {
      return jsonResponse({ models: catalog });
    }
    if (url.endsWith('/route/quote') && method === 'POST') {
      return jsonResponse(routeQuote);
    }
    if (url.endsWith('/route/commit') && method === 'POST') {
      return jsonResponse({
        routeReceiptId: 'rr_1',
        routeQuoteId: routeQuote.routeQuoteId,
        committedCandidate: routeQuote.candidates[0],
        committedAt: '2026-07-18T12:00:30Z',
        deploymentId: 'dep_1',
      });
    }
    if (url.includes('/deployments/') && method === 'GET') {
      const overrides = states[Math.min(poll++, states.length - 1)];
      return jsonResponse(
        'state' in overrides && overrides.state === 'running'
          ? overrides
          : deployment(overrides)
      );
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

describe('isPrivateModelRef', () => {
  it('accepts private/<id> references and rejects everything else', () => {
    expect(isPrivateModelRef('private/mdl_1')).toBe(true);
    expect(isPrivateModelRef('private/trn_ABC-123')).toBe(true);
    expect(isPrivateModelRef('llama-3.1-8b-instruct')).toBe(false);
    expect(isPrivateModelRef('private/')).toBe(false);
    expect(isPrivateModelRef('private/a/b')).toBe(false);
    expect(isPrivateModelRef('')).toBe(false);
  });
});

describe('PrivateModelManager.deploy', () => {
  it('quotes, provisions, and registers the model in the private catalog', async () => {
    const { fetchMock, receiptCalls } = deployFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const events: PrivateLlmEvent[] = [];
    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'llama-3.1-8b-instruct',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('deployed');
    expect(result.modelId).toBe('private/mdl_1');
    expect(result.deploymentId).toBe('dep_1');
    expect(result.costMinor).toBe('420');
    expect(result.asset).toBe('USD');
    expect(result.scale).toBe(2);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'resolving',
      'quoting',
      'quoted',
      'committing',
      'committed',
      'state',
      'state',
      'state',
      'catalog-check',
      'registered',
      'done',
    ]);

    // The quote carried a private_model spec with defaults applied.
    const quoteCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/route/quote'))!;
    const spec = JSON.parse(String((quoteCall[1] as RequestInit).body)).spec;
    expect(spec).toMatchObject({
      kind: 'private_model',
      modelRef: 'llama-3.1-8b-instruct',
      region: 'us-east',
      trustTier: 'verified',
      minGpuMemoryGiB: 24,
    });
    expect(spec.name).toBe('private-llama-3-1-8b-instruct');

    // A work receipt was attempted (best-effort).
    await vi.waitFor(() => expect(receiptCalls.length).toBeGreaterThan(0));
    expect(receiptCalls[0]).toMatchObject({
      kind: 'infra-provision',
      costMinor: '420',
      asset: 'USD',
      scale: 2,
      outcome: 'success',
      source: 'capix-code:private-llm',
    });
  });

  it('fails before any spend when the base model is not in the catalog', async () => {
    const { fetchMock } = deployFetchMock({ catalog: [baseModel()] });
    vi.stubGlobal('fetch', fetchMock);

    const events: PrivateLlmEvent[] = [];
    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'does-not-exist',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('not in the model catalog');
    expect(events.map((e) => e.type)).toEqual(['resolving', 'failed', 'done']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/route/quote'))).toBe(false);
  });

  it('fails closed when the covenant denies models:deploy', async () => {
    const { fetchMock } = deployFetchMock({ decision: 'deny' });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'llama-3.1-8b-instruct',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('models:deploy denied');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/route/quote'))).toBe(false);
  });

  it('fails when the router returns no placement candidates', async () => {
    const { fetchMock } = deployFetchMock({ routeQuote: quote({ candidates: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'llama-3.1-8b-instruct',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no placement candidates');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/route/commit'))).toBe(false);
  });

  it('fails with the deployment id when provisioning fails', async () => {
    const { fetchMock } = deployFetchMock({
      deploymentStates: [{ state: 'provisioning' }, { state: 'failed' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'llama-3.1-8b-instruct',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.deploymentId).toBe('dep_1');
    expect(result.error).toContain('"failed"');
  });

  it('fails when the model never appears in the private catalog', async () => {
    const { fetchMock } = deployFetchMock({ catalog: [baseModel()] });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.deploy({
      baseModel: 'llama-3.1-8b-instruct',
      pollIntervalMs: 1,
      catalogTimeoutMs: 10,
    });

    expect(result.status).toBe('failed');
    expect(result.deploymentId).toBe('dep_1');
    expect(result.error).toBe('model did not appear in the private catalog');
  });
});

describe('PrivateModelManager.fineTune', () => {
  function trainFetchMock(privateCatalogEntry: ManagedModel | null) {
    const submitBodies: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/covenants/check-permission')) {
        return jsonResponse({ decision: 'allow' });
      }
      if (url.endsWith('/models') && method === 'GET') {
        return jsonResponse({ models: privateCatalogEntry ? [privateCatalogEntry] : [] });
      }
      if (url.endsWith('/models/train') && method === 'POST') {
        submitBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        const job: TrainingJob = {
          jobId: 'trn_1',
          status: 'queued',
          baseModel: 'private/mdl_1',
          dataset: { uri: 'file:///tmp/data.jsonl', format: 'jsonl' },
          specializationPrompt: 'answer support tickets',
          createdAt: '2026-07-18T12:00:00Z',
          updatedAt: '2026-07-18T12:00:00Z',
        };
        return jsonResponse({ job }, 202);
      }
      if (url.includes('/models/train/') && method === 'GET') {
        return jsonResponse({
          job: {
            jobId: 'trn_1',
            status: 'ready',
            baseModel: 'private/mdl_1',
            dataset: { uri: 'file:///tmp/data.jsonl', format: 'jsonl' },
            specializationPrompt: 'answer support tickets',
            registeredModelId: 'private/trn_1',
            actualCost: { amountMinor: '150', currency: 'USD', scale: 2 },
            createdAt: '2026-07-18T12:00:00Z',
            updatedAt: '2026-07-18T12:10:00Z',
          } satisfies TrainingJob,
        });
      }
      if (method === 'POST') return jsonResponse({ id: 'evt_1' });
      return jsonResponse({}, 404);
    });
    return { fetchMock, submitBodies };
  }

  it('resolves the private base owner-only, then fine-tunes it', async () => {
    const datasetPath = await makeDataset();
    const { fetchMock, submitBodies } = trainFetchMock(privateModel());
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.fineTune({
      baseModel: 'private/mdl_1',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('ready');
    expect(result.modelId).toBe('private/trn_1');
    expect(submitBodies).toHaveLength(1);
    expect(submitBodies[0]).toMatchObject({
      baseModel: 'private/mdl_1',
      specializationPrompt: 'answer support tickets',
    });
  });

  it('refuses to train against a private model the caller does not own', async () => {
    const datasetPath = await makeDataset();
    // The catalog returns nothing — a private model owned by someone else is
    // invisible to this caller.
    const { fetchMock, submitBodies } = trainFetchMock(null);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const result = await manager.fineTune({
      baseModel: 'private/mdl_1',
      datasetPath,
      specialize: 'answer support tickets',
      pollIntervalMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('not found in your private model catalog');
    expect(submitBodies).toHaveLength(0);
  });
});

describe('PrivateModelManager.resolveForInference', () => {
  it('returns the catalog entry for an owned private model', async () => {
    const { fetchMock } = deployFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    const model = await manager.resolveForInference('private/mdl_1');
    expect(model.modelId).toBe('private/mdl_1');
    expect(model.visibility).toBe('private');
  });

  it('rejects malformed and non-private references', async () => {
    const manager = new PrivateModelManager();
    await expect(manager.resolveForInference('llama-3.1-8b-instruct')).rejects.toThrow(
      'not a private model reference'
    );
    await expect(manager.resolveForInference('private/')).rejects.toThrow(
      'not a private model reference'
    );
  });

  it('rejects a private id that only exists as a public catalog entry', async () => {
    const { fetchMock } = deployFetchMock({
      catalog: [baseModel({ modelId: 'private/mdl_1', visibility: 'public' })],
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PrivateModelManager();
    await expect(manager.resolveForInference('private/mdl_1')).rejects.toThrow(
      'not found in your private model catalog'
    );
  });
});

describe('createModelTools', () => {
  const ctx = { sessionId: 'ses_1', turnId: 'turn_1', workspaceRoot: '/tmp' };

  it('marks deploy and train as billing tools that always require approval', () => {
    const tools = createModelTools();
    const deploy = tools.find((t) => t.name === 'model_deploy')!;
    const train = tools.find((t) => t.name === 'model_train')!;
    const list = tools.find((t) => t.name === 'model_list')!;
    expect(deploy.riskClass).toBe('billing');
    expect(deploy.alwaysRequiresApproval).toBe(true);
    expect(train.riskClass).toBe('billing');
    expect(train.alwaysRequiresApproval).toBe(true);
    expect(list.riskClass).toBe('read');
  });

  it('model_list renders catalog entries without provider identity', async () => {
    const { fetchMock } = deployFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const tools = createModelTools();
    const list = tools.find((t) => t.name === 'model_list')!;
    const result = await list.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('llama-3.1-8b-instruct [public]');
    expect(result.output).toContain('private/mdl_1 [private]');
    expect(result.metadata).toMatchObject({ count: 2, privateModelIds: ['private/mdl_1'] });
  });

  it('model_deploy validates required arguments', async () => {
    const tools = createModelTools();
    const deploy = tools.find((t) => t.name === 'model_deploy')!;
    const result = await deploy.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('base_model is required');
  });

  it('model_deploy returns the private model id and spend on success', async () => {
    const { fetchMock } = deployFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const tools = createModelTools();
    const deploy = tools.find((t) => t.name === 'model_deploy')!;
    const result = await deploy.execute(
      { base_model: 'llama-3.1-8b-instruct', poll_interval_ms: 5 },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('deployed private model private/mdl_1');
    expect(result.output).toContain('spend to date: USD 4.20');
    expect(result.metadata).toMatchObject({ modelId: 'private/mdl_1', deploymentId: 'dep_1' });
  });
});
