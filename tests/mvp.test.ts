import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialBroker } from '../src/broker.js';
import * as intelligence from '../src/intelligence-client.js';
import { Deployer } from '../src/planner/deploy.js';
import { FullSolutionPlanner } from '../src/planner/full-solution.js';
import { MvpDeployer, MvpPlanner, slugify } from '../src/planner/mvp.js';
import * as routing from '../src/routing-client.js';

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

function stubQuotingFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse()))
  );
}

/** Fetch mock covering quote → commit → poll-to-running for deploys. */
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
          summary: 'workload, us-east',
          state,
          region: 'us-east',
          trustTier: 'verified',
          endpoints: [{ url: 'https://invoice-tracker.capix.app', protocol: 'https' }],
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

const SPEC_RESPONSE = `NAME: invoice-tracker
SUMMARY: Invoicing SaaS for freelancers with online payments.
AUTH: magic-link
REGION: eu-central
FEATURE: create and send invoices
FEATURE: online payments
FEATURE: payment reminders`;

describe('mvp planner', () => {
  it('produces a full MVP plan: Next.js frontend, Postgres, auth, deployment-ready', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const planner = new MvpPlanner();
    const mvp = await planner.design('Build me a SaaS for tracking invoices');

    expect(mvp.architecture.status).toBe('awaiting-approval');

    // Next.js frontend as a website workload.
    const web = mvp.architecture.workloads.find((w) => w.name === 'web')!;
    expect(web.spec).toMatchObject({ kind: 'website', buildCommand: 'npm run build' });

    // Auth service (signup/login) as a container workload.
    const auth = mvp.architecture.workloads.find((w) => w.name === 'auth')!;
    expect(auth.spec).toMatchObject({ kind: 'container_service', port: 8080 });

    // Postgres database, declared as both datastore and workload.
    expect(mvp.architecture.dataStores).toEqual([
      { name: 'db', engine: 'postgres', purpose: 'system of record' },
    ]);
    const db = mvp.architecture.workloads.find((w) => w.name === 'db')!;
    expect(db.spec).toMatchObject({
      kind: 'container_service',
      image: 'registry.capix.dev/postgres:16',
      port: 5432,
    });

    // Every workload got a live quote; the estimate sums integer minor units.
    const quoteCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/route/quote')
    );
    expect(quoteCalls).toHaveLength(3);
    expect(mvp.architecture.costEstimate?.total).toEqual({
      amountMinor: '4500',
      currency: 'USD',
      scale: 6,
    });

    // Heuristic spec is labelled as such.
    expect(mvp.spec.assumptions.join(' ')).toContain('heuristic');
  });

  it('parses the model spec protocol into an MvpSpec', async () => {
    stubQuotingFetch();

    const planner = new MvpPlanner(async () => SPEC_RESPONSE);
    const mvp = await planner.design('Build me a SaaS for tracking invoices');

    expect(mvp.spec).toMatchObject({
      name: 'invoice-tracker',
      summary: 'Invoicing SaaS for freelancers with online payments.',
      auth: 'magic-link',
      region: 'eu-central',
      features: ['create and send invoices', 'online payments', 'payment reminders'],
    });
    // The spec region propagates plan-wide and the name brands the web domain.
    expect(mvp.architecture.region).toBe('eu-central');
    const web = mvp.architecture.workloads.find((w) => w.name === 'web')!;
    expect(web.spec).toMatchObject({ domains: ['invoice-tracker.capix.app'] });
  });

  it('falls back to a heuristic spec when the model invocation fails', async () => {
    stubQuotingFetch();

    const planner = new MvpPlanner(async () => {
      throw new Error('model unavailable');
    });
    const mvp = await planner.design('Build me a booking SaaS for salons');

    expect(mvp.spec.features).toContain('scheduling and booking');
    expect(mvp.spec.assumptions.join(' ')).toContain('heuristic');
    expect(mvp.architecture.status).toBe('awaiting-approval');
  });

  it('slugify derives url-safe product names', () => {
    expect(slugify('Invoice Tracker!')).toBe('invoice-tracker');
    expect(slugify('  My  SaaS__App  ')).toBe('my-saas-app');
    expect(slugify('!!!')).toBe('mvp');
  });
});

describe('mvp deployer', () => {
  async function approvedMvp() {
    const planner = new MvpPlanner(async () => SPEC_RESPONSE);
    const mvp = await planner.design('Build me a SaaS for tracking invoices');
    planner.approve(mvp.architecture.id);
    return { planner, mvp };
  }

  it('refuses to deploy a plan that is not approved', async () => {
    stubQuotingFetch();
    const planner = new MvpPlanner(async () => SPEC_RESPONSE);
    const mvp = await planner.design('Build me a SaaS');

    const deployer = new MvpDeployer(planner);
    await expect(deployer.deploy(mvp, { skipCovenantCheck: true })).rejects.toThrow(/approve/);
  });

  it('deploys the MVP and returns URL, admin access, and cost tracking', async () => {
    vi.stubGlobal('fetch', deployFetchMock(['provisioning', 'running']));
    const { planner, mvp } = await approvedMvp();

    const deployer = new MvpDeployer(planner);
    const result = await deployer.deploy(mvp, {
      skipCovenantCheck: true,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('deployed');
    expect(result.deploy.workloads).toHaveLength(3);
    expect(result.deploy.workloads.every((w) => w.state === 'running')).toBe(true);

    // Product URL comes from the web workload's endpoint.
    expect(result.url).toBe('https://invoice-tracker.capix.app');

    // Admin access: owner bootstrap credential + console path, derived from URL.
    expect(result.adminAccess.email).toBe('admin@invoice-tracker.capix.app');
    expect(result.adminAccess.consolePath).toBe('/admin');
    expect(result.adminAccess.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{12}$/);

    // End users can signup, login, and use the spec features on day one.
    expect(result.capabilities).toEqual([
      'signup',
      'login',
      'create and send invoices',
      'online payments',
      'payment reminders',
    ]);

    // Cost tracking sums per-workload spend in integer minor units.
    expect(result.spendToDate).toEqual({ amountMinor: '12600', currency: 'USD', scale: 6 });

    // Plan status transitioned through the architect.
    expect(planner.getArchitect()?.getCurrentPlan()?.status).toBe('deployed');
  });

  it('returns null URL and spend when the deploy fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/route/quote')) {
          return jsonResponse(routeQuoteResponse({ candidates: [] }));
        }
        if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ id: 'evt_1' });
        return jsonResponse({}, 404);
      })
    );
    const { planner, mvp } = await approvedMvp();

    const deployer = new MvpDeployer(planner);
    const result = await deployer.deploy(mvp, { skipCovenantCheck: true, pollIntervalMs: 1 });

    expect(result.status).toBe('failed');
    expect(result.url).toBeNull();
    expect(result.spendToDate).toBeNull();
    // Admin access is still well-formed from the spec slug.
    expect(result.adminAccess.email).toBe('admin@invoice-tracker.capix.app');
  });
});

describe('full-solution planner', () => {
  let mvpDir: string;

  async function makeMvpDir() {
    mvpDir = await mkdtemp(join(tmpdir(), 'capix-mvp-'));
    await writeFile(
      join(mvpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '14.0.0', react: '18.0.0', pg: '8.11.0', 'next-auth': '4.24.0' },
      })
    );
    await mkdir(join(mvpDir, 'prisma'), { recursive: true });
    await writeFile(join(mvpDir, 'prisma/schema.prisma'), 'model User { id Int @id }');
    return mvpDir;
  }

  afterEach(async () => {
    if (mvpDir) await rm(mvpDir, { recursive: true, force: true });
  });

  it('analyzes an existing MVP directory locally', async () => {
    const dir = await makeMvpDir();
    const planner = new FullSolutionPlanner();

    const analysis = await planner.analyze(dir);

    expect(analysis.root).toBe(dir);
    expect(analysis.stack).toEqual(expect.arrayContaining(['next.js', 'react', 'postgres']));
    expect(analysis.hasAuth).toBe(true);
    expect(analysis.hasDatabase).toBe(true);
    expect(analysis.notableFiles).toEqual(
      expect.arrayContaining(['package.json', 'prisma/schema.prisma'])
    );
  });

  it('throws when the MVP directory is unreadable', async () => {
    const planner = new FullSolutionPlanner();
    await expect(planner.analyze(join(tmpdir(), 'capix-does-not-exist-xyz'))).rejects.toThrow(
      /not a readable MVP directory/
    );
  });

  it('produces a production architecture: microservices, caching, CDN, monitoring', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(routeQuoteResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const dir = await makeMvpDir();

    const planner = new FullSolutionPlanner();
    const solution = await planner.design('Scale this', { fromMvp: dir });

    expect(solution.analysis.stack).toContain('next.js');
    expect(solution.architecture.status).toBe('awaiting-approval');

    const byName = new Map(solution.architecture.workloads.map((w) => [w.name, w]));
    // Microservices: web tier, API, background worker.
    expect(byName.get('web')?.spec).toMatchObject({ kind: 'website', sourceRef: dir });
    expect(byName.get('api')?.spec).toMatchObject({ kind: 'container_service', replicas: 3 });
    expect(byName.get('worker')?.spec).toMatchObject({ kind: 'container_service', replicas: 2 });
    // Caching, database, monitoring.
    expect(byName.get('cache')?.spec).toMatchObject({
      kind: 'container_service',
      image: 'registry.capix.dev/redis:7',
    });
    expect(byName.get('db')?.spec).toMatchObject({
      kind: 'container_service',
      image: 'registry.capix.dev/postgres:16',
    });
    expect(byName.get('monitor')?.spec).toMatchObject({
      kind: 'container_service',
      image: 'registry.capix.dev/observability:latest',
    });

    // CDN edge + detected stack are stated, not hidden.
    expect(solution.architecture.summary).toContain('CDN edge');
    expect(solution.architecture.assumptions.join(' ')).toContain('next.js');

    // Live quotes for all six workloads; estimate sums integer minor units.
    const quoteCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/route/quote')
    );
    expect(quoteCalls).toHaveLength(6);
    expect(solution.architecture.costEstimate?.total).toEqual({
      amountMinor: '9000',
      currency: 'USD',
      scale: 6,
    });
  });

  it('provisions the full infrastructure through the standard deployer', async () => {
    vi.stubGlobal('fetch', deployFetchMock(['provisioning', 'running']));
    const dir = await makeMvpDir();

    const planner = new FullSolutionPlanner();
    const solution = await planner.design('Scale this', { fromMvp: dir });
    planner.approve(solution.architecture.id);

    const deployer = new Deployer(planner.getArchitect() ?? undefined);
    const result = await deployer.deploy(solution.architecture, {
      skipCovenantCheck: true,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('deployed');
    expect(result.workloads).toHaveLength(6);
    expect(result.workloads.every((w) => w.state === 'running')).toBe(true);
    expect(planner.getArchitect()?.getCurrentPlan()?.status).toBe('deployed');
  });
});
