/**
 * Architect — turns a natural-language intent into a deployable system
 * architecture with live cost quotes.
 *
 * Refs:
 * - architecture (app convergence: one agent runtime across surfaces)
 * - protocol/packages/contracts/openapi.yaml (WorkloadSpec, /route/quote)
 *
 * Pipeline:
 * 1. ask the model to decompose the intent into services, data stores,
 *    models, and infrastructure using a fixed text protocol (the same
 *    protocol-driven approach as `planner.ts` — never free-form chat);
 * 2. parse that protocol into an `ArchitecturePlan`;
 * 3. normalize each planned workload into a contract `WorkloadSpec`
 *    (trust tier + region applied plan-wide);
 * 4. fetch a live, explainable quote for every spec from the smart router
 *    (`routing-client.createRouteQuote`) and roll the best candidates up
 *    into an integer-minor-unit cost estimate.
 *
 * The resulting plan is approval-gated: `deploy.ts` refuses to deploy a plan
 * whose status is not `approved`.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type {
  Money,
  Region,
  RouteQuote,
  TrustTier,
  WorkloadKind,
  WorkloadSpec,
} from '../routing-client.js';
import type { ModelInvoker } from './planner.js';

// ── Plan types ───────────────────────────────────────────────────────────────

export interface ArchitectureService {
  name: string;
  purpose: string;
  /** Name of the workload that runs this service. */
  workload: string;
}

export interface ArchitectureDataStore {
  name: string;
  engine: string;
  purpose: string;
}

export interface ArchitectureModel {
  name: string;
  modelRef: string;
  purpose: string;
}

/** One workload the architecture needs, plus its live quote (when fetched). */
export interface PlannedWorkload {
  name: string;
  kind: WorkloadKind;
  purpose: string;
  /** Kind-specific spec fields (vcpus, image, modelRef, ...). */
  details: Record<string, unknown>;
  spec: WorkloadSpec;
  quote?: RouteQuote;
  quoteError?: string;
}

export interface WorkloadCost {
  name: string;
  /** Best-candidate unit price, or null when no candidate was returned. */
  pricePerUnit: Money | null;
  meteringUnit?: string;
}

export interface ArchitectureCostEstimate {
  /**
   * Sum of best-candidate unit prices across workloads, in integer minor
   * units. Null when no workload produced a candidate price.
   */
  total: Money | null;
  perWorkload: WorkloadCost[];
  /** Quotes are price-locked until this time (earliest expiry wins). */
  quotesExpireAt?: string;
}

export interface ArchitecturePlan {
  id: string;
  intent: string;
  summary: string;
  services: ArchitectureService[];
  dataStores: ArchitectureDataStore[];
  models: ArchitectureModel[];
  workloads: PlannedWorkload[];
  trustTier: TrustTier;
  region: Region;
  costEstimate: ArchitectureCostEstimate | null;
  assumptions: string[];
  status: 'drafting' | 'awaiting-approval' | 'approved' | 'deployed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

// ── Architect prompt protocol ────────────────────────────────────────────────

/**
 * Fixed text protocol the model must emit. The architect parses this exact
 * shape — it never free-forms an architecture from arbitrary chat output.
 */
const ARCHITECT_SYSTEM_PROMPT = `You are a cloud systems architect for the Capix compute fabric. Convert the user's intent into a deployable system architecture using EXACTLY this text protocol. Do not add prose, markdown, or commentary outside the protocol lines.

Output format (emit each header exactly once where noted):
SUMMARY: <one-paragraph architecture summary>
TRUST_TIER: <community | verified | sovereign>
REGION: <us-east | us-west | eu-central | eu-north | ap-southeast | ap-northeast | global>
ASSUMPTIONS: <comma-separated assumptions, or "none">

Then one line per element (repeat as needed):
SERVICE: <name> | <purpose> | <workload name that runs it>
DATASTORE: <name> | <engine> | <purpose>
MODEL: <name> | <model artifact reference> | <purpose>
WORKLOAD: <name> | <kind> | <purpose> | <key=value; key=value; ...>

Workload kinds and their required keys:
- cpu_vm: vcpus, memoryGiB (optional: diskGiB)
- dedicated_gpu: gpuCount, minGpuMemoryGiB (optional: vcpus, memoryGiB)
- private_model: modelRef, minGpuMemoryGiB (optional: maxConcurrentRequests)
- container_service: image, port (optional: replicas, env)
- website: sourceRef (optional: buildCommand, domains)
- serverless_job: image, command (comma-separated argv) (optional: schedule, timeoutSeconds)

Rules:
- Every SERVICE must reference a WORKLOAD by name.
- A MODEL served privately must have a matching private_model WORKLOAD.
- Choose sovereign trust tier only when the intent involves regulated data or secure enclaves.
- Size workloads conservatively; prefer the smallest spec that meets the intent.`;

const VALID_REGION: Region = 'us-east';
const VALID_TRUST_TIER: TrustTier = 'verified';

// ── Spec building ────────────────────────────────────────────────────────────

function intField(details: Record<string, unknown>, key: string): number | undefined {
  const raw = details[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

function strField(details: Record<string, unknown>, key: string): string | undefined {
  const raw = details[key];
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

function listField(details: Record<string, unknown>, key: string): string[] | undefined {
  const raw = details[key];
  if (raw === undefined || raw === null) return undefined;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Normalize a planned workload into a contract `WorkloadSpec`. Fills
 * conservative defaults for missing required fields so a slightly incomplete
 * model response still yields a quotable spec.
 */
export function buildWorkloadSpec(
  name: string,
  kind: WorkloadKind,
  details: Record<string, unknown>,
  region: Region,
  trustTier: TrustTier
): WorkloadSpec {
  const base = { name, region, trustTier };
  switch (kind) {
    case 'cpu_vm':
      return {
        ...base,
        kind,
        vcpus: intField(details, 'vcpus') ?? 2,
        memoryGiB: intField(details, 'memoryGiB') ?? 4,
        diskGiB: intField(details, 'diskGiB'),
      };
    case 'dedicated_gpu':
      return {
        ...base,
        kind,
        gpuCount: intField(details, 'gpuCount') ?? 1,
        minGpuMemoryGiB: intField(details, 'minGpuMemoryGiB') ?? 24,
        vcpus: intField(details, 'vcpus'),
        memoryGiB: intField(details, 'memoryGiB'),
      };
    case 'private_model':
      return {
        ...base,
        kind,
        modelRef: strField(details, 'modelRef') ?? name,
        minGpuMemoryGiB: intField(details, 'minGpuMemoryGiB') ?? 24,
        maxConcurrentRequests: intField(details, 'maxConcurrentRequests'),
      };
    case 'container_service':
      return {
        ...base,
        kind,
        image: strField(details, 'image') ?? 'registry.capix.dev/default:latest',
        port: intField(details, 'port') ?? 8080,
        replicas: intField(details, 'replicas'),
      };
    case 'website':
      return {
        ...base,
        kind,
        sourceRef: strField(details, 'sourceRef') ?? '.',
        buildCommand: strField(details, 'buildCommand'),
        domains: listField(details, 'domains'),
      };
    case 'serverless_job':
      return {
        ...base,
        kind,
        image: strField(details, 'image') ?? 'registry.capix.dev/default:latest',
        command: listField(details, 'command') ?? ['true'],
        schedule: strField(details, 'schedule'),
        timeoutSeconds: intField(details, 'timeoutSeconds'),
      };
    case 'inference_request':
      return {
        ...base,
        kind,
        modelId: strField(details, 'modelId') ?? 'capix/auto',
        maxTokens: intField(details, 'maxTokens'),
      };
    case 'secured_cpu':
      return {
        ...base,
        trustTier: 'sovereign',
        kind,
        vcpus: intField(details, 'vcpus') ?? 2,
        memoryGiB: intField(details, 'memoryGiB') ?? 4,
        attestationRequired: true,
      };
    case 'secured_gpu':
      return {
        ...base,
        trustTier: 'sovereign',
        kind,
        gpuCount: intField(details, 'gpuCount') ?? 1,
        minGpuMemoryGiB: intField(details, 'minGpuMemoryGiB') ?? 24,
        attestationRequired: true,
      };
  }
}

// ── Architect ────────────────────────────────────────────────────────────────

export class Architect {
  private readonly modelInvoker: ModelInvoker | null;
  private readonly defaultRegion: Region;
  private readonly defaultTrustTier: TrustTier;
  private currentPlan: ArchitecturePlan | null = null;

  constructor(
    modelInvoker?: ModelInvoker,
    defaults: { region?: Region; trustTier?: TrustTier } = {}
  ) {
    this.modelInvoker = modelInvoker ?? null;
    this.defaultRegion = defaults.region ?? VALID_REGION;
    this.defaultTrustTier = defaults.trustTier ?? VALID_TRUST_TIER;
  }

  /**
   * Design an architecture from natural-language intent and attach live
   * quotes from the smart router. The plan lands in `awaiting-approval`.
   */
  async design(intent: string, opts: { signal?: AbortSignal; projectId?: string } = {}): Promise<ArchitecturePlan> {
    const now = new Date().toISOString();
    let plan: ArchitecturePlan;

    if (!this.modelInvoker) {
      plan = this.heuristicPlan(intent, now);
    } else {
      plan = await this.modelPlan(intent, now, opts.signal);
    }

    await this.attachQuotes(plan, opts);
    plan.costEstimate = this.estimateCost(plan);
    plan.status = 'awaiting-approval';
    plan.updatedAt = new Date().toISOString();
    this.currentPlan = plan;
    return plan;
  }

  /** Mark the current plan approved so `deploy.ts` will accept it. */
  approve(planId: string): ArchitecturePlan {
    const plan = this.currentPlan;
    if (!plan || plan.id !== planId) {
      throw new Error('architect: no such current plan to approve');
    }
    if (plan.status !== 'awaiting-approval') {
      throw new Error(`architect: plan is ${plan.status}, not awaiting-approval`);
    }
    plan.status = 'approved';
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /** Update the plan status after a deploy attempt (called by deploy.ts). */
  setStatus(planId: string, status: ArchitecturePlan['status']): void {
    const plan = this.currentPlan;
    if (!plan || plan.id !== planId) return;
    plan.status = status;
    plan.updatedAt = new Date().toISOString();
  }

  getCurrentPlan(): ArchitecturePlan | null {
    return this.currentPlan;
  }

  // ── model-driven design ──────────────────────────────────────────────────

  private async modelPlan(
    intent: string,
    now: string,
    signal?: AbortSignal
  ): Promise<ArchitecturePlan> {
    const prompt = [
      ARCHITECT_SYSTEM_PROMPT,
      '',
      '## User intent',
      intent,
      '',
      'Produce the architecture now using the protocol above.',
    ].join('\n');

    let response = '';
    try {
      response = await this.modelInvoker!(prompt, { signal });
    } catch (err) {
      logger.warn('architect: model invocation failed, using heuristic plan', {
        error: (err as Error)?.message,
      });
      const plan = this.heuristicPlan(intent, now);
      plan.assumptions.push('model invocation failed; architecture is a heuristic placeholder');
      return plan;
    }
    return this.parseArchitectureResponse(response, intent, now);
  }

  /**
   * Fallback when no model is wired: a single-service architecture inferred
   * from intent keywords. Truthful — it is labelled as a heuristic.
   */
  private heuristicPlan(intent: string, now: string): ArchitecturePlan {
    const lower = intent.toLowerCase();
    const wantsGpu = /\bgpu\b|train|inference|llm|model/.test(lower);
    const wantsSite = /website|landing|static site|frontend/.test(lower);
    const wantsJob = /cron|scheduled|batch|job/.test(lower);

    let kind: WorkloadKind = 'container_service';
    let details: Record<string, unknown> = { image: 'registry.capix.dev/default:latest', port: 8080 };
    if (wantsGpu) {
      kind = 'dedicated_gpu';
      details = { gpuCount: 1, minGpuMemoryGiB: 24 };
    } else if (wantsSite) {
      kind = 'website';
      details = { sourceRef: '.' };
    } else if (wantsJob) {
      kind = 'serverless_job';
      details = { image: 'registry.capix.dev/default:latest', command: 'true' };
    }

    const name = 'primary';
    const spec = buildWorkloadSpec(name, kind, details, this.defaultRegion, this.defaultTrustTier);
    return {
      id: randomUUID(),
      intent,
      summary: `Single ${kind} workload for: ${intent}`,
      services: [{ name, purpose: intent, workload: name }],
      dataStores: [],
      models: [],
      workloads: [{ name, kind, purpose: intent, details, spec }],
      trustTier: this.defaultTrustTier,
      region: this.defaultRegion,
      costEstimate: null,
      assumptions: ['no model invoker configured; architecture is a heuristic placeholder'],
      status: 'drafting',
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Parse a model response (the text protocol) into an `ArchitecturePlan`.
   * Robust to whitespace/casing variations; ignores unknown lines.
   */
  parseArchitectureResponse(response: string, intent: string, now: string): ArchitecturePlan {
    const plan: ArchitecturePlan = {
      id: randomUUID(),
      intent,
      summary: '',
      services: [],
      dataStores: [],
      models: [],
      workloads: [],
      trustTier: this.defaultTrustTier,
      region: this.defaultRegion,
      costEstimate: null,
      assumptions: [],
      status: 'drafting',
      createdAt: now,
      updatedAt: now,
    };

    const splitFields = (raw: string): string[] => raw.split('|').map((s) => s.trim());

    const parseDetails = (raw: string): Record<string, unknown> => {
      const details: Record<string, unknown> = {};
      for (const pair of raw.split(';')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (key && value) details[key] = value;
      }
      return details;
    };

    for (const rawLine of response.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      let m: RegExpMatchArray | null;
      if ((m = line.match(/^SUMMARY\s*:\s*(.*)$/i))) {
        plan.summary = m[1]!.trim();
        continue;
      }
      if ((m = line.match(/^TRUST_TIER\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim().toLowerCase();
        if (routing.isTrustTier(v)) plan.trustTier = v;
        continue;
      }
      if ((m = line.match(/^REGION\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim().toLowerCase();
        if (routing.isRegion(v)) plan.region = v;
        continue;
      }
      if ((m = line.match(/^ASSUMPTIONS\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim();
        if (v && v.toLowerCase() !== 'none') {
          plan.assumptions.push(
            ...v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          );
        }
        continue;
      }
      if ((m = line.match(/^SERVICE\s*:\s*(.*)$/i))) {
        const [name, purpose, workload] = splitFields(m[1]!);
        if (name) {
          plan.services.push({ name, purpose: purpose ?? '', workload: workload ?? name });
        }
        continue;
      }
      if ((m = line.match(/^DATASTORE\s*:\s*(.*)$/i))) {
        const [name, engine, purpose] = splitFields(m[1]!);
        if (name) {
          plan.dataStores.push({ name, engine: engine ?? 'unknown', purpose: purpose ?? '' });
        }
        continue;
      }
      if ((m = line.match(/^MODEL\s*:\s*(.*)$/i))) {
        const [name, modelRef, purpose] = splitFields(m[1]!);
        if (name) {
          plan.models.push({ name, modelRef: modelRef ?? name, purpose: purpose ?? '' });
        }
        continue;
      }
      if ((m = line.match(/^WORKLOAD\s*:\s*(.*)$/i))) {
        const [name, kindRaw, purpose, detailsRaw] = splitFields(m[1]!);
        if (!name) continue;
        const kind = kindRaw && routing.isWorkloadKind(kindRaw.toLowerCase())
          ? (kindRaw.toLowerCase() as WorkloadKind)
          : null;
        if (!kind) {
          plan.assumptions.push(`workload "${name}" had unknown kind "${kindRaw ?? ''}"; skipped`);
          continue;
        }
        const details = parseDetails(detailsRaw ?? '');
        const spec = buildWorkloadSpec(name, kind, details, plan.region, plan.trustTier);
        plan.workloads.push({ name, kind, purpose: purpose ?? '', details, spec });
        continue;
      }
    }

    if (!plan.summary) plan.summary = intent;
    if (plan.workloads.length === 0) {
      // Model produced no workloads — fall back to the heuristic workload set
      // so the plan is still quotable and deployable.
      const fallback = this.heuristicPlan(intent, now);
      plan.workloads = fallback.workloads;
      plan.services = plan.services.length > 0 ? plan.services : fallback.services;
      plan.assumptions.push('model response contained no workloads; heuristic workload used');
    }

    // Region/trust tier lines can appear after WORKLOAD lines; re-stamp specs
    // with the final plan-wide values.
    for (const w of plan.workloads) {
      w.spec = buildWorkloadSpec(w.name, w.kind, w.details, plan.region, plan.trustTier);
    }

    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  // ── live quotes ──────────────────────────────────────────────────────────

  /**
   * Fetch a live route quote per workload from the smart router. Quote
   * failures are recorded per-workload (`quoteError`) rather than failing the
   * whole plan, so the operator still sees the architecture with partial
   * pricing.
   */
  private async attachQuotes(
    plan: ArchitecturePlan,
    opts: { signal?: AbortSignal; projectId?: string }
  ): Promise<void> {
    for (const workload of plan.workloads) {
      try {
        workload.quote = await routing.createRouteQuote(workload.spec, {
          signal: opts.signal,
          projectId: opts.projectId,
        });
      } catch (err) {
        workload.quoteError = (err as Error)?.message ?? 'quote failed';
        logger.warn('architect: route quote failed', {
          workload: workload.name,
          error: workload.quoteError,
        });
      }
    }
  }

  /**
   * Roll best-candidate unit prices up into a plan-level estimate, in integer
   * minor units. Workloads whose currencies/scales disagree are kept out of
   * the total (still listed per-workload) rather than summed incorrectly.
   */
  private estimateCost(plan: ArchitecturePlan): ArchitectureCostEstimate {
    const perWorkload: WorkloadCost[] = plan.workloads.map((w) => {
      const best = w.quote ? routing.bestCandidate(w.quote) : null;
      return {
        name: w.name,
        pricePerUnit: best?.pricePerUnit ?? null,
        meteringUnit: best?.meteringUnit,
      };
    });

    let total: Money | null = null;
    for (const cost of perWorkload) {
      if (!cost.pricePerUnit) continue;
      if (total === null) {
        total = cost.pricePerUnit;
        continue;
      }
      try {
        total = routing.addMoney(total, cost.pricePerUnit);
      } catch {
        logger.warn('architect: mixed currency/scale in quotes; total excludes later workloads', {
          workload: cost.name,
        });
      }
    }

    const expiries = plan.workloads
      .map((w) => w.quote?.expiresAt)
      .filter((e): e is string => typeof e === 'string')
      .sort();

    return { total, perWorkload, quotesExpireAt: expiries[0] };
  }
}
