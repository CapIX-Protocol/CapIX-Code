import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import * as intelligence from '../src/intelligence-client.js';
import { Architect, buildWorkloadSpec } from '../src/planner/architect.js';
import { Deployer, type DeployProgressEvent } from '../src/planner/deploy.js';
import * as routing from '../src/routing-client.js';
import { renderStatusLine, SessionStatusStore } from '../src/tui/index.js';

const accessBroker = {
  getAccessToken: vi
    .fn()
    .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
  refreshToken: vi.fn(),
} as unknown as CredentialBroker;

routing.setBrokerAccessor(() => accessBroker);
intelligence.setBrokerAccessor(() => accessBroker);

afterEach(() => vi.unstubAllGlobals());

function routeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    routeQuoteId: 'rq_1',
    quoteToken: 'qt_1',
    specHash: 'a'.repeat(64),
    normalizedSpec: {},
    filterOutcome: {
      considered: 3,
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
        capabilities: ['cpu'],
        pricePerUnit: { amountMinor: '1500', currency: 'USD', scale: 6 },
        meteringUnit: 'cpu_core_second',
        score: 0.9,
        scoreBreakdown: { price: 0.8, latency: 0.9, reliability: 0.95, evidence: 1, utilization: 0.7 },
      },
    ],
    issuedAt: '2026-07-18T12:00:00Z',
    expiresAt: '2026-07-18T13:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MODEL_RESPONSE = `SUMMARY: A containerized API backed by a private model.
TRUST_TIER: verified
REGION: eu-central
ASSUMPTIONS: single region is acceptable, traffic is moderate
SERVICE: api | serves customer traffic | api-svc
DATASTORE: main-db | postgres | system of record
MODEL: support-llm | capix/models/support-7b | answers support tickets
WORKLOAD: api-svc | container_service | customer API | image=registry.capix.dev/api:v3; port=8080; replicas=2
WORKLOAD: support-llm | private_model | private support model | modelRef=capix/models/support-7b; minGpuMemoryGiB=24`;

describe('architect', () => {
  it('designs an architecture from intent and attaches live router quotes', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(routeQuoteResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const architect = new Architect(async () => MODEL_RESPONSE);
    const plan = await architect.design('run my support API with a private model');

    expect(plan.status).toBe('awaiting-approval');
    expect(plan.region).toBe('eu-central');
    expect(plan.trustTier).toBe('verified');
    expect(plan.services).toHaveLength(1);
    expect(plan.dataStores).toEqual([
      { name: 'main-db', engine: 'postgres', purpose: 'system of record' },
    ]);
    expect(plan.models[0]).toMatchObject({ name: 'support-llm', modelRef: 'capix/models/support-7b' });

    expect(plan.workloads).toHaveLength(2);
    const api = plan.workloads.find((w) => w.name === 'api-svc')!;
    expect(api.spec).toMatchObject({
      kind: 'container_service',
      image: 'registry.capix.dev/api:v3',
      port: 8080,
      replicas: 2,
      region: 'eu-central',
      trustTier: 'verified',
    });
    const model = plan.workloads.find((w) => w.name === 'support-llm')!;
    expect(model.spec).toMatchObject({ kind: 'private_model', minGpuMemoryGiB: 24 });

    // Every workload got a live quote from the smart router.
    const quoteCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/route/quote')
    );
    expect(quoteCalls).toHaveLength(2);
    expect(api.quote?.routeQuoteId).toBe('rq_1');

    // Cost estimate sums best-candidate prices in integer minor units.
    expect(plan.costEstimate?.total).toEqual({ amountMinor: '3000', currency: 'USD', scale: 6 });
    expect(plan.costEstimate?.quotesExpireAt).toBe('2026-07-18T13:00:00Z');
  });

  it('falls back to a labelled heuristic plan without a model invoker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse())));

    const architect = new Architect();
    const plan = await architect.design('train a small GPU model');

    expect(plan.workloads).toHaveLength(1);
    expect(plan.workloads[0]!.kind).toBe('dedicated_gpu');
    expect(plan.assumptions.join(' ')).toContain('heuristic');
    expect(plan.status).toBe('awaiting-approval');
  });

  it('records quote failures per workload instead of failing the plan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(
          {
            type: 'https://api.capix.dev/problems/CAPIX_CAPACITY_UNAVAILABLE',
            title: 'No capacity',
            detail: 'no candidate has capacity',
            status: 409,
            code: 'CAPIX_CAPACITY_UNAVAILABLE',
          },
          409
        )
      )
    );

    const architect = new Architect(async () => MODEL_RESPONSE);
    const plan = await architect.design('run my support API');

    expect(plan.status).toBe('awaiting-approval');
    expect(plan.workloads.every((w) => w.quoteError)).toBe(true);
    expect(plan.workloads[0]!.quoteError).toContain('no candidate has capacity');
    expect(plan.costEstimate?.total).toBeNull();
  });

  it('gates approval state transitions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse())));
    const architect = new Architect(async () => MODEL_RESPONSE);
    const plan = await architect.design('anything');

    expect(() => architect.approve('wrong-id')).toThrow();
    architect.approve(plan.id);
    expect(plan.status).toBe('approved');
    expect(() => architect.approve(plan.id)).toThrow(/awaiting-approval/);
  });
});

describe('buildWorkloadSpec', () => {
  it('fills conservative defaults for missing fields', () => {
    expect(buildWorkloadSpec('vm', 'cpu_vm', {}, 'us-east', 'community')).toEqual({
      kind: 'cpu_vm',
      name: 'vm',
      region: 'us-east',
      trustTier: 'community',
      vcpus: 2,
      memoryGiB: 4,
      diskGiB: undefined,
    });
  });

  it('forces sovereign trust tier for secured kinds', () => {
    const spec = buildWorkloadSpec('enclave', 'secured_gpu', { gpuCount: 2 }, 'us-east', 'community');
    expect(spec.trustTier).toBe('sovereign');
    expect(spec).toMatchObject({ attestationRequired: true, gpuCount: 2 });
  });
});

describe('deployer', () => {
  async function approvedPlan() {
    const architect = new Architect(async () => MODEL_RESPONSE);
    const plan = await architect.design('run my support API');
    architect.approve(plan.id);
    return { architect, plan };
  }

  function deployFetchMock(stateSequence: string[]) {
    let poll = 0;
    return vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/route/quote')) return jsonResponse(routeQuoteResponse());
      if (url.endsWith('/route/commit')) {
        return jsonResponse({
          routeReceiptId: 'rr_1',
          routeQuoteId: 'rq_1',
          committedCandidate: routeQuoteResponse().candidates[0],
          committedAt: '2026-07-18T12:05:00Z',
          deploymentId: 'dep_1',
        });
      }
      if (url.includes('/deployments/') && method === 'GET') {
        const state = stateSequence[Math.min(poll++, stateSequence.length - 1)];
        return jsonResponse({
          deploymentId: 'dep_1',
          projectId: 'proj_1',
          spec: {},
          state,
          meteringUnit: 'cpu_core_second',
          customerView: {
            summary: '2x container, eu-central',
            state,
            region: 'eu-central',
            trustTier: 'verified',
            endpoints: [{ url: 'https://api.example.capix.app', protocol: 'https' }],
            spendToDate: { amountMinor: '4200', currency: 'USD', scale: 6 },
          },
          createdAt: '2026-07-18T12:05:00Z',
          updatedAt: '2026-07-18T12:06:00Z',
        });
      }
      // Intelligence hook events / receipts — accept and move on.
      if (method === 'POST') return jsonResponse({ id: 'evt_1' });
      return jsonResponse({}, 404);
    });
  }

  it('refuses to deploy a plan that is not approved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse())));
    const architect = new Architect(async () => MODEL_RESPONSE);
    const plan = await architect.design('run my support API');

    const deployer = new Deployer(architect);
    await expect(deployer.deploy(plan, { skipCovenantCheck: true })).rejects.toThrow(/approve/);
  });

  it('quotes, commits, monitors to healthy, and streams progress', async () => {
    vi.stubGlobal('fetch', deployFetchMock(['provisioning', 'starting', 'running']));
    const { architect, plan } = await approvedPlan();

    const events: DeployProgressEvent[] = [];
    const deployer = new Deployer(architect);
    const result = await deployer.deploy(plan, {
      skipCovenantCheck: true,
      pollIntervalMs: 1,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('deployed');
    expect(result.workloads).toHaveLength(2);
    expect(result.workloads.every((w) => w.state === 'running')).toBe(true);

    const types = events.map((e) => e.type);
    expect(types).toContain('quoting');
    expect(types).toContain('quoted');
    expect(types).toContain('committing');
    expect(types).toContain('committed');
    expect(types).toContain('healthy');
    expect(types[types.length - 1]).toBe('done');

    const healthy = events.find((e) => e.type === 'healthy')!;
    expect(healthy).toMatchObject({
      workload: 'api-svc',
      deploymentId: 'dep_1',
      spendToDate: { amountMinor: '4200', currency: 'USD', scale: 6 },
    });
    expect(architect.getCurrentPlan()?.status).toBe('deployed');
  });

  it('fails the workload when the router returns no candidates', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/route/quote')) {
        return jsonResponse(routeQuoteResponse({ candidates: [] }));
      }
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ id: 'evt_1' });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await approvedPlan();

    const events: DeployProgressEvent[] = [];
    const deployer = new Deployer();
    const result = await deployer.deploy(plan, {
      skipCovenantCheck: true,
      pollIntervalMs: 1,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.workloads[0]).toMatchObject({
      state: 'failed',
      error: 'smart router returned no placement candidates',
    });
    // No commit was attempted.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/route/commit'))).toBe(false);
  });
});

describe('routing client', () => {
  it('returns the full managed model catalog, public and private', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          models: [
            {
              modelId: 'capix/auto',
              name: 'Capix Auto',
              visibility: 'public',
              capabilities: ['chat', 'tool-calls'],
              pricePerInputToken: { amountMinor: '200', currency: 'USD', scale: 6 },
              pricePerOutputToken: { amountMinor: '600', currency: 'USD', scale: 6 },
              regions: ['us-east', 'eu-central'],
            },
            {
              modelId: 'priv_1',
              name: 'Support 7B (private)',
              visibility: 'private',
              capabilities: ['chat'],
              pricePerInputToken: { amountMinor: '100', currency: 'USD', scale: 6 },
              pricePerOutputToken: { amountMinor: '300', currency: 'USD', scale: 6 },
              regions: ['eu-central'],
              deploymentId: 'dep_9',
              trustTier: 'verified',
            },
          ],
        })
      )
    );

    const models = await routing.listManagedModels();
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.visibility)).toEqual(['public', 'private']);
  });

  it('formats money without floating point', () => {
    expect(routing.formatMoney({ amountMinor: '129900', currency: 'USD', scale: 2 })).toBe(
      'USD 1299.00'
    );
    expect(routing.formatMoney({ amountMinor: '5', currency: 'USD', scale: 6 })).toBe(
      'USD 0.000005'
    );
    expect(
      routing.addMoney(
        { amountMinor: '1500', currency: 'USD', scale: 6 },
        { amountMinor: '2500', currency: 'USD', scale: 6 }
      ).amountMinor
    ).toBe('4000');
  });
});

describe('tui session status', () => {
  it('tracks session, mode, agent state, MCP health, and spend', () => {
    const store = new SessionStatusStore();
    store.setSession('sess-abcdef123456');
    store.setModel('capix/auto');
    store.setMode('plan');
    store.setAgentState('deploying');
    store.setMcpHealth({
      state: 'connected',
      toolCount: 42,
      lastCheckedAt: '2026-07-18T12:00:00Z',
      restartCount: 0,
    });
    store.recordSpend('1500', 'USD', 6);
    store.recordSpend('2500', 'USD', 6);
    // Mismatched currency/scale is never summed into the total.
    store.recordSpend('9999', 'EUR', 2);

    const snap = store.snapshot();
    expect(snap.spend).toEqual({ amountMinor: '4000', currency: 'USD', scale: 6 });
    expect(renderStatusLine(snap)).toBe(
      'capix/auto · plan · deploying #sess-abc │ mcp connected (42 tools) │ USD 0.004000 spent'
    );
  });

  it('notifies subscribers on change', () => {
    const store = new SessionStatusStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.agentState));
    store.setAgentState('planning');
    store.setAgentState('executing');
    unsubscribe();
    store.setAgentState('idle');
    expect(seen).toEqual(['planning', 'executing']);
  });
});
