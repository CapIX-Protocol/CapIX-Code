import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import * as intelligence from '../src/intelligence-client.js';
import {
  Sandpit,
  sandpitJobCommand,
  type SandpitProgressEvent,
} from '../src/planner/sandpit.js';
import * as routing from '../src/routing-client.js';
import type { Deployment, DeploymentState, Money, RouteQuote } from '../src/routing-client.js';
import { createSandpitTools } from '../src/tools/sandpit-tools.js';

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

function money(amountMinor: string): Money {
  return { amountMinor, currency: 'USD', scale: 2 };
}

async function makeSource(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capix-sandpit-test-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'index.ts'), 'export const answer = 42;\n');
  return dir;
}

function deployment(id: string, overrides: Partial<Deployment> = {}): Deployment {
  const { customerView, ...rest } = overrides;
  const state: DeploymentState = overrides.state ?? 'provisioning';
  return {
    deploymentId: id,
    projectId: 'prj_1',
    spec: {
      kind: 'container_service',
      name: id,
      image: 'capix/sandpit-runtime:latest',
      port: 8080,
      region: 'global',
      trustTier: 'verified',
    },
    state,
    meteringUnit: 'wallclock_second',
    customerView: {
      summary: `${id} summary`,
      state,
      region: 'global',
      trustTier: 'verified',
      spendToDate: money('0'),
      ...customerView,
    },
    createdAt: '2026-07-18T12:00:00Z',
    updatedAt: '2026-07-18T12:00:00Z',
    ...rest,
  };
}

function quote(kind: string): RouteQuote {
  return {
    routeQuoteId: `rq_${kind}`,
    quoteToken: `qt_${kind}`,
    specHash: 'hash',
    normalizedSpec: { kind: 'inference_request', modelId: 'stub' } as RouteQuote['normalizedSpec'],
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
        region: 'global',
        trustTier: 'verified',
        capabilities: ['containers'],
        pricePerUnit: money('1'),
        meteringUnit: 'wallclock_second',
        score: 0.9,
        scoreBreakdown: { price: 0.9, latency: 0.9, reliability: 0.9, evidence: 0.9, utilization: 0.9 },
      },
    ],
    issuedAt: '2026-07-18T12:00:00Z',
    expiresAt: '2026-07-18T12:05:00Z',
  };
}

interface MockConfig {
  covenantDecision?: 'allow' | 'deny';
  containerStates?: Array<Partial<Deployment>>;
  jobStates?: Array<Partial<Deployment>>;
  destroyedStates?: Array<Partial<Deployment>>;
  jobSummaries?: string[];
}

/**
 * Fetch stub: covenant allows, quote/commit walk the router flow, deployment
 * polls return the configured state sequences, DELETE destroys, intelligence
 * POSTs (hook events / receipts) are accepted.
 */
function sandpitFetchMock(config: MockConfig = {}) {
  const containerStates = config.containerStates ?? [
    { state: 'provisioning' as const },
    { state: 'running' as const, customerView: { spendToDate: money('100') } },
  ];
  const jobStates = config.jobStates ?? [
    { state: 'starting' as const },
    { state: 'stopped' as const, customerView: { spendToDate: money('25') } },
  ];
  const destroyedStates = config.destroyedStates ?? [
    { state: 'destroying' as const },
    { state: 'destroyed' as const, customerView: { spendToDate: money('40') } },
  ];

  let jobCounter = 0;
  const polls = new Map<string, number>();
  const destroyed = new Set<string>();
  const receiptCalls: unknown[] = [];
  const quotes: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/covenants/check-permission')) {
      return jsonResponse({ decision: config.covenantDecision ?? 'allow' });
    }
    if (url.endsWith('/route/quote') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      quotes.push({ kind: body.spec.kind, body });
      return jsonResponse(quote(body.spec.kind));
    }
    if (url.endsWith('/route/commit') && method === 'POST') {
      const { quoteToken } = JSON.parse(String(init?.body));
      const kind = String(quoteToken).replace(/^qt_/, '');
      const deploymentId =
        kind === 'container_service' ? 'dep_container' : `dep_job_${++jobCounter}`;
      return jsonResponse({
        routeReceiptId: `rr_${deploymentId}`,
        routeQuoteId: `rq_${kind}`,
        committedCandidate: quote(kind).candidates[0],
        committedAt: '2026-07-18T12:00:01Z',
        deploymentId,
      });
    }
    if (url.includes('/deployments/') && method === 'DELETE') {
      const id = decodeURIComponent(url.split('/deployments/')[1]);
      destroyed.add(id);
      return jsonResponse(deployment(id, { state: 'destroying' }));
    }
    if (url.includes('/deployments/') && method === 'GET') {
      const id = decodeURIComponent(url.split('/deployments/')[1].split('?')[0]);
      const poll = polls.get(id) ?? 0;
      polls.set(id, poll + 1);
      const sequence = destroyed.has(id)
        ? destroyedStates
        : id === 'dep_container'
          ? containerStates
          : jobStates;
      const overrides = sequence[Math.min(poll, sequence.length - 1)];
      const jobIndex = id.startsWith('dep_job_') ? Number(id.split('_')[2]) - 1 : -1;
      const summary =
        jobIndex >= 0 && overrides.state === 'stopped'
          ? (config.jobSummaries?.[jobIndex] ?? `${id} done`)
          : undefined;
      return jsonResponse(
        deployment(id, {
          ...overrides,
          customerView: {
            summary: summary ?? `${id} summary`,
            state: overrides.state ?? 'provisioning',
            region: 'global',
            trustTier: 'verified',
            spendToDate: money('0'),
            ...overrides.customerView,
          },
        })
      );
    }
    if (url.endsWith('/receipts') && method === 'POST') {
      receiptCalls.push(init?.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ id: 'rcp_1' });
    }
    if (method === 'POST') return jsonResponse({ id: 'evt_1' });
    return jsonResponse({}, 404);
  });
  return { fetchMock, receiptCalls, quotes };
}

describe('sandpit', () => {
  it('creates an isolated container with the source mounted and tracks the session', async () => {
    const sourcePath = await makeSource();
    const { fetchMock, quotes } = sandpitFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const events: SandpitProgressEvent[] = [];
    const sandpit = new Sandpit();
    const result = await sandpit.create({
      sourcePath,
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('running');
    expect(result.sandpitId).toMatch(/^sp_[0-9a-f]{16}$/);
    expect(result.deploymentId).toBe('dep_container');
    expect(result.spendToDate).toEqual(money('100'));

    const session = sandpit.get(result.sandpitId!)!;
    expect(session.state).toBe('running');
    expect(session.sourcePath).toBe(sourcePath);
    expect(sandpit.list()).toHaveLength(1);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('validating');
    expect(types).toContain('quoting');
    expect(types).toContain('quoted');
    expect(types).toContain('committing');
    expect(types).toContain('committed');
    expect(types).toContain('state');
    expect(types[types.length - 1]).toBe('ready');

    // The quoted spec mounts the fingerprinted source and labels the sandpit.
    expect(quotes).toHaveLength(1);
    const spec = quotes[0].body.spec as {
      kind: string;
      env: Record<string, string>;
      labels: Record<string, string>;
    };
    expect(spec.kind).toBe('container_service');
    expect(spec.env.CAPIX_SANDPIT_ID).toBe(result.sandpitId);
    expect(spec.env.CAPIX_SOURCE_REF).toMatch(/^file:\/\/.*#sha256=[0-9a-f]{64}$/);
    expect(spec.labels['capix.dev/sandpit']).toBe(result.sandpitId);
  });

  it('fails without any network call when the source path is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const events: SandpitProgressEvent[] = [];
    const sandpit = new Sandpit();
    const result = await sandpit.create({
      sourcePath: join(tmpdir(), 'definitely-not-here-capix-sandpit'),
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['validating', 'failed']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the covenant denies infra:deploy', async () => {
    const sourcePath = await makeSource();
    const { fetchMock, quotes } = sandpitFetchMock({ covenantDecision: 'deny' });
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const result = await sandpit.create({ sourcePath, pollIntervalMs: 5 });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('infra:deploy denied');
    expect(quotes).toHaveLength(0);
  });

  it('runs refactor, review, and test as labeled serverless jobs and accumulates spend', async () => {
    const sourcePath = await makeSource();
    const { fetchMock, quotes } = sandpitFetchMock({
      jobSummaries: ['extracted billing into a service', '2 findings, 0 critical', '48 passed, 0 failed'],
    });
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const created = await sandpit.create({ sourcePath, pollIntervalMs: 5 });
    const sandpitId = created.sandpitId!;

    const events: SandpitProgressEvent[] = [];
    const refactor = await sandpit.refactor({
      sandpitId,
      instruction: 'extract this into a service',
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });
    expect(refactor.status).toBe('succeeded');
    expect(refactor.action).toBe('refactor');
    expect(refactor.deploymentId).toBe('dep_job_1');
    expect(refactor.summary).toBe('extracted billing into a service');
    expect(refactor.cost).toEqual(money('25'));

    const review = await sandpit.review({ sandpitId, pollIntervalMs: 5 });
    expect(review.status).toBe('succeeded');
    expect(review.summary).toBe('2 findings, 0 critical');

    const test = await sandpit.test({ sandpitId, pollIntervalMs: 5 });
    expect(test.status).toBe('succeeded');
    expect(test.summary).toBe('48 passed, 0 failed');

    // Job lifecycle events fired in order.
    const types = events.map((e) => e.type);
    expect(types.indexOf('job-submitted')).toBeLessThan(types.indexOf('job-finished'));

    // Each job is a serverless_job labeled with the sandpit id and action.
    const jobSpecs = quotes.slice(1).map((q) => q.body.spec) as Array<{
      kind: string;
      command: string[];
      labels: Record<string, string>;
    }>;
    expect(jobSpecs.map((s) => s.kind)).toEqual([
      'serverless_job',
      'serverless_job',
      'serverless_job',
    ]);
    expect(jobSpecs[0].command).toEqual(['refactor', '--instruction', 'extract this into a service']);
    expect(jobSpecs[1].command).toEqual(['review', '--security', '--quality']);
    expect(jobSpecs[2].command).toEqual(['test', '--full']);
    expect(jobSpecs.every((s) => s.labels['capix.dev/sandpit'] === sandpitId)).toBe(true);

    // Container spend (100) + three jobs (25 each).
    const session = sandpit.get(sandpitId)!;
    expect(session.jobDeploymentIds).toEqual(['dep_job_1', 'dep_job_2', 'dep_job_3']);
    expect(session.spendToDate).toEqual(money('175'));
  });

  it('requires a non-empty instruction for refactor, without any network call', async () => {
    const sourcePath = await makeSource();
    const { fetchMock, quotes } = sandpitFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const created = await sandpit.create({ sourcePath, pollIntervalMs: 5 });
    const quoteCount = quotes.length;

    const result = await sandpit.refactor({
      sandpitId: created.sandpitId!,
      instruction: '   ',
      pollIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('instruction');
    expect(quotes.length).toBe(quoteCount);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fails actions against an unknown sandpit without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const review = await sandpit.review({ sandpitId: 'sp_nope', pollIntervalMs: 5 });
    expect(review.status).toBe('failed');
    expect(review.error).toContain('unknown sandpit');

    const destroyed = await sandpit.destroy({ sandpitId: 'sp_nope', pollIntervalMs: 5 });
    expect(destroyed.status).toBe('failed');
    expect(destroyed.error).toContain('unknown sandpit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failed job when the deployment enters "failed"', async () => {
    const sourcePath = await makeSource();
    const { fetchMock } = sandpitFetchMock({
      jobStates: [{ state: 'starting' as const }, { state: 'failed' as const }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const created = await sandpit.create({ sourcePath, pollIntervalMs: 5 });
    const result = await sandpit.test({ sandpitId: created.sandpitId!, pollIntervalMs: 5 });

    expect(result.status).toBe('failed');
    expect(result.deploymentId).toBe('dep_job_1');
    expect(result.error).toContain('"failed"');
  });

  it('destroys the sandpit, reports total cost, and forgets the session', async () => {
    const sourcePath = await makeSource();
    const { fetchMock, receiptCalls } = sandpitFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const sandpit = new Sandpit();
    const created = await sandpit.create({ sourcePath, pollIntervalMs: 5 });
    const sandpitId = created.sandpitId!;
    await sandpit.review({ sandpitId, pollIntervalMs: 5 });

    const events: SandpitProgressEvent[] = [];
    const result = await sandpit.destroy({
      sandpitId,
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('destroyed');
    // Container (100) + one job (25) + final container spend (40).
    expect(result.totalCost).toEqual(money('165'));
    expect(sandpit.get(sandpitId)).toBeNull();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('destroying');
    expect(types[types.length - 1]).toBe('destroyed');

    // DELETE hit the container deployment, and a receipt was attempted.
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/deployments/dep_container') &&
          (init as RequestInit)?.method === 'DELETE'
      )
    ).toBe(true);
    await vi.waitFor(() => expect(receiptCalls.length).toBeGreaterThan(0));
    expect(receiptCalls[receiptCalls.length - 1]).toMatchObject({
      kind: 'sandpit-run',
      costMinor: '165',
      asset: 'USD',
      scale: 2,
      outcome: 'success',
      source: 'capix-code:sandpit',
    });
  });
});

describe('sandpit tools', () => {
  it('exposes the five sandpit verbs with billing gates on create/destroy', () => {
    const tools = createSandpitTools(new Sandpit());
    expect(tools.map((t) => t.name)).toEqual([
      'sandpit_create',
      'sandpit_refactor',
      'sandpit_review',
      'sandpit_test',
      'sandpit_destroy',
    ]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('sandpit_create')!.riskClass).toBe('billing');
    expect(byName.get('sandpit_create')!.alwaysRequiresApproval).toBe(true);
    expect(byName.get('sandpit_destroy')!.riskClass).toBe('billing');
    expect(byName.get('sandpit_destroy')!.alwaysRequiresApproval).toBe(true);
    expect(byName.get('sandpit_refactor')!.riskClass).toBe('execute');
  });

  it('runs the full lifecycle through the tools and formats money in output', async () => {
    const sourcePath = await makeSource();
    const { fetchMock } = sandpitFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const tools = new Map(
      createSandpitTools(new Sandpit(), { pollIntervalMs: 5 }).map((t) => [t.name, t])
    );
    const ctx = { sessionId: 's1', turnId: 't1', workspaceRoot: sourcePath };

    const created = await tools.get('sandpit_create')!.execute(
      { source_path: sourcePath },
      ctx
    );
    expect(created.isError).toBeFalsy();
    expect(created.output).toContain('spend to date: USD 1.00');
    const sandpitId = String(created.metadata!.sandpitId);

    const tested = await tools.get('sandpit_test')!.execute({ sandpit_id: sandpitId }, ctx);
    expect(tested.isError).toBeFalsy();
    expect(tested.output).toContain('sandpit test succeeded');
    expect(tested.output).toContain('job cost: USD 0.25');

    const destroyed = await tools.get('sandpit_destroy')!.execute({ sandpit_id: sandpitId }, ctx);
    expect(destroyed.isError).toBeFalsy();
    expect(destroyed.output).toContain('total cost: USD 1.65');
    // No provider identity leaks into customer-facing output.
    for (const output of [created.output, tested.output, destroyed.output]) {
      expect(output).not.toMatch(/aws|gcp|azure|hetzner|vast/i);
    }
  });

  it('returns a tool error when source_path is missing', async () => {
    const tools = new Map(createSandpitTools(new Sandpit()).map((t) => [t.name, t]));
    const result = await tools.get('sandpit_create')!.execute(
      {},
      { sessionId: 's1', turnId: 't1', workspaceRoot: '/tmp' }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('source_path');
  });
});

describe('sandpitJobCommand', () => {
  it('builds the argv for each action', () => {
    expect(sandpitJobCommand('refactor', 'extract this into a service')).toEqual([
      'refactor',
      '--instruction',
      'extract this into a service',
    ]);
    expect(sandpitJobCommand('review')).toEqual(['review', '--security', '--quality']);
    expect(sandpitJobCommand('test')).toEqual(['test', '--full']);
  });
});
