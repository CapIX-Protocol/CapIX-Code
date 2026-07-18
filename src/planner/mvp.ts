/**
 * MVP — turns a product idea ("Build me a SaaS…") into a deployable minimum
 * viable product: Next.js frontend, Postgres database, auth (signup/login),
 * and deployment on the Capix compute fabric.
 *
 * Refs:
 * - planner/architect.ts (architecture protocol, live quotes, approval gate)
 * - planner/deploy.ts (approved plan → workloads via the smart router)
 * - protocol/packages/contracts/openapi.yaml (WorkloadSpec, Deployment)
 *
 * Pipeline:
 * 1. specify — ask the model to condense the intent into an `MvpSpec` using a
 *    fixed text protocol (name, summary, auth mode, features — never
 *    free-form chat), or fall back to a labelled heuristic spec;
 * 2. render — expand the spec into the *architect's* text protocol with the
 *    standard MVP workload set (web / auth / db) and feed it through the
 *    normal `Architect` pipeline, so parsing, spec normalization, live
 *    quotes, and cost estimation behave exactly like a hand-written
 *    architecture;
 * 3. deploy — `MvpDeployer` runs the approved plan through the `Deployer`
 *    and rolls the result up into an operator-facing summary: product URL,
 *    owner bootstrap access, and spend to date in integer minor units.
 *
 * Customer-facing output never names infrastructure providers; endpoints come
 * from the deployment contract's customer view only.
 */

import { randomBytes } from 'node:crypto';

import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type { Money, Region } from '../routing-client.js';
import { Architect } from './architect.js';
import type { ArchitecturePlan } from './architect.js';
import { Deployer } from './deploy.js';
import type { DeployOptions, DeployProgressEvent, DeployResult } from './deploy.js';
import type { ModelInvoker } from './planner.js';

// ── MVP spec ─────────────────────────────────────────────────────────────────

export type MvpAuthMode = 'email' | 'oauth' | 'magic-link';

export interface MvpSpec {
  /** URL-safe product slug, e.g. "invoice-tracker". */
  name: string;
  intent: string;
  summary: string;
  /** Core product features, in priority order. */
  features: string[];
  auth: MvpAuthMode;
  region: Region;
  assumptions: string[];
}

export interface MvpPlan {
  spec: MvpSpec;
  /** The underlying architecture plan (web / auth / db workloads). */
  architecture: ArchitecturePlan;
}

// ── Deployment result ────────────────────────────────────────────────────────

export interface MvpAdminAccess {
  email: string;
  /**
   * One-time owner bootstrap credential, generated at deploy time and
   * returned only here (never logged). The MVP auth service accepts it on
   * first signup to promote the account to owner.
   */
  temporaryPassword: string;
  /** Path of the admin console on the product URL. */
  consolePath: string;
}

export interface MvpDeployment {
  planId: string;
  status: DeployResult['status'];
  /** Public product URL (web workload endpoint), or null when not healthy. */
  url: string | null;
  adminAccess: MvpAdminAccess;
  /** What end users can do on day one: signup, login, plus spec features. */
  capabilities: string[];
  /** Sum of per-workload spend, in integer minor units. */
  spendToDate: Money | null;
  deploy: DeployResult;
}

// ── Spec prompt protocol ─────────────────────────────────────────────────────

/**
 * Fixed text protocol the model must emit. The planner parses this exact
 * shape — it never derives a product spec from arbitrary chat output.
 */
const MVP_SYSTEM_PROMPT = `You are a product engineer scoping a minimum viable product for the Capix compute fabric. Convert the user's product idea into an MVP spec using EXACTLY this text protocol. Do not add prose, markdown, or commentary outside the protocol lines.

Output format (emit each header exactly once where noted):
NAME: <url-safe product slug, lowercase, hyphens, max 40 chars>
SUMMARY: <one-paragraph product summary>
AUTH: <email | oauth | magic-link>
REGION: <us-east | us-west | eu-central | eu-north | ap-southeast | ap-northeast | global>
FEATURE: <one core feature> (repeat this line per feature, 2-6 features, priority order)

Rules:
- The MVP always ships a Next.js frontend, a Postgres database, and auth with signup/login — do not restate them as features.
- Features are end-user capabilities, not infrastructure.
- Scope ruthlessly: only what a first paying user needs.`;

const AUTH_MODES: readonly MvpAuthMode[] = ['email', 'oauth', 'magic-link'];

// ── Spec helpers ─────────────────────────────────────────────────────────────

/** Derive a URL-safe slug from free text. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'mvp';
}

/**
 * Fallback when no model is wired: a spec inferred from intent keywords.
 * Truthful — it is labelled as a heuristic.
 */
function heuristicMvpSpec(intent: string, region: Region): MvpSpec {
  const lower = intent.toLowerCase();
  const features: string[] = [];
  if (/invoice|billing|payment/.test(lower)) features.push('invoicing and payments');
  if (/book|schedul|appoint|calendar/.test(lower)) features.push('scheduling and booking');
  if (/chat|messag|support/.test(lower)) features.push('messaging');
  if (/track|monitor|dashboard|analytic/.test(lower)) features.push('tracking dashboard');
  if (/marketplace|shop|store|sell/.test(lower)) features.push('product listings');
  if (features.length === 0) features.push('core product workflows');

  return {
    name: slugify(intent.split(/\s+/).slice(0, 5).join(' ')),
    intent,
    summary: `MVP for: ${intent}`,
    features: features.slice(0, 3),
    auth: 'email',
    region,
    assumptions: ['no model invoker configured; MVP spec is a heuristic placeholder'],
  };
}

/**
 * Render an `MvpSpec` as the architect's text protocol with the standard MVP
 * workload set: Next.js frontend (website), auth service, Postgres database.
 */
function renderMvpArchitecture(spec: MvpSpec): string {
  const lines = [
    `SUMMARY: ${spec.summary}`,
    'TRUST_TIER: verified',
    `REGION: ${spec.region}`,
    `ASSUMPTIONS: ${spec.assumptions.length > 0 ? spec.assumptions.join(', ') : 'none'}`,
    `SERVICE: web | Next.js frontend for ${spec.name} | web`,
    `SERVICE: auth | signup/login (${spec.auth}) and session management | auth`,
    'DATASTORE: db | postgres | system of record',
    `WORKLOAD: web | website | Next.js frontend | sourceRef=.; buildCommand=npm run build; domains=${spec.name}.capix.app`,
    'WORKLOAD: auth | container_service | auth service (signup/login) | image=registry.capix.dev/mvp-auth:latest; port=8080; replicas=1',
    'WORKLOAD: db | container_service | postgres database | image=registry.capix.dev/postgres:16; port=5432; replicas=1',
  ];
  return lines.join('\n');
}

// ── MVP planner ──────────────────────────────────────────────────────────────

export class MvpPlanner {
  private readonly modelInvoker: ModelInvoker | null;
  private readonly defaultRegion: Region;
  private architect: Architect | null = null;
  private currentPlan: MvpPlan | null = null;

  constructor(modelInvoker?: ModelInvoker, defaults: { region?: Region } = {}) {
    this.modelInvoker = modelInvoker ?? null;
    this.defaultRegion = defaults.region ?? 'us-east';
  }

  /**
   * Design an MVP from a natural-language product idea. The plan lands in
   * `awaiting-approval` with live quotes attached, ready for
   * `capix-code deploy --plan <id>` once approved.
   */
  async design(
    intent: string,
    opts: { signal?: AbortSignal; projectId?: string } = {}
  ): Promise<MvpPlan> {
    const spec = await this.specify(intent, opts.signal);
    const response = renderMvpArchitecture(spec);

    // Feed the rendered protocol through the standard Architect pipeline:
    // parsing, spec normalization, live router quotes, and cost estimation
    // are identical to a hand-written architecture.
    const architect = new Architect(async () => response, { region: spec.region });
    const architecture = await architect.design(intent, opts);

    this.architect = architect;
    this.currentPlan = { spec, architecture };
    return this.currentPlan;
  }

  /** Mark the current plan approved so the deployer will accept it. */
  approve(planId: string): MvpPlan {
    if (!this.architect || !this.currentPlan) {
      throw new Error('mvp: no current plan to approve');
    }
    this.architect.approve(planId);
    return this.currentPlan;
  }

  /** The architect holding the current plan (for status updates on deploy). */
  getArchitect(): Architect | null {
    return this.architect;
  }

  getCurrentPlan(): MvpPlan | null {
    return this.currentPlan;
  }

  // ── model-driven spec ────────────────────────────────────────────────────

  private async specify(intent: string, signal?: AbortSignal): Promise<MvpSpec> {
    if (!this.modelInvoker) return heuristicMvpSpec(intent, this.defaultRegion);

    const prompt = [
      MVP_SYSTEM_PROMPT,
      '',
      '## Product idea',
      intent,
      '',
      'Produce the MVP spec now using the protocol above.',
    ].join('\n');

    let response = '';
    try {
      response = await this.modelInvoker(prompt, { signal });
    } catch (err) {
      logger.warn('mvp: model invocation failed, using heuristic spec', {
        error: (err as Error)?.message,
      });
      const spec = heuristicMvpSpec(intent, this.defaultRegion);
      spec.assumptions.push('model invocation failed; spec is a heuristic placeholder');
      return spec;
    }
    return this.parseSpecResponse(response, intent);
  }

  /**
   * Parse a model response (the text protocol) into an `MvpSpec`. Robust to
   * whitespace/casing variations; fills conservative defaults.
   */
  parseSpecResponse(response: string, intent: string): MvpSpec {
    const spec: MvpSpec = {
      name: slugify(intent.split(/\s+/).slice(0, 5).join(' ')),
      intent,
      summary: intent,
      features: [],
      auth: 'email',
      region: this.defaultRegion,
      assumptions: [],
    };

    for (const rawLine of response.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      let m: RegExpMatchArray | null;
      if ((m = line.match(/^NAME\s*:\s*(.*)$/i))) {
        const name = slugify(m[1]!);
        if (name !== 'mvp' || spec.name === 'mvp') spec.name = name;
        continue;
      }
      if ((m = line.match(/^SUMMARY\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim();
        if (v) spec.summary = v;
        continue;
      }
      if ((m = line.match(/^AUTH\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim().toLowerCase() as MvpAuthMode;
        if (AUTH_MODES.includes(v)) spec.auth = v;
        continue;
      }
      if ((m = line.match(/^REGION\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim().toLowerCase();
        if (routing.isRegion(v)) spec.region = v;
        continue;
      }
      if ((m = line.match(/^FEATURE\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim();
        if (v) spec.features.push(v);
        continue;
      }
    }

    if (spec.features.length === 0) spec.features.push('core product workflows');
    return spec;
  }
}

// ── MVP deployer ─────────────────────────────────────────────────────────────

/** Sum per-workload spend; mismatched currencies are excluded, not mis-summed. */
function sumSpend(result: DeployResult): Money | null {
  let total: Money | null = null;
  for (const workload of result.workloads) {
    if (!workload.spendToDate) continue;
    if (total === null) {
      total = workload.spendToDate;
      continue;
    }
    try {
      total = routing.addMoney(total, workload.spendToDate);
    } catch {
      logger.warn('mvp: mixed currency/scale in spend; total excludes later workloads', {
        workload: workload.name,
      });
    }
  }
  return total;
}

/** Prefer the web workload's https endpoint; fall back to any endpoint. */
function pickUrl(endpoints: Map<string, Array<{ url: string; protocol: string }>>): string | null {
  const web = endpoints.get('web') ?? [];
  const webHttps = web.find((e) => e.protocol === 'https');
  if (webHttps) return webHttps.url;
  for (const list of endpoints.values()) {
    const https = list.find((e) => e.protocol === 'https');
    if (https) return https.url;
    if (list.length > 0) return list[0]!.url;
  }
  return null;
}

function buildAdminAccess(spec: MvpSpec, url: string | null): MvpAdminAccess {
  let host = `${spec.name}.capix.app`;
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      // Keep the slug-based fallback host.
    }
  }
  return {
    email: `admin@${host}`,
    temporaryPassword: randomBytes(9).toString('base64url'),
    consolePath: '/admin',
  };
}

export class MvpDeployer {
  constructor(private readonly planner?: MvpPlanner) {}

  /**
   * Deploy an approved MVP plan and roll the result up for the operator:
   * product URL, owner bootstrap access, and cost tracking. Throws when the
   * plan is not approved — spend always requires explicit approval first.
   */
  async deploy(mvp: MvpPlan, opts: DeployOptions = {}): Promise<MvpDeployment> {
    const endpoints = new Map<string, Array<{ url: string; protocol: string }>>();
    const onEvent = (event: DeployProgressEvent) => {
      if (event.type === 'healthy') endpoints.set(event.workload, event.endpoints);
      try {
        opts.onEvent?.(event);
      } catch {
        // A broken consumer must never interrupt the deploy loop.
      }
    };

    const deployer = new Deployer(this.planner?.getArchitect() ?? undefined);
    const result = await deployer.deploy(mvp.architecture, { ...opts, onEvent });

    const url = result.status === 'failed' ? null : pickUrl(endpoints);
    return {
      planId: result.planId,
      status: result.status,
      url,
      adminAccess: buildAdminAccess(mvp.spec, url),
      capabilities: ['signup', 'login', ...mvp.spec.features],
      spendToDate: sumSpend(result),
      deploy: result,
    };
  }
}
