/**
 * Capix intelligence client — typed methods to call the Capix intelligence API.
 *
 * This module mirrors the patterns of `capix-provider.ts`:
 *  - talks ONLY to the local CredentialBroker (never holds a refresh token,
 *    never embeds a bearer in config/env/logs);
 *  - uses `fetch` against `https://www.capix.network/api/v1/...`;
 *  - maps non-2xx HTTP responses into a typed `IntelligenceHttpError`;
 *  - refreshes exactly once on 401 before failing;
 *  - attaches client/release metadata as headers (no secrets).
 *
 * Refs:
 *  - architecture §12.3 (Authentication/broker), §12.4 (provider/routing)
 *  - master prompt C2 (real provider), C3 (credential broker)
 *
 * What this module deliberately does NOT do:
 *  - classify prompts or score providers (server-authoritative routing only);
 *  - rewrite a base URL from a stored secret;
 *  - retain a separate router memory or placement cache.
 */

import { CredentialBroker } from './broker.js';
import { logger } from './logger.js';
import { CapixHttpError } from './capix-provider.js';

/** Production API origin for the intelligence service. */
export const CAPIX_INTELLIGENCE_BASE = 'https://www.capix.network/api/v1';

/** Client/release metadata attached to every intelligence request. */
export interface IntelligenceClientMeta {
  client: 'capix-code';
  clientVersion: string;
  pluginVersion: string;
  releaseId: string;
}

// ── Domain types ────────────────────────────────────────────────────────────

export type MemoryNodeType = 'decision' | 'constraint' | 'fact' | 'observation' | 'plan' | 'risk';

export type MemoryNodeStatus = 'active' | 'superseded' | 'deprecated';

export interface MemoryNode {
  id: string;
  content: string;
  nodeType: MemoryNodeType;
  source: string;
  confidence: number;
  status: MemoryNodeStatus;
  tags: string[];
  createdAt: string;
  supersededReason?: string;
  supersededBy?: string;
}

export interface WriteMemoryInput {
  content: string;
  nodeType: MemoryNodeType;
  source: string;
  confidence: number;
  tags?: string[];
}

export interface RetrieveMemoryInput {
  q?: string;
  type?: MemoryNodeType;
  status?: MemoryNodeStatus;
  limit?: number;
  cursor?: string;
}

export interface RetrieveMemoryOutput {
  nodes: MemoryNode[];
  nextCursor?: string;
}

export interface AnchorMemoryInput {
  nodeId: string;
  anchor: 'checkpoint' | 'plan' | 'work-batch';
  anchorId: string;
}

export type GraphNodeType =
  'memory' | 'plan' | 'agent' | 'file' | 'receipt' | 'checkpoint' | 'covenant';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  content: string;
  confidence?: number;
  redactionClass?: 'public' | 'masked' | 'redacted' | 'internal';
}

export interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  weight?: number;
  provenance?: string;
}

export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  weight?: number;
  provenance?: string;
}

export interface GraphQueryInput {
  start?: { id: string };
  filter?: { type?: GraphNodeType; status?: MemoryNodeStatus };
  q?: string;
  relationship?: string;
  depth?: number;
  limit?: number;
  includeRelationships?: boolean;
}

export interface GraphQueryOutput {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface CovenantRule {
  id: string;
  invariant: string;
  appliesTo: 'agent' | 'tool' | 'command' | 'deploy';
  effect: 'allow' | 'deny' | 'ask';
}

export interface Covenant {
  id: string;
  version: string;
  ratifiedAt: string;
  rules: CovenantRule[];
  previousVersion?: string;
}

export interface RatifyCovenantInput {
  rules: CovenantRule[];
  source: string;
  notes?: string;
}

export interface CheckPermissionInput {
  action: string;
  environment?: 'dev' | 'staging' | 'prod';
  target?: string;
  spec?: string;
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface CheckPermissionOutput {
  decision: PermissionDecision;
  ruleId?: string;
  reason?: string;
}

export type AgentTrustLevel = 'untrusted' | 'sandboxed' | 'trusted' | 'privileged';
export type AgentStatus = 'active' | 'idle' | 'completed' | 'failed';

export interface AgentRecord {
  id: string;
  kind: string;
  trustLevel: AgentTrustLevel;
  generation: number;
  status: AgentStatus;
  objective: string;
  scope?: { inBounds: string[]; outOfBounds: string[] };
  constraints?: {
    sandboxProfile?: 'restricted' | 'developer' | 'host';
    costCeilingMinor?: string;
    forbiddenTools?: string[];
  };
  definitionOfDone: string;
  parentAgentId?: string;
  createdAt: string;
  completedAt?: string;
  outcome?: 'completed' | 'blocked' | 'abandoned';
}

export interface SpawnAgentInput {
  objective: string;
  scope: { inBounds: string[]; outOfBounds: string[] };
  constraints: {
    trustLevel: AgentTrustLevel;
    sandboxProfile: 'restricted' | 'developer' | 'host';
    costCeilingMinor?: string;
    forbiddenTools?: string[];
  };
  definitionOfDone: string;
  parentAgentId?: string;
  source: string;
}

export interface CompleteAgentInput {
  outcome: 'completed' | 'blocked' | 'abandoned';
  dodStatus: 'pass' | 'partial' | 'fail';
  dodEvidence: Array<{ item: string; status: 'pass' | 'fail' | 'skipped' }>;
  filesChanged: string[];
  receipts: string[];
  planId?: string;
  nextStepHint: string;
  lessonsLearned?: string[];
  source: string;
}

export interface SkillRecord {
  id: string;
  version: string;
  riskClass: 'informational' | 'side-effect' | 'destructive' | 'privileged';
  permissions: string[];
  description: string;
  trustFloor: AgentTrustLevel;
}

export interface RegisterSkillInput {
  id: string;
  version: string;
  riskClass: SkillRecord['riskClass'];
  permissions: string[];
  description: string;
  trustFloor: AgentTrustLevel;
  source: string;
}

export interface Plan {
  id: string;
  goal: string;
  nonGoals: string[];
  assumptions: Array<{ claim: string; check: string }>;
  affectedSurfaces: string[];
  testStrategy: {
    newTests: string[];
    existingMustPass: string[];
    verifyCommands: string[];
  };
  definitionOfDone: string[];
  status: 'active' | 'completed' | 'superseded' | 'abandoned';
  source: string;
  confidence: number;
  createdAt: string;
}

export interface CreatePlanInput {
  goal: string;
  nonGoals: string[];
  assumptions: Array<{ claim: string; check: string }>;
  affectedSurfaces: string[];
  testStrategy: {
    newTests: string[];
    existingMustPass: string[];
    verifyCommands: string[];
  };
  definitionOfDone: string[];
  source: string;
  confidence: number;
}

export type ListPlansStatus = 'active' | 'completed' | 'superseded' | 'abandoned';

export interface ListPlansInput {
  status?: ListPlansStatus;
  limit?: number;
  cursor?: string;
}

export interface ListPlansOutput {
  plans: Plan[];
  nextCursor?: string;
}

export interface Checkpoint {
  id: string;
  label?: string;
  repoState: {
    commit: string;
    branch: string;
    dirty: boolean;
    diffStat: string;
  };
  verification: {
    typecheck: 'pass' | 'fail' | 'skipped';
    lint: 'pass' | 'fail' | 'skipped';
    tests: 'pass' | 'fail' | 'skipped';
    testCounts: { passed: number; failed: number; skipped: number };
  };
  planId?: string;
  activeAgentIds: string[];
  covenantVersion?: string;
  receiptSummary: {
    count: number;
    totalCostMinor: string;
    asset: string;
    scale: number;
  };
  source: string;
  createdAt: string;
}

export interface CreateCheckpointInput {
  label?: string;
  repoState: Checkpoint['repoState'];
  verification: Checkpoint['verification'];
  planId?: string;
  activeAgentIds: string[];
  covenantVersion?: string;
  receiptSummary: Checkpoint['receiptSummary'];
  source: string;
}

export interface ListCheckpointsInput {
  limit?: number;
  cursor?: string;
}

export interface ListCheckpointsOutput {
  checkpoints: Checkpoint[];
  nextCursor?: string;
}

export type ReceiptKind =
  'inference' | 'infra-provision' | 'infra-destroy' | 'verification' | 'review' | 'model-training' | 'sandpit-run';

export interface WorkReceipt {
  id: string;
  kind: ReceiptKind;
  agentId?: string;
  costMinor: string;
  asset: string;
  scale: number;
  timestamp: string;
  anchored: boolean;
  anchorId?: string;
  summary: string;
  outcome?: 'success' | 'failed' | 'partial';
  environment?: 'dev' | 'staging' | 'prod';
  resourceIds?: string[];
  redactionClass?: 'public' | 'masked' | 'redacted' | 'internal';
}

export interface CreateWorkReceiptInput {
  kind: ReceiptKind;
  agentId?: string;
  costMinor: string;
  asset: string;
  scale: number;
  summary: string;
  outcome?: 'success' | 'failed' | 'partial';
  environment?: 'dev' | 'staging' | 'prod';
  resourceIds?: string[];
  source: string;
}

export interface ListReceiptsInput {
  agentId?: string;
  kind?: ReceiptKind;
  anchored?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface ListReceiptsOutput {
  receipts: WorkReceipt[];
  nextCursor?: string;
}

export interface AnchorReceiptsInput {
  receiptIds: string[];
  anchor: 'checkpoint' | 'work-batch';
  anchorId?: string;
}

export interface AnchorReceiptsOutput {
  batchId: string;
  anchored: string[];
  skipped: string[];
}

export type HookEventType =
  | 'plan.created'
  | 'agent.spawned'
  | 'memory.written'
  | 'checkpoint.created'
  | 'receipt.created'
  | 'tool.execute'
  | 'command.execute'
  | 'covenant.ratified'
  | 'deploy.quote'
  | 'deploy.provision'
  | 'deploy.destroy'
  | 'train.submit'
  | 'train.register'
  | 'sandpit.create'
  | 'sandpit.job'
  | 'sandpit.destroy'
  | 'compact.run';

export interface RecordHookEventInput {
  type: HookEventType;
  sessionId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
  source: string;
}

export interface HookEvent {
  id: string;
  type: HookEventType;
  sessionId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
  source: string;
  timestamp: string;
}

export interface ListHookEventsInput {
  type?: HookEventType;
  sessionId?: string;
  agentId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListHookEventsOutput {
  events: HookEvent[];
  nextCursor?: string;
}

// ── Intelligence HTTP error ────────────────────────────────────────────────

/**
 * Typed error for non-2xx intelligence API responses. Mirrors
 * `CapixHttpError` from capix-provider.ts so callers can use either class in
 * a `catch` block and get the same `capixCode` + `supportId` surface.
 *
 * The parent's `body` field (typed as `InferenceErrorResponse`) carries any
 * structured error payload the server returned. This subclass adds no new
 * fields; it only specializes `name` so error logging can distinguish
 * intelligence-API failures from inference-API failures.
 */
export class IntelligenceHttpError extends CapixHttpError {
  constructor(
    status: number,
    capixCode: string,
    message: string,
    supportId?: string,
    retryClass: 'none' | 'retry' | 'retry-after' = 'none',
    retryAfterMs?: number
  ) {
    super(status, capixCode, message, supportId, retryClass, retryAfterMs, undefined);
    this.name = 'IntelligenceHttpError';
  }
}

// ── Lazy broker accessor (same pattern as capix-provider) ────────────────────

let brokerAccessor: (() => CredentialBroker) | null = null;

export function setBrokerAccessor(accessor: () => CredentialBroker): void {
  brokerAccessor = accessor;
}

function broker(): CredentialBroker {
  if (!brokerAccessor) {
    throw new Error('intelligence-client: CredentialBroker accessor not registered');
  }
  return brokerAccessor();
}

/** Resolve the intelligence base URL. Overridable by config; never by secret. */
let intelligenceBaseResolver: () => string = () => CAPIX_INTELLIGENCE_BASE;

export function setIntelligenceBaseResolver(resolver: () => string): void {
  intelligenceBaseResolver = resolver;
}

function intelBase(): string {
  return intelligenceBaseResolver().replace(/\/$/, '');
}

// ── Client metadata (lazily injected by the plugin) ────────────────────────

let metaAccessor: (() => IntelligenceClientMeta) | null = null;

export function setClientMetaAccessor(accessor: () => IntelligenceClientMeta): void {
  metaAccessor = accessor;
}

function meta(): IntelligenceClientMeta {
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

// ── Helpers ────────────────────────────────────────────────────────────────

function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function metaHeaders(m: IntelligenceClientMeta, requestId: string): Record<string, string> {
  return {
    'X-Capix-Client': m.client,
    'X-Capix-Client-Version': m.clientVersion,
    'X-Capix-Plugin-Version': m.pluginVersion,
    'X-Capix-Release-Id': m.releaseId,
    'X-Capix-Request-Id': requestId,
    'X-Capix-Source': 'capix-code',
  };
}

interface ErrorResponse {
  capixCode?: string;
  message?: string;
  status?: number;
  supportId?: string;
  traceId?: string;
  retryClass?: 'none' | 'retry' | 'retry-after';
  retryAfterMs?: number;
}

/** Classify a non-2xx intelligence response into a typed error. */
async function classifyHttpError(res: Response): Promise<never> {
  const status = res.status;
  let body: ErrorResponse | undefined;
  try {
    body = (await res.json()) as ErrorResponse;
  } catch {
    body = undefined;
  }
  const capixCode = body?.capixCode ?? `HTTP_${status}`;
  const message = body?.message ?? res.statusText ?? 'intelligence request failed';
  const supportId = body?.supportId;
  const retryAfter = res.headers.get('retry-after');
  switch (status) {
    case 401:
      throw new IntelligenceHttpError(status, capixCode, message, supportId, 'retry');
    case 402:
      throw new IntelligenceHttpError(status, capixCode, message, supportId, 'none');
    case 409:
      throw new IntelligenceHttpError(status, capixCode, message, supportId, 'none');
    case 429: {
      const retryAfterMs = retryAfter ? Math.max(0, parseFloat(retryAfter) * 1000) : undefined;
      throw new IntelligenceHttpError(
        status,
        capixCode,
        message,
        supportId,
        'retry-after',
        retryAfterMs
      );
    }
    default:
      if (status >= 500) {
        throw new IntelligenceHttpError(status, capixCode, message, supportId, 'retry');
      }
      throw new IntelligenceHttpError(status, capixCode, message, supportId, 'none');
  }
}

/** Build the auth + content headers for a request, with one-shot broker token. */
async function buildHeaders(
  Accept: string,
  contentType?: string,
  projectId?: string
): Promise<{ headers: Record<string, string>; requestId: string }> {
  const access = await broker().getAccessToken({ projectId });
  const requestId = newRequestId();
  const m = meta();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.token}`,
    Accept,
    ...metaHeaders(m, requestId),
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return { headers, requestId };
}

/**
 * Core request helper. Performs the fetch, refreshes exactly once on 401,
 * classifies non-2xx into `IntelligenceHttpError`, and returns the parsed
 * JSON body (or `undefined` for 204).
 */
async function request<T>(options: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  projectId?: string;
  signal?: AbortSignal;
}): Promise<T | undefined> {
  const { method, path, query, body, projectId, signal } = options;

  const url = new URL(`${intelBase()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let refreshed = false;
  const doFetch = async (): Promise<Response> => {
    const isJson = body !== undefined;
    const { headers, requestId } = await buildHeaders(
      'application/json',
      isJson ? 'application/json' : undefined,
      projectId
    );
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: isJson ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok && res.status === 401 && !refreshed) {
      refreshed = true;
      logger.info('intelligence-client: 401, refreshing broker token', { requestId, path });
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
    logger.warn('intelligence-client: unparseable JSON body', { path, status: res.status });
    return undefined;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

// ── Memory ──

export async function writeMemory(
  input: WriteMemoryInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<MemoryNode> {
  const result = await request<MemoryNode>({
    method: 'POST',
    path: '/memory',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function retrieveMemory(
  input: RetrieveMemoryInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<RetrieveMemoryOutput> {
  const result = await request<RetrieveMemoryOutput>({
    method: 'GET',
    path: '/memory',
    query: {
      q: input.q,
      type: input.type,
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { nodes: [] };
}

export async function anchorMemory(
  input: AnchorMemoryInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<MemoryNode> {
  const result = await request<MemoryNode>({
    method: 'PATCH',
    path: `/memory/${encodeURIComponent(input.nodeId)}`,
    body: {
      anchor: input.anchor,
      anchorId: input.anchorId,
      status: 'active',
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

// ── Graph ──

export async function createRelationship(
  input: CreateRelationshipInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<GraphRelationship> {
  const result = await request<GraphRelationship>({
    method: 'POST',
    path: '/graph/relationships',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function graphQuery(
  input: GraphQueryInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<GraphQueryOutput> {
  const result = await request<GraphQueryOutput>({
    method: 'POST',
    path: '/graph',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { nodes: [], relationships: [] };
}

// ── Covenant ──

export async function getActiveCovenant(
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<Covenant | null> {
  const result = await request<Covenant>({
    method: 'GET',
    path: '/covenants',
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? null;
}

export async function ratifyCovenant(
  input: RatifyCovenantInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<Covenant> {
  const result = await request<Covenant>({
    method: 'POST',
    path: '/covenants/ratify',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function checkPermission(
  input: CheckPermissionInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<CheckPermissionOutput> {
  const result = await request<CheckPermissionOutput>({
    method: 'POST',
    path: '/covenants/check-permission',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { decision: 'deny', reason: 'no response from permission service' };
}

// ── Agents ──

export async function spawnAgent(
  input: SpawnAgentInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<AgentRecord> {
  const result = await request<AgentRecord>({
    method: 'POST',
    path: '/agents',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function completeAgent(
  agentId: string,
  input: CompleteAgentInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<AgentRecord> {
  const result = await request<AgentRecord>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}`,
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listAgents(
  input: { status?: AgentStatus; limit?: number; cursor?: string } = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<{ agents: AgentRecord[]; nextCursor?: string }> {
  const result = await request<{ agents: AgentRecord[]; nextCursor?: string }>({
    method: 'GET',
    path: '/agents',
    query: {
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { agents: [] };
}

// ── Skills ──

export async function registerSkill(
  input: RegisterSkillInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<SkillRecord> {
  const result = await request<SkillRecord>({
    method: 'POST',
    path: '/skills',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listSkills(
  input: { q?: string; riskClass?: SkillRecord['riskClass']; limit?: number; cursor?: string } = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<{ skills: SkillRecord[]; nextCursor?: string }> {
  const result = await request<{ skills: SkillRecord[]; nextCursor?: string }>({
    method: 'GET',
    path: '/skills',
    query: {
      q: input.q,
      riskClass: input.riskClass,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { skills: [] };
}

// ── Plans ──

export async function createPlan(
  input: CreatePlanInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<Plan> {
  const result = await request<Plan>({
    method: 'POST',
    path: '/plans',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listPlans(
  input: ListPlansInput = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<ListPlansOutput> {
  const result = await request<ListPlansOutput>({
    method: 'GET',
    path: '/plans',
    query: {
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { plans: [] };
}

// ── Checkpoints ──

export async function createCheckpoint(
  input: CreateCheckpointInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<Checkpoint> {
  const result = await request<Checkpoint>({
    method: 'POST',
    path: '/checkpoints',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listCheckpoints(
  input: ListCheckpointsInput = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<ListCheckpointsOutput> {
  const result = await request<ListCheckpointsOutput>({
    method: 'GET',
    path: '/checkpoints',
    query: {
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { checkpoints: [] };
}

// ── Receipts ──

export async function createWorkReceipt(
  input: CreateWorkReceiptInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<WorkReceipt> {
  const result = await request<WorkReceipt>({
    method: 'POST',
    path: '/receipts',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listReceipts(
  input: ListReceiptsInput = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<ListReceiptsOutput> {
  const result = await request<ListReceiptsOutput>({
    method: 'GET',
    path: '/receipts',
    query: {
      agentId: input.agentId,
      kind: input.kind,
      anchored: input.anchored,
      q: input.q,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { receipts: [] };
}

export async function anchorReceipts(
  input: AnchorReceiptsInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<AnchorReceiptsOutput> {
  const result = await request<AnchorReceiptsOutput>({
    method: 'POST',
    path: '/receipts/anchor',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { batchId: '', anchored: [], skipped: input.receiptIds };
}

// ── Hook events ──

export async function recordHookEvent(
  input: RecordHookEventInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<HookEvent> {
  const result = await request<HookEvent>({
    method: 'POST',
    path: '/hooks/events',
    body: input,
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result!;
}

export async function listHookEvents(
  input: ListHookEventsInput = {},
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<ListHookEventsOutput> {
  const result = await request<ListHookEventsOutput>({
    method: 'GET',
    path: '/hooks/events',
    query: {
      type: input.type,
      sessionId: input.sessionId,
      agentId: input.agentId,
      limit: input.limit,
      cursor: input.cursor,
    },
    projectId: opts.projectId,
    signal: opts.signal,
  });
  return result ?? { events: [] };
}

// ── Project context / active session (cross-surface brain sync) ────────────
// These methods sync and retrieve the shared project context so the web chat,
// IDE, CLI, and MCP all see the same orientation, active files, recent
// decisions, active plan, and active agents — regardless of which surface
// last touched the project.

export interface ProjectContextCodebaseSummary {
  totalFiles?: number;
  languages?: string[];
  keyModules?: string[];
  entryPoints?: string[];
  framework?: string;
}

export interface ProjectContextDecision {
  id: string;
  summary: string;
  confidence?: number;
  timestamp: string;
}

export interface ProjectContextPlan {
  id: string;
  goal: string;
  definitionOfDone: string[];
  status: string;
  createdAt: string;
}

export interface ProjectContextCheckpoint {
  id: string;
  planId?: string;
  contentHash?: string;
  createdAt: string;
}

export interface ProjectContextAgent {
  id: string;
  generation?: number;
  parentAgentId?: string;
  role: string;
  mandate: string;
  status: string;
  trustLevel?: string;
  bornAt: string;
}

export interface ProjectContext {
  orientation: string | null;
  recentDecisions: ProjectContextDecision[];
  activePlan: ProjectContextPlan | null;
  recentCheckpoints: ProjectContextCheckpoint[];
  activeAgents: ProjectContextAgent[];
  activeFiles: string[];
  codebaseSummary: ProjectContextCodebaseSummary | null;
  lastSyncAt: string | null;
}

export interface ActiveProjectSummary {
  projectId: string;
  projectName: string;
  lastActivity: string;
  activePlan: ProjectContextPlan | null;
  activeFiles: string[];
  activeAgents: ProjectContextAgent[];
  sessionSource: string;
}

export interface ActiveSessionRecentWork {
  type: 'checkpoint' | 'decision' | 'plan' | 'deployment';
  summary: string;
  timestamp: string;
  projectId: string;
}

export interface ActiveSession {
  activeProjects: ActiveProjectSummary[];
  recentWork: ActiveSessionRecentWork[];
}

export interface SyncProjectContextInput {
  projectId?: string;
  orientation: string;
  codebaseSummary: ProjectContextCodebaseSummary | Record<string, unknown>;
  activeFiles: string[];
  sessionSource: 'capix-code' | 'capix-ide' | 'web' | 'capix-cli' | 'mcp' | string;
}

/**
 * Sync local codebase context (orientation + codebase summary + active files)
 * to the server so any surface can retrieve it. Non-blocking on the caller's
 * side: failures surface as `IntelligenceHttpError` and should be caught by the
 * plugin (which treats sync as best-effort).
 */
export async function syncProjectContext(
  input: SyncProjectContextInput,
  opts: { projectId?: string; signal?: AbortSignal } = {}
): Promise<{ id: string; lastSyncAt: string; projectId: string }> {
  const result = await request<{ id: string; lastSyncAt: string; projectId: string }>({
    method: 'POST',
    path: '/intelligence/project-context/sync',
    body: {
      projectId: opts.projectId ?? input.projectId,
      orientation: input.orientation,
      codebaseSummary: input.codebaseSummary,
      activeFiles: input.activeFiles,
      sessionSource: input.sessionSource,
    },
    projectId: opts.projectId ?? input.projectId,
    signal: opts.signal,
  });
  return result ?? { id: '', lastSyncAt: new Date().toISOString(), projectId: opts.projectId ?? input.projectId ?? '' };
}

/**
 * Get the synced project context for a project (the orientation, active files,
 * recent decisions, active plan, etc. last pushed by any surface).
 */
export async function getProjectContext(
  projectId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<ProjectContext> {
  const result = await request<ProjectContext>({
    method: 'GET',
    path: '/intelligence/project-context',
    query: { projectId },
    projectId,
    signal: opts.signal,
  });
  return result ?? {
    orientation: null,
    recentDecisions: [],
    activePlan: null,
    recentCheckpoints: [],
    activeAgents: [],
    activeFiles: [],
    codebaseSummary: null,
    lastSyncAt: null,
  };
}

/**
 * Get what the user is currently working on across all surfaces — active
 * projects (with their active plan / files / agents) plus a unified recent-work
 * feed. Uses the authenticated account, scoped via the broker token.
 */
export async function getActiveSession(
  opts: { signal?: AbortSignal } = {}
): Promise<ActiveSession> {
  const result = await request<ActiveSession>({
    method: 'GET',
    path: '/intelligence/active-session',
    signal: opts.signal,
  });
  return result ?? { activeProjects: [], recentWork: [] };
}
