/**
 * Capix routing client — typed methods to call the Capix routing/deployment
 * plane (the "smart router").
 *
 * This module mirrors the patterns of `intelligence-client.ts`:
 *  - talks ONLY to the local CredentialBroker (never holds a refresh token,
 *    never embeds a bearer in config/env/logs);
 *  - uses `fetch` against `https://www.capix.network/api/v1/...`;
 *  - maps non-2xx HTTP responses (RFC 9457 problem details) into a typed
 *    `RoutingHttpError`;
 *  - refreshes exactly once on 401 before failing;
 *  - attaches client/release metadata as headers (no secrets).
 *
 * Refs:
 *  - protocol/packages/contracts/openapi.yaml (single source of truth):
 *    `/route/quote`, `/route/commit`, `/deployments`, `/billing/balance`,
 *    `/models`
 *  - routing-protocol.md (normalization → hard filter → scoring, explainable
 *    quotes with price-locked `quoteToken`)
 *
 * What this module deliberately does NOT do:
 *  - score or filter placement candidates itself (server-authoritative
 *    routing only; the client picks among the candidates the server already
 *    scored, by the server's own score);
 *  - expose provider or node identity (the contract never returns any);
 *  - use floating-point money. All amounts are string-encoded integer minor
 *    units.
 */

import { CredentialBroker } from './broker.js';
import { logger } from './logger.js';
import { CapixHttpError } from './capix-provider.js';

/** Production API origin for the routing service. */
export const CAPIX_ROUTING_BASE = 'https://www.capix.network/api/v1';

// ── Domain types (mirrors openapi.yaml components/schemas) ──────────────────

export type Region =
  | 'us-east'
  | 'us-west'
  | 'eu-central'
  | 'eu-north'
  | 'ap-southeast'
  | 'ap-northeast'
  | 'global';

export const REGIONS: readonly Region[] = [
  'us-east',
  'us-west',
  'eu-central',
  'eu-north',
  'ap-southeast',
  'ap-northeast',
  'global',
];

export type TrustTier = 'community' | 'verified' | 'sovereign';

export const TRUST_TIERS: readonly TrustTier[] = ['community', 'verified', 'sovereign'];

/** Integer minor units only. value = amountMinor / 10^scale in `currency`. */
export interface Money {
  amountMinor: string;
  currency: string;
  scale: number;
}

export type MeteringUnit =
  | 'cpu_core_second'
  | 'gpu_second'
  | 'memory_gib_second'
  | 'storage_gib_hour'
  | 'network_egress_byte'
  | 'request'
  | 'token_input'
  | 'token_output'
  | 'wallclock_second';

export type WorkloadKind =
  | 'cpu_vm'
  | 'dedicated_gpu'
  | 'private_model'
  | 'container_service'
  | 'website'
  | 'serverless_job'
  | 'inference_request'
  | 'secured_cpu'
  | 'secured_gpu';

export const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  'cpu_vm',
  'dedicated_gpu',
  'private_model',
  'container_service',
  'website',
  'serverless_job',
  'inference_request',
  'secured_cpu',
  'secured_gpu',
];

export function isWorkloadKind(value: string): value is WorkloadKind {
  return (WORKLOAD_KINDS as readonly string[]).includes(value);
}

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

export function isTrustTier(value: string): value is TrustTier {
  return (TRUST_TIERS as readonly string[]).includes(value);
}

interface WorkloadSpecBase {
  kind: WorkloadKind;
  name: string;
  region: Region;
  trustTier: TrustTier;
  budget?: Money;
  labels?: Record<string, string>;
}

export type WorkloadSpec =
  | (WorkloadSpecBase & { kind: 'cpu_vm'; vcpus: number; memoryGiB: number; diskGiB?: number })
  | (WorkloadSpecBase & {
      kind: 'dedicated_gpu';
      gpuCount: number;
      minGpuMemoryGiB: number;
      vcpus?: number;
      memoryGiB?: number;
    })
  | (WorkloadSpecBase & {
      kind: 'private_model';
      modelRef: string;
      minGpuMemoryGiB: number;
      maxConcurrentRequests?: number;
    })
  | (WorkloadSpecBase & {
      kind: 'container_service';
      image: string;
      port: number;
      replicas?: number;
      env?: Record<string, string>;
    })
  | (WorkloadSpecBase & {
      kind: 'website';
      sourceRef: string;
      buildCommand?: string;
      domains?: string[];
    })
  | (WorkloadSpecBase & {
      kind: 'serverless_job';
      image: string;
      command: string[];
      schedule?: string;
      timeoutSeconds?: number;
    })
  | (WorkloadSpecBase & { kind: 'inference_request'; modelId: string; maxTokens?: number })
  | (WorkloadSpecBase & {
      kind: 'secured_cpu';
      vcpus: number;
      memoryGiB: number;
      attestationRequired: true;
    })
  | (WorkloadSpecBase & {
      kind: 'secured_gpu';
      gpuCount: number;
      minGpuMemoryGiB: number;
      attestationRequired: true;
    });

export interface ScoreBreakdown {
  price: number;
  latency: number;
  reliability: number;
  evidence: number;
  utilization: number;
}

/**
 * One scored candidate. Never exposes node/provider identity — only region,
 * trust tier, capabilities, price, evidence, and the scoring explanation.
 */
export interface RouteCandidate {
  candidateId: string;
  region: Region;
  trustTier: TrustTier;
  capabilities: string[];
  pricePerUnit: Money;
  meteringUnit: MeteringUnit;
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

/** Explainable routing quote; `quoteToken` locks the price until `expiresAt`. */
export interface RouteQuote {
  routeQuoteId: string;
  quoteToken: string;
  specHash: string;
  normalizedSpec: WorkloadSpec;
  filterOutcome: {
    considered: number;
    rejectedCapacity: number;
    rejectedRegion: number;
    rejectedTrustTier: number;
    rejectedBudget: number;
  };
  candidates: RouteCandidate[];
  issuedAt: string;
  expiresAt: string;
}

export interface RouteReceipt {
  routeReceiptId: string;
  routeQuoteId: string;
  committedCandidate: RouteCandidate;
  committedAt: string;
  deploymentId: string;
}

export type DeploymentState =
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'destroying'
  | 'destroyed'
  | 'failed';

export interface DeploymentEndpoint {
  url: string;
  protocol: 'https' | 'http' | 'tcp' | 'websocket';
}

/**
 * Customer-facing view model: what the web console, IDE, Code CLI, and MCP
 * all render. Deliberately free of any provider or node identity.
 */
export interface CustomerView {
  summary: string;
  state: DeploymentState;
  region: Region;
  trustTier: TrustTier;
  endpoints?: DeploymentEndpoint[];
  spendToDate: Money;
  evidenceRef?: string;
}

export interface Deployment {
  deploymentId: string;
  projectId: string;
  quoteId?: string;
  spec: WorkloadSpec;
  state: DeploymentState;
  meteringUnit: MeteringUnit;
  customerView: CustomerView;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentList {
  deployments: Deployment[];
  nextCursor?: string;
}

export interface Balance {
  /** String-encoded integer minor units available to spend. */
  available: string;
  /** Minor units held by open quotes and running deployments. */
  held: string;
  currency: string;
  scale: number;
  asOf: string;
}

/** A model from the managed catalog (GET /models). */
export interface ManagedModel {
  modelId: string;
  name: string;
  visibility: 'public' | 'private';
  capabilities: string[];
  contextWindowTokens?: number;
  pricePerInputToken: Money;
  pricePerOutputToken: Money;
  regions: Region[];
  deploymentId?: string;
  trustTier?: TrustTier;
}

// ── Model training (POST/GET /models/train) ──────────────────────────────────

export type TrainingJobStatus =
  | 'queued'
  | 'provisioning'
  | 'training'
  | 'registering'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** Dataset descriptor — the CLI uploads by reference (`file://` URI + digest). */
export interface TrainingDatasetSpec {
  uri: string;
  format: 'jsonl' | 'parquet' | 'csv' | 'text';
  /** Lowercase hex SHA-256 of the dataset bytes. */
  sha256?: string;
  /** String-encoded byte length (no floats for sizes either). */
  bytes?: string;
}

export interface TrainingHyperparameters {
  epochs?: number;
  learningRate?: number;
  batchSize?: number;
  loraRank?: number;
  maxSeqLength?: number;
}

export interface TrainingCheckpoint {
  checkpointId: string;
  epoch: number;
  step: number;
  loss?: number;
  digest?: string;
  createdAt: string;
}

/**
 * A fine-tuning job. Terminal states: `ready` (with `registeredModelId`,
 * format `private/<jobId>`), `failed` (with `failureReason`), `cancelled`.
 */
export interface TrainingJob {
  jobId: string;
  status: TrainingJobStatus;
  baseModel: string;
  dataset: TrainingDatasetSpec;
  hyperparameters?: TrainingHyperparameters;
  specializationPrompt: string;
  estimatedCost?: Money;
  actualCost?: Money;
  progress?: {
    percent: number;
    currentEpoch?: number;
    totalEpochs?: number;
    message?: string;
  };
  checkpoints?: TrainingCheckpoint[];
  /** Present when status === 'ready' — identifies the user's catalog entry. */
  registeredModelId?: string;
  resumedFromCheckpointId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTrainingJobRequest {
  baseModel: string;
  dataset: TrainingDatasetSpec;
  hyperparameters?: TrainingHyperparameters;
  specializationPrompt: string;
  projectId?: string;
  /** Resume from a prior checkpoint instead of the base weights. */
  resumedFromCheckpointId?: string;
}

// ── Money helpers (integer minor units only) ────────────────────────────────

export function zeroMoney(currency = 'USD', scale = 2): Money {
  return { amountMinor: '0', currency, scale };
}

/** Add two Money values. Throws unless currency and scale match. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency || a.scale !== b.scale) {
    throw new Error(
      `routing-client: cannot add ${b.amountMinor} ${b.currency}(scale ${b.scale}) to ${a.currency}(scale ${a.scale})`
    );
  }
  return {
    amountMinor: (BigInt(a.amountMinor) + BigInt(b.amountMinor)).toString(),
    currency: a.currency,
    scale: a.scale,
  };
}

/**
 * Format integer minor units for display without floating point.
 * `formatMoney({ amountMinor: '129900', currency: 'USD', scale: 2 })` →
 * `"USD 1299.00"`.
 */
export function formatMoney(m: Money): string {
  const negative = m.amountMinor.startsWith('-');
  const digits = (negative ? m.amountMinor.slice(1) : m.amountMinor).padStart(m.scale + 1, '0');
  const whole = digits.slice(0, digits.length - m.scale) || '0';
  const frac = m.scale > 0 ? '.' + digits.slice(digits.length - m.scale) : '';
  return `${negative ? '-' : ''}${m.currency} ${whole}${frac}`;
}

// ── Routing HTTP error ───────────────────────────────────────────────────────

/**
 * Typed error for non-2xx routing API responses. Parses the RFC 9457
 * `ProblemDetails` body (`type`/`title`/`status`/`detail`/`code`) and mirrors
 * `IntelligenceHttpError` so callers can catch either class uniformly.
 */
export class RoutingHttpError extends CapixHttpError {
  constructor(
    status: number,
    capixCode: string,
    message: string,
    supportId?: string,
    retryClass: 'none' | 'retry' | 'retry-after' = 'none',
    retryAfterMs?: number
  ) {
    super(status, capixCode, message, supportId, retryClass, retryAfterMs, undefined);
    this.name = 'RoutingHttpError';
  }
}

// ── Lazy broker accessor (same pattern as intelligence-client) ───────────────

let brokerAccessor: (() => CredentialBroker) | null = null;

export function setBrokerAccessor(accessor: () => CredentialBroker): void {
  brokerAccessor = accessor;
}

function broker(): CredentialBroker {
  if (!brokerAccessor) {
    throw new Error('routing-client: CredentialBroker accessor not registered');
  }
  return brokerAccessor();
}

/** Resolve the routing base URL. Overridable by config; never by secret. */
let routingBaseResolver: () => string = () => CAPIX_ROUTING_BASE;

export function setRoutingBaseResolver(resolver: () => string): void {
  routingBaseResolver = resolver;
}

function routeBase(): string {
  return routingBaseResolver().replace(/\/$/, '');
}

// ── Client metadata (lazily injected by the plugin) ─────────────────────────

interface RoutingClientMeta {
  client: 'capix-code';
  clientVersion: string;
  pluginVersion: string;
  releaseId: string;
}

let metaAccessor: (() => RoutingClientMeta) | null = null;

export function setClientMetaAccessor(accessor: () => RoutingClientMeta): void {
  metaAccessor = accessor;
}

function meta(): RoutingClientMeta {
  if (!metaAccessor) {
    return {
      client: 'capix-code',
      clientVersion: '2.2.5',
      pluginVersion: '2.2.5',
      releaseId: 'dev',
    };
  }
  return metaAccessor();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 9457 problem details plus legacy fields seen in the wild. */
interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  capixCode?: string;
  message?: string;
  supportId?: string;
  traceId?: string;
  retryAfterSeconds?: number;
}

/** Classify a non-2xx routing response into a typed error. */
async function classifyHttpError(res: Response): Promise<never> {
  const status = res.status;
  let body: ProblemResponse | undefined;
  try {
    body = (await res.json()) as ProblemResponse;
  } catch {
    body = undefined;
  }
  const capixCode = body?.code ?? body?.capixCode ?? `HTTP_${status}`;
  const message =
    body?.detail ?? body?.message ?? body?.title ?? res.statusText ?? 'routing request failed';
  const supportId = body?.supportId ?? body?.traceId;
  const retryAfter = res.headers.get('retry-after');
  switch (status) {
    case 401:
      throw new RoutingHttpError(status, capixCode, message, supportId, 'retry');
    case 402:
      // Insufficient balance — surface top-up; not retryable in-band.
      throw new RoutingHttpError(status, capixCode, message, supportId, 'none');
    case 409:
    case 410:
      // Quote already committed / expired — caller must re-quote.
      throw new RoutingHttpError(status, capixCode, message, supportId, 'none');
    case 429: {
      const retryAfterMs = retryAfter
        ? Math.max(0, parseFloat(retryAfter) * 1000)
        : body?.retryAfterSeconds !== undefined
          ? body.retryAfterSeconds * 1000
          : undefined;
      throw new RoutingHttpError(status, capixCode, message, supportId, 'retry-after', retryAfterMs);
    }
    default:
      if (status >= 500) {
        throw new RoutingHttpError(status, capixCode, message, supportId, 'retry');
      }
      throw new RoutingHttpError(status, capixCode, message, supportId, 'none');
  }
}

/** Build the auth + content headers for a request, with one-shot broker token. */
async function buildHeaders(
  contentType?: string,
  projectId?: string
): Promise<{ headers: Record<string, string>; requestId: string }> {
  const access = await broker().getAccessToken({ projectId });
  const requestId = newRequestId();
  const m = meta();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.token}`,
    Accept: 'application/json, application/problem+json',
    'X-Capix-Client': m.client,
    'X-Capix-Client-Version': m.clientVersion,
    'X-Capix-Plugin-Version': m.pluginVersion,
    'X-Capix-Release-Id': m.releaseId,
    'X-Capix-Request-Id': requestId,
    'X-Capix-Source': 'capix-code',
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return { headers, requestId };
}

interface RequestOpts {
  projectId?: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

/**
 * Core request helper. Performs the fetch, refreshes exactly once on 401,
 * classifies non-2xx into `RoutingHttpError`, and returns the parsed JSON
 * body (or `undefined` for 204).
 */
async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  opts: RequestOpts = {}
): Promise<T | undefined> {
  const url = `${routeBase()}${path}`;

  let refreshed = false;
  const doFetch = async (): Promise<Response> => {
    const isJson = body !== undefined;
    const { headers, requestId } = await buildHeaders(
      isJson ? 'application/json' : undefined,
      opts.projectId
    );
    if (method !== 'GET') {
      headers['Idempotency-Key'] = opts.idempotencyKey ?? requestId;
    }
    const res = await fetch(url, {
      method,
      headers,
      body: isJson ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok && res.status === 401 && !refreshed) {
      refreshed = true;
      logger.info('routing-client: 401, refreshing broker token', { requestId, path });
      await broker().refreshToken();
      return doFetch();
    }
    if (!res.ok) {
      await classifyHttpError(res);
    }
    return res;
  };

  const res = await doFetch();
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    logger.warn('routing-client: unparseable JSON body', { path, status: res.status });
    return undefined;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Quote a workload through the smart router. The server runs normalization,
 * hard filtering, and scoring, and returns an explainable quote with a
 * price-locked `quoteToken` (valid until `expiresAt`).
 */
export async function createRouteQuote(
  spec: WorkloadSpec,
  opts: RequestOpts & { maxCandidates?: number } = {}
): Promise<RouteQuote> {
  const result = await request<RouteQuote>(
    'POST',
    '/route/quote',
    { spec, maxCandidates: opts.maxCandidates ?? 5 },
    opts
  );
  if (!result) throw new RoutingHttpError(0, 'CAPIX_INTERNAL', 'empty route quote response');
  return result;
}

/**
 * Commit a placement from a locked route quote. Picks `candidateId` if given,
 * else the server's top-scored candidate. A second commit of the same quote
 * fails with `CAPIX_ROUTE_ALREADY_COMMITTED`.
 */
export async function commitRoute(
  quoteToken: string,
  candidateId?: string,
  opts: RequestOpts = {}
): Promise<RouteReceipt> {
  const result = await request<RouteReceipt>(
    'POST',
    '/route/commit',
    { quoteToken, candidateId },
    opts
  );
  if (!result) throw new RoutingHttpError(0, 'CAPIX_INTERNAL', 'empty route commit response');
  return result;
}

/** Create a deployment directly from a locked quote token. */
export async function createDeployment(
  quoteToken: string,
  opts: RequestOpts = {}
): Promise<Deployment> {
  const result = await request<Deployment>('POST', '/deployments', { quoteToken }, opts);
  if (!result) throw new RoutingHttpError(0, 'CAPIX_INTERNAL', 'empty deployment response');
  return result;
}

export async function getDeployment(id: string, opts: RequestOpts = {}): Promise<Deployment> {
  const result = await request<Deployment>(
    'GET',
    `/deployments/${encodeURIComponent(id)}`,
    undefined,
    opts
  );
  if (!result) throw new RoutingHttpError(0, 'CAPIX_INTERNAL', 'empty deployment response');
  return result;
}

export async function listDeployments(
  input: { cursor?: string; limit?: number } = {},
  opts: RequestOpts = {}
): Promise<DeploymentList> {
  const qs = new URLSearchParams();
  if (input.cursor) qs.set('cursor', input.cursor);
  if (input.limit) qs.set('limit', String(input.limit));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const result = await request<DeploymentList>('GET', `/deployments${suffix}`, undefined, opts);
  return result ?? { deployments: [] };
}

/** Spendable balance: `available` minor units, `held` by open quotes/running deployments. */
export async function getBalance(opts: RequestOpts = {}): Promise<Balance> {
  const result = await request<Balance>('GET', '/billing/balance', undefined, opts);
  if (!result) throw new RoutingHttpError(0, 'CAPIX_INTERNAL', 'empty balance response');
  return result;
}

/**
 * The full managed model catalog (public + private visibility), as served by
 * the control plane. This is the only model source — the CLI never falls back
 * to a local-only model list.
 */
export async function listManagedModels(opts: RequestOpts = {}): Promise<ManagedModel[]> {
  const result = await request<{ models: ManagedModel[] } | ManagedModel[]>(
    'GET',
    '/models',
    undefined,
    opts
  );
  if (!result) return [];
  return Array.isArray(result) ? result : (result.models ?? []);
}

/** Pick the server's top-scored candidate from a route quote, if any. */
export function bestCandidate(quote: RouteQuote): RouteCandidate | null {
  if (quote.candidates.length === 0) return null;
  return quote.candidates.reduce((best, c) => (c.score > best.score ? c : best));
}

/**
 * Submit a fine-tuning job (POST /models/train). The request helper attaches
 * the `Idempotency-Key` header automatically for non-GET requests.
 */
export async function createTrainingJob(
  spec: CreateTrainingJobRequest,
  opts: RequestOpts = {}
): Promise<TrainingJob | undefined> {
  const result = await request<{ job: TrainingJob }>('POST', '/models/train', spec, opts);
  return result?.job;
}

/** Poll a training job (GET /models/train/{jobId}). */
export async function getTrainingJob(
  jobId: string,
  opts: RequestOpts = {}
): Promise<TrainingJob | undefined> {
  const result = await request<{ job: TrainingJob }>(
    'GET',
    `/models/train/${encodeURIComponent(jobId)}`,
    undefined,
    opts
  );
  return result?.job;
}
