/**
 * Full solution — scales an existing MVP into a production architecture:
 * microservices, caching, CDN edge, and monitoring, provisioned through the
 * same approval-gated deploy pipeline as any architecture plan.
 *
 * Refs:
 * - planner/architect.ts (architecture protocol, live quotes, approval gate)
 * - planner/deploy.ts (approved plan → workloads via the smart router)
 * - planner/mvp.ts (the MVP this module scales up)
 *
 * Pipeline:
 * 1. analyze — scan the MVP directory locally (package.json dependencies,
 *    notable files) to detect the stack. No network calls; an unreadable
 *    directory fails before anything is planned;
 * 2. design — ask the model for a production architecture using the
 *    architect's text protocol (with the analysis as context), or render a
 *    deterministic production topology when no model is wired. Either way the
 *    protocol goes through the standard `Architect` pipeline, so quotes and
 *    cost estimation behave exactly like a hand-written architecture;
 * 3. deploy — the resulting plan is an ordinary `ArchitecturePlan`:
 *    `capix-code deploy --plan <id>` provisions it with the `Deployer`.
 */

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { logger } from '../logger.js';
import type { Region, TrustTier } from '../routing-client.js';
import { Architect } from './architect.js';
import type { ArchitecturePlan } from './architect.js';
import type { ModelInvoker } from './planner.js';

// ── MVP analysis ─────────────────────────────────────────────────────────────

export interface MvpAnalysis {
  /** Absolute path of the scanned MVP directory. */
  root: string;
  /** Detected stack elements, e.g. ["next.js", "react", "postgres"]. */
  stack: string[];
  hasAuth: boolean;
  hasDatabase: boolean;
  /** Notable files/dirs found, relative to root. */
  notableFiles: string[];
}

export interface FullSolutionPlan {
  analysis: MvpAnalysis;
  scaleIntent: string;
  /** The production architecture (microservices, cache, CDN edge, monitoring). */
  architecture: ArchitecturePlan;
}

/** Dependency name pattern → stack element. */
const STACK_SIGNALS: Array<[RegExp, string]> = [
  [/^next$/, 'next.js'],
  [/^react$/, 'react'],
  [/^vue$/, 'vue'],
  [/^express$/, 'express'],
  [/^fastify$/, 'fastify'],
  [/^(pg|postgres|postgresql|prisma|@prisma\/client)$/, 'postgres'],
  [/^(mysql|mysql2)$/, 'mysql'],
  [/^(redis|ioredis)$/, 'redis'],
];

const AUTH_DEP_SIGNAL = /^(next-auth|@auth\/.+|passport|@clerk\/.+|jsonwebtoken|lucia)$/;

/** Files/dirs that say something about the MVP's shape, relative to root. */
const NOTABLE_CANDIDATES = [
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'prisma/schema.prisma',
  'docker-compose.yml',
  'compose.yml',
  'app',
  'pages',
  'src/app',
  'src/pages',
  'src/auth.ts',
  'auth.ts',
];

// ── Production architecture prompt ───────────────────────────────────────────

/**
 * The model answers with the architect's exact text protocol (see
 * `architect.ts`) constrained to production topology rules.
 */
const FULL_SOLUTION_SYSTEM_PROMPT = `You are a cloud systems architect for the Capix compute fabric scaling an MVP to production. Convert the scaling intent and MVP analysis into a production architecture using EXACTLY this text protocol. Do not add prose, markdown, or commentary outside the protocol lines.

Output format (emit each header exactly once where noted):
SUMMARY: <one-paragraph architecture summary>
TRUST_TIER: <community | verified | sovereign>
REGION: <us-east | us-west | eu-central | eu-north | ap-southeast | ap-northeast | global>
ASSUMPTIONS: <comma-separated assumptions, or "none">

Then one line per element (repeat as needed):
SERVICE: <name> | <purpose> | <workload name that runs it>
DATASTORE: <name> | <engine> | <purpose>
WORKLOAD: <name> | <kind> | <purpose> | <key=value; key=value; ...>

Workload kinds and their required keys:
- container_service: image, port (optional: replicas, env)
- website: sourceRef (optional: buildCommand, domains)
- serverless_job: image, command (comma-separated argv) (optional: schedule, timeoutSeconds)

Production rules:
- Decompose the monolith into microservices: at minimum a web tier, an API service, and a background worker.
- Always include a redis cache, a postgres system of record, and an observability (metrics/alerting) service.
- Stateless services run at least 2 replicas.
- The web tier is a website workload; static assets are served through the fabric CDN edge.
- Every SERVICE must reference a WORKLOAD by name.`;

// ── Full-solution planner ────────────────────────────────────────────────────

export class FullSolutionPlanner {
  private readonly modelInvoker: ModelInvoker | null;
  private readonly defaultRegion: Region;
  private readonly defaultTrustTier: TrustTier;
  private architect: Architect | null = null;
  private currentPlan: FullSolutionPlan | null = null;

  constructor(
    modelInvoker?: ModelInvoker,
    defaults: { region?: Region; trustTier?: TrustTier } = {}
  ) {
    this.modelInvoker = modelInvoker ?? null;
    this.defaultRegion = defaults.region ?? 'us-east';
    this.defaultTrustTier = defaults.trustTier ?? 'verified';
  }

  /**
   * Scan an MVP directory and detect its stack. Local filesystem only — no
   * network. Throws when the directory is unreadable.
   */
  async analyze(mvpDir: string): Promise<MvpAnalysis> {
    const root = resolve(mvpDir);
    let rootStat;
    try {
      rootStat = await stat(root);
    } catch {
      throw new Error(`full-solution: ${mvpDir} is not a readable MVP directory`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`full-solution: ${mvpDir} is not a directory`);
    }

    const deps = await this.readDependencies(root);
    const stack: string[] = [];
    for (const dep of deps) {
      for (const [pattern, label] of STACK_SIGNALS) {
        if (pattern.test(dep) && !stack.includes(label)) stack.push(label);
      }
    }

    const notableFiles: string[] = [];
    for (const candidate of NOTABLE_CANDIDATES) {
      try {
        await stat(join(root, candidate));
        notableFiles.push(candidate);
      } catch {
        // Not present — fine.
      }
    }

    const hasAuth =
      deps.some((d) => AUTH_DEP_SIGNAL.test(d)) ||
      notableFiles.some((f) => /auth/i.test(f));
    const hasDatabase =
      stack.some((s) => s === 'postgres' || s === 'mysql') ||
      notableFiles.includes('prisma/schema.prisma');

    return { root, stack, hasAuth, hasDatabase, notableFiles };
  }

  /**
   * Design a production architecture for the MVP at `opts.fromMvp`. The plan
   * lands in `awaiting-approval` with live quotes attached, ready for
   * `capix-code deploy --plan <id>` once approved.
   */
  async design(
    scaleIntent: string,
    opts: { fromMvp: string; signal?: AbortSignal; projectId?: string }
  ): Promise<FullSolutionPlan> {
    const analysis = await this.analyze(opts.fromMvp);
    const response = await this.architectResponse(scaleIntent, analysis, opts.signal);

    // Feed the protocol through the standard Architect pipeline: parsing,
    // spec normalization, live router quotes, and cost estimation are
    // identical to a hand-written architecture.
    const architect = new Architect(async () => response, {
      region: this.defaultRegion,
      trustTier: this.defaultTrustTier,
    });
    const architecture = await architect.design(scaleIntent, {
      signal: opts.signal,
      projectId: opts.projectId,
    });

    this.architect = architect;
    this.currentPlan = { analysis, scaleIntent, architecture };
    return this.currentPlan;
  }

  /** Mark the current plan approved so the deployer will accept it. */
  approve(planId: string): FullSolutionPlan {
    if (!this.architect || !this.currentPlan) {
      throw new Error('full-solution: no current plan to approve');
    }
    this.architect.approve(planId);
    return this.currentPlan;
  }

  /** The architect holding the current plan (for status updates on deploy). */
  getArchitect(): Architect | null {
    return this.architect;
  }

  getCurrentPlan(): FullSolutionPlan | null {
    return this.currentPlan;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Model-driven protocol when wired; deterministic topology otherwise. */
  private async architectResponse(
    scaleIntent: string,
    analysis: MvpAnalysis,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.modelInvoker) {
      return renderFullSolutionArchitecture(scaleIntent, analysis, this.defaultRegion, [
        'no model invoker configured; architecture is a deterministic production topology',
      ]);
    }

    const prompt = [
      FULL_SOLUTION_SYSTEM_PROMPT,
      '',
      '## MVP analysis',
      `stack: ${analysis.stack.length > 0 ? analysis.stack.join(', ') : 'unknown'}`,
      `auth: ${analysis.hasAuth ? 'present' : 'none detected'}`,
      `database: ${analysis.hasDatabase ? 'present' : 'none detected'}`,
      `notable files: ${analysis.notableFiles.join(', ') || 'none'}`,
      '',
      '## Scaling intent',
      scaleIntent,
      '',
      'Produce the production architecture now using the protocol above.',
    ].join('\n');

    try {
      return await this.modelInvoker(prompt, { signal });
    } catch (err) {
      logger.warn('full-solution: model invocation failed, using deterministic topology', {
        error: (err as Error)?.message,
      });
      return renderFullSolutionArchitecture(scaleIntent, analysis, this.defaultRegion, [
        'model invocation failed; architecture is a deterministic production topology',
      ]);
    }
  }

  /** Read dependency names from package.json; empty when absent/unparseable. */
  private async readDependencies(root: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(join(root, 'package.json'), 'utf8');
    } catch {
      return [];
    }
    try {
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
    } catch {
      logger.warn('full-solution: package.json is not valid JSON; stack detection limited');
      return [];
    }
  }
}

/**
 * Deterministic production topology for a scanned MVP: web tier behind the
 * CDN edge, API + worker microservices, redis cache, postgres, observability.
 */
function renderFullSolutionArchitecture(
  scaleIntent: string,
  analysis: MvpAnalysis,
  region: Region,
  extraAssumptions: string[] = []
): string {
  const assumptions = [
    `detected stack: ${analysis.stack.length > 0 ? analysis.stack.join(', ') : 'unknown'}`,
    ...extraAssumptions,
  ];
  const lines = [
    `SUMMARY: Production architecture scaling the MVP at ${analysis.root}: web tier behind the CDN edge, API and worker microservices, redis cache, postgres system of record, and observability.`,
    'TRUST_TIER: verified',
    `REGION: ${region}`,
    `ASSUMPTIONS: ${assumptions.join(', ')}`,
    'SERVICE: web | web tier serving the frontend through the CDN edge | web',
    'SERVICE: api | product API microservice | api',
    'SERVICE: worker | background jobs microservice | worker',
    'SERVICE: cache | redis cache for sessions and hot reads | cache',
    'SERVICE: monitor | metrics, alerting, and uptime monitoring | monitor',
    'DATASTORE: db | postgres | system of record',
    `WORKLOAD: web | website | frontend behind CDN edge | sourceRef=${analysis.root}; buildCommand=npm run build`,
    'WORKLOAD: api | container_service | product API microservice | image=registry.capix.dev/mvp-api:latest; port=8080; replicas=3',
    'WORKLOAD: worker | container_service | background jobs | image=registry.capix.dev/mvp-worker:latest; port=8081; replicas=2',
    'WORKLOAD: cache | container_service | redis cache | image=registry.capix.dev/redis:7; port=6379; replicas=1',
    'WORKLOAD: db | container_service | postgres database | image=registry.capix.dev/postgres:16; port=5432; replicas=1',
    'WORKLOAD: monitor | container_service | metrics and alerting | image=registry.capix.dev/observability:latest; port=9090; replicas=1',
  ];
  return lines.join('\n');
}
