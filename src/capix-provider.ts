/**
 * Capix provider — real implementation against the OpenCode plugin contract.
 *
 * This module is the "Capix-specific provider implementation" called for in
 * CAPIX_CUSTOMER_PRODUCTION_ARCHITECTURE.md §12.4: it deliberately does NOT use
 * generic OpenAI compatibility, because that layer would lose tool-call
 * streaming, cancellation, typed errors, and receipt/usage metadata.
 *
 * Contract obligations enforced here (master prompt C2/C4, architecture §12.3–12.4):
 *
 * - Communicates ONLY with the local broker. It never holds a refresh/device
 *   token and never calls the CapIX control/inference edge directly with a
 *   stored bearer. The broker hands a one-shot short-lived access token over an
 *   inherited descriptor / locked per-user socket with peer PID/UID checks.
 * - Uses generated SDK types (@capix/contracts inference-stream + route-receipt
 *   and @opencode-ai/sdk Model/Provider/Auth types) for type safety.
 * - Supports streaming, cancellation (AbortSignal), tool calls, and
 *   usage/receipt metadata.
 * - Never classifies prompts, scores providers, retains router memory, or
 *   rewrites a private base URL. Model selection is server-authoritative.
 * - HTTP error mapping: 401 refresh-once; 402 top-up UI; 409 duplicate;
 *   429 retry timing; fallback only before first customer-visible output.
 */

import type { Model, Provider, Auth } from '@opencode-ai/sdk/v2';
import type { ProviderHook, ProviderHookContext } from '@opencode-ai/plugin';
import type {
  InferenceRequest,
  InferenceStreamChunk,
  CapixRouteEvent,
  ContentDeltaEvent,
  ToolDeltaEvent,
  CapixUsageEvent,
  CapixFinalEvent,
  CapixErrorEvent,
  InferenceErrorResponse,
} from '@capix/contracts';

import { CredentialBroker } from './broker.js';
import { logger } from './logger.js';
import { assertSpendCapNotExceeded, recordSpendCapCost } from './spend-cap.js';
import { buildInferenceUrl, buildModelsUrl, validateBaseUrl } from './url-builder.js';

/** Default production origins. Overridable by config; never by env secret. */
export const CAPIX_API_BASE = 'https://www.capix.network/api/v1';
export const CAPIX_INFERENCE_BASE = 'https://www.capix.network/api/v1';

export function readPreferredProvider(): 'auto' | 'openrouter' | 'surplus' | 'usepod' {
  const value = process.env.CAPIX_PREFERRED_PROVIDER?.trim().toLowerCase();
  return value === 'openrouter' || value === 'surplus' || value === 'usepod' ? value : 'auto';
}

/** Smart-router quality tiers accepted by the inference route. */
export type CapixQualityTier = 'fast' | 'balanced' | 'best';

/**
 * Resolve the quality tier for inference calls: explicit option wins, then
 * `CAPIX_QUALITY_TIER` (set by `capix-code run --tier`), then 'balanced' —
 * matching the router's own degradation for missing/unknown values.
 */
export function readQualityTier(value?: string | null): CapixQualityTier {
  const raw = (value ?? process.env.CAPIX_QUALITY_TIER ?? '').trim().toLowerCase();
  return raw === 'fast' || raw === 'best' ? raw : 'balanced';
}

/** Client/release identification attached to every request. */
export interface CapixClientMeta {
  releaseId: string;
  client: 'capix-code';
  clientVersion: string;
  pluginVersion: string;
  acpVersion: string;
}

/** Options handed to the streaming entry point. */
export interface CapixStreamOptions {
  /** Cancellation signal from the engine/TUI. Honored at every SSE boundary. */
  signal?: AbortSignal;
  /** Optional project context for audience/project-scoped tokens. */
  projectId?: string;
  /** Saved server policy id (server-authoritative routing). */
  savedPolicyId?: string;
  /** Owned private endpoint id (stable model target), if selected. */
  privateEndpointId?: string;
  /** Preferred Capix route; the control plane falls back if it is unavailable. */
  preferredProvider?: 'auto' | 'openrouter' | 'surplus' | 'usepod';
  /** Preferred model when the active target is capix/auto. */
  preferredModel?: string;
  /**
   * Smart-router quality tier, sent as `X-Capix-Quality-Tier` on the
   * inference call. Defaults to `CAPIX_QUALITY_TIER` / 'balanced'.
   */
  qualityTier?: CapixQualityTier;
  /**
   * Specialist subagent role (explore/implement/test/review/security/deploy),
   * sent as `X-Capix-Agent-Class`. The router does not read a task-class
   * field today — intent is inferred server-side from message text — so this
   * is forward-compatible request metadata, not a routing contract.
   */
  agentClass?: string;
  /** Client/release metadata attached as headers. */
  meta: CapixClientMeta;
  /** Max output tokens, if the engine set one. */
  maxTokens?: number;
  /** Sampling temperature, if the engine set one. */
  temperature?: number;
}

/**
 * Chunk the engine consumes. These map directly onto OpenCode Part types
 * (TextPart / ReasoningPart / ToolPart / step-finish) and the Capix receipt
 * event stream. The provider never invents its own message protocol.
 */
export type CapixProviderChunk =
  | { type: 'route'; receiptId: string; model: string; region: string; privacyClass: string }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool';
      toolCallId: string;
      index: number;
      function?: { name?: string; arguments?: string };
    }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { amount: string; asset: string; scale: number };
    }
  | {
      type: 'finish';
      finishReason: CapixFinalEvent['finishReason'];
      receiptId: string;
      retryCount?: number;
    }
  | {
      type: 'error';
      capixCode: string;
      message: string;
      supportId?: string;
      retryClass?: 'none' | 'retry' | 'retry-after';
      retryAfterMs?: number;
    };

/**
 * Capix stream input. The engine fills this from the active session's message
 * list; the provider does not inspect or classify message contents.
 */
export interface CapixStreamInput {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
}

/** A Capix catalog model as returned by GET /v1/models (stable server IDs). */
export interface CapixCatalogModel {
  id: string;
  name?: string;
  label?: string;
  capabilities:
    | string[]
    | {
        toolCall: boolean;
        reasoning: boolean;
        attachment: boolean;
        modalities: { input: string[]; output: string[] };
      };
  contextWindow: number;
  maxOutput?: number;
  maxModelLen?: number;
  pricing: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    inputPerMillionTokens?: number;
    outputPerMillionTokens?: number;
  };
  status?: 'alpha' | 'beta' | 'active' | 'deprecated';
  available?: boolean;
  privacyClass?: string;
  regions?: string[];
}

/** Classified HTTP error with a Capix code and retry semantics. */
export class CapixHttpError extends Error {
  constructor(
    readonly status: number,
    readonly capixCode: string,
    message: string,
    readonly supportId?: string,
    readonly retryClass: 'none' | 'retry' | 'retry-after' = 'none',
    readonly retryAfterMs?: number,
    readonly body?: InferenceErrorResponse
  ) {
    super(message);
    this.name = 'CapixHttpError';
  }
}

/**
 * Lazily-resolved broker.
 *
 * The AI SDK loads provider packages before it finishes loading plugins.  A
 * nullable accessor therefore made first-run model discovery depend on module
 * evaluation order and could fail with "accessor not registered" even though
 * the native credential bridge was already available.  The default remains
 * the real CredentialBroker; plugin startup and tests can still replace the
 * accessor explicitly.
 */
let defaultBroker: CredentialBroker | null = null;
let brokerAccessor: () => CredentialBroker = () => {
  if (!defaultBroker) defaultBroker = new CredentialBroker();
  return defaultBroker;
};

export function setBrokerAccessor(accessor: () => CredentialBroker): void {
  brokerAccessor = accessor;
}

function broker(): CredentialBroker {
  return brokerAccessor();
}

/** Resolve the inference base URL from config (never from a stored secret). */
let inferenceBaseResolver: () => string = () => CAPIX_INFERENCE_BASE;

export function setInferenceBaseResolver(resolver: () => string): void {
  inferenceBaseResolver = resolver;
}

function inferenceBase(): string {
  const raw = inferenceBaseResolver();
  const validation = validateBaseUrl(raw);
  if (!validation.ok) {
    throw new Error(
      `Capix inference base URL is invalid: ${validation.error}. Set CAPIX_INFERENCE_BASE to an absolute https URL.`
    );
  }
  return raw.replace(/\/+$/, '');
}

function apiBase(): string {
  const raw = CAPIX_API_BASE;
  const validation = validateBaseUrl(raw);
  if (!validation.ok) {
    throw new Error(
      `Capix API base URL is invalid: ${validation.error}. Set CAPIX_API_BASE to an absolute https URL.`
    );
  }
  return raw.replace(/\/+$/, '');
}

/** Attach client/release metadata as headers (no secrets). */
function metaHeaders(meta: CapixClientMeta, requestId: string): Record<string, string> {
  return {
    'X-Capix-Client': meta.client,
    'X-Capix-Client-Version': meta.clientVersion,
    'X-Capix-Release-Id': meta.releaseId,
    'X-Capix-Plugin-Version': meta.pluginVersion,
    'X-Capix-Acp-Version': meta.acpVersion,
    'X-Capix-Request-Id': requestId,
    'X-Capix-Source': 'capix-code',
  };
}

/** Generate a cryptographically random request id. */
function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Classify a non-2xx HTTP response into a typed CapixHttpError. */
async function classifyHttpError(res: Response): Promise<never> {
  const status = res.status;
  let body: InferenceErrorResponse | undefined;
  try {
    body = (await res.json()) as InferenceErrorResponse;
  } catch {
    body = undefined;
  }
  const problem = body as (InferenceErrorResponse & {
    detail?: string;
    title?: string;
    code?: string;
    retryAfterSeconds?: number;
    error?: string | { message?: string; code?: string };
  }) | undefined;
  const nestedError = typeof problem?.error === 'object' ? problem.error : undefined;
  const capixCode =
    problem?.capixCode ?? problem?.code ?? nestedError?.code ?? `HTTP_${status}`;
  const message =
    problem?.message ??
    problem?.detail ??
    nestedError?.message ??
    (typeof problem?.error === 'string' ? problem.error : undefined) ??
    problem?.title ??
    res.statusText ??
    'inference request failed';
  const supportId = problem?.supportId ?? problem?.traceId;
  const retryAfter = res.headers.get('retry-after');
  const retryAfterMs =
    retryAfter !== null
      ? Math.max(0, parseFloat(retryAfter) * 1000)
      : problem?.retryAfterSeconds !== undefined
        ? Math.max(0, problem.retryAfterSeconds * 1000)
        : undefined;

  switch (status) {
    case 401:
      // Auth — caller refreshes once before retrying.
      throw new CapixHttpError(status, capixCode, message, supportId, 'retry');
    case 402:
      // Funds — surface top-up UI; not retryable in-band.
      throw new CapixHttpError(status, capixCode, message, supportId, 'none');
    case 409:
      // Duplicate / in-flight — do not retry.
      throw new CapixHttpError(status, capixCode, message, supportId, 'none');
    case 429:
      throw new CapixHttpError(status, capixCode, message, supportId, 'retry-after', retryAfterMs);
    default: {
      // The server's own retry classification (RFC 9457 extension) wins when
      // present; otherwise 5xx is retryable and everything else is terminal.
      const retryClass = problem?.retryClass ?? (status >= 500 ? 'retry' : 'none');
      throw new CapixHttpError(status, capixCode, message, supportId, retryClass, retryAfterMs);
    }
  }
}

/** Parse a single SSE line into a typed InferenceStreamChunk. */
function parseSseChunk(data: string, eventType?: string): InferenceStreamChunk | null {
  if (!data || data.startsWith(':')) return null;
  try {
    const parsed = JSON.parse(data) as InferenceStreamChunk;
    // The gateway may carry the event kind only in the SSE `event:` line
    // (OpenAI-style payloads have no `type` member) — adopt it when absent.
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type !== 'string' &&
      eventType
    ) {
      (parsed as { type?: string }).type = eventType;
    }
    return parsed;
  } catch {
    logger.warn('capix-provider: unparseable SSE data', { data });
    return null;
  }
}

/**
 * Usage payload shapes seen from the gateway: the canonical flat contract
 * (`inputUnits`/`outputUnits`/`cacheUnits`) and the OpenAI-style variant
 * (`inputTokens`/`outputTokens`, possibly nested under `usage`).
 */
type WildUsageEvent = {
  inputUnits?: number;
  outputUnits?: number;
  cacheUnits?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  provisionalCost?: { amount: string; asset: string; scale: number };
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
};

/** Map one usage payload (capix.usage event or capix.final.finalUsage). */
function mapUsageEvent(u: WildUsageEvent): CapixProviderChunk {
  const nested = u.usage ?? {};
  return {
    type: 'usage',
    input: u.inputUnits ?? u.inputTokens ?? nested.inputTokens ?? 0,
    output: u.outputUnits ?? u.outputTokens ?? nested.outputTokens ?? 0,
    cacheRead: u.cacheUnits ?? u.cacheReadTokens ?? nested.cacheReadTokens,
    cost: u.provisionalCost,
  };
}

/** Map a contract chunk onto the provider chunk shape the engine consumes. */
function mapChunk(chunk: InferenceStreamChunk): CapixProviderChunk {
  switch (chunk.type) {
    case 'capix.route': {
      const r = chunk as CapixRouteEvent;
      return {
        type: 'route',
        receiptId: r.receiptId,
        model: r.modelCapability,
        region: r.region,
        privacyClass: r.privacyClass,
      };
    }
    case 'content.delta': {
      const c = chunk as ContentDeltaEvent;
      return { type: 'text', delta: c.content };
    }
    case 'tool.delta': {
      const t = chunk as ToolDeltaEvent;
      return {
        type: 'tool',
        toolCallId: t.toolCallId,
        index: t.index,
        function: t.function,
      };
    }
    case 'capix.usage': {
      return mapUsageEvent(chunk as CapixUsageEvent);
    }
    case 'capix.final': {
      const f = chunk as CapixFinalEvent;
      return {
        type: 'finish',
        finishReason: f.finishReason,
        receiptId: f.receiptId,
        retryCount: f.retryCount,
      };
    }
    case 'capix.error': {
      const e = chunk as CapixErrorEvent;
      return {
        type: 'error',
        capixCode: e.capixCode,
        message: e.message,
        supportId: e.supportId,
        retryClass: e.retryClass,
        retryAfterMs: e.retryAfterMs,
      };
    }
    default: {
      const exhaustive: never = chunk;
      throw new Error(
        `capix-provider: unhandled stream event ${(exhaustive as { type: string }).type}`
      );
    }
  }
}

/**
 * Stream a chat completion from the Capix inference gateway via the local
 * broker. Yields typed chunks until finish or error. Honors AbortSignal at
 * every boundary. Refreshes exactly once on 401 before first output; falls
 * back only before first customer-visible output.
 */
export async function* stream(
  input: CapixStreamInput,
  options: CapixStreamOptions
): AsyncGenerator<CapixProviderChunk, void, void> {
  const requestId = newRequestId();
  const url = buildInferenceUrl(inferenceBase());
  const requestBody: InferenceRequest = {
    model: input.model,
    messages: input.messages,
    stream: true,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    tools: input.tools,
    projectId: options.projectId,
    savedPolicyId: options.savedPolicyId,
    privateEndpointId: options.privateEndpointId,
    preferredProvider: options.preferredProvider ?? readPreferredProvider(),
    preferredModel: options.preferredModel ?? (process.env.CAPIX_PREFERRED_MODEL?.trim() || undefined),
  };

  let refreshed = false;
  let firstOutputSeen = false;

  const doRequest = async (token: string): Promise<Response> => {
    // Hard spend cap: never issue a new inference call once the run's
    // receipt-accounted spend has reached the budget. Checked here, at the
    // single choke point every inference request flows through, so no code
    // path can overshoot. The cap comes from real receipt cost only.
    assertSpendCapNotExceeded();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': requestId,
        'X-Capix-Quality-Tier': options.qualityTier ?? readQualityTier(),
        ...(options.agentClass ? { 'X-Capix-Agent-Class': options.agentClass } : {}),
        ...metaHeaders(options.meta, requestId),
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
    if (!res.ok && res.status === 401 && !refreshed) {
      refreshed = true;
      process.env.CAPIX_API_KEY = '';
      await broker().refreshToken();
      const fresh = await broker().getAccessToken({ projectId: options.projectId });
      return doRequest(fresh.token);
    }
    if (!res.ok) {
      await classifyHttpError(res);
    }
    return res;
  };

  const access = await broker().getAccessToken({ projectId: options.projectId });
  const res = await doRequest(access.token);
  if (!res.body) {
    throw new CapixHttpError(0, 'NO_STREAM_BODY', 'inference response had no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventType: string | undefined;
  let usageSeen = false;

  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new CapixHttpError(0, 'ABORTED', 'request aborted by caller', undefined, 'none');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIndex: number;
      while ((nlIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nlIndex);
        buffer = buffer.slice(nlIndex + 1);
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event:')) {
          lastEventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const chunk = parseSseChunk(data, lastEventType);
        if (!chunk) continue;
        // capix.final carries authoritative totals in finalUsage; emit them
        // when the stream never sent a standalone capix.usage event so the
        // engine still renders real token/cost figures.
        if (chunk.type === 'capix.final' && !usageSeen) {
          const finalUsage = (chunk as CapixFinalEvent).finalUsage;
          if (finalUsage) {
            usageSeen = true;
            yield mapUsageEvent(finalUsage);
          }
        }
        const mapped = mapChunk(chunk);
        if (mapped.type === 'usage') {
          usageSeen = true;
          // Feed the process-level spend ledger from real receipt cost; the
          // ledger warns once at 90% and blocks new calls at 100%.
          if (mapped.cost) recordSpendCapCost(mapped.cost.amount, mapped.cost.scale);
        }
        if (mapped.type === 'text' || mapped.type === 'tool' || mapped.type === 'reasoning') {
          firstOutputSeen = true;
        }
        yield mapped;
        if (mapped.type === 'finish' || mapped.type === 'error') return;
      }
    }
  } finally {
    reader.releaseLock();
    if (options.signal?.aborted) {
      logger.info('capix-provider: stream aborted', { requestId, firstOutputSeen });
    }
  }
}

/** Fetch the model catalog from GET /v1/models (stable server IDs). */
export async function models(): Promise<Record<string, Model>> {
  const access = await broker().getAccessToken();
  const res = await fetch(buildModelsUrl(apiBase()), {
    headers: { Authorization: `Bearer ${access.token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    await classifyHttpError(res);
  }
  const catalog = (await res.json()) as { models: CapixCatalogModel[] };
  const out: Record<string, Model> = {};
  for (const m of catalog.models) {
    // Provider model keys are relative to `capix/`; preserve the canonical
    // gateway model id on the model itself so inference receives it unchanged.
    const key = m.id.startsWith('capix/') ? m.id.slice('capix/'.length) : m.id;
    out[key] = toSdkModel(m, 'capix');
  }
  // `capix/auto` is always advertised and delegates model selection to the server.
  if (!out['auto']) {
    out['auto'] = toSdkAutoModel();
  }
  return out;
}

/** Return the raw catalog list for display (TUI model picker). */
export async function list(): Promise<CapixCatalogModel[]> {
  const access = await broker().getAccessToken();
  const res = await fetch(buildModelsUrl(apiBase()), {
    headers: { Authorization: `Bearer ${access.token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    await classifyHttpError(res);
  }
  const body = (await res.json()) as { models: CapixCatalogModel[] };
  return body.models;
}

/** Convert a catalog model into the OpenCode SDK Model shape. */
function toSdkModel(m: CapixCatalogModel, providerID: string): Model {
  const capabilityNames = Array.isArray(m.capabilities) ? m.capabilities : [];
  const legacyCapabilities = Array.isArray(m.capabilities) ? undefined : m.capabilities;
  const supports = (name: string) => capabilityNames.includes(name);
  const toolCall = legacyCapabilities?.toolCall ?? supports('tool-calls');
  const reasoning = legacyCapabilities?.reasoning ?? supports('extended-thinking');
  const attachment = legacyCapabilities?.attachment ?? supports('vision');
  const inputModalities =
    legacyCapabilities?.modalities.input ?? (attachment ? ['text', 'image'] : ['text']);
  const outputModalities = legacyCapabilities?.modalities.output ?? ['text'];
  return {
    id: m.id,
    providerID,
    api: {
      id: m.id,
      url: inferenceBase(),
      npm: '@capix/runtime-provider',
    },
    name: m.label ?? m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning,
      attachment,
      toolcall: toolCall,
      input: {
        text: true,
        audio: inputModalities.includes('audio'),
        image: inputModalities.includes('image'),
        video: inputModalities.includes('video'),
        pdf: inputModalities.includes('pdf'),
      },
      output: {
        text: true,
        audio: outputModalities.includes('audio'),
        image: outputModalities.includes('image'),
        video: outputModalities.includes('video'),
        pdf: outputModalities.includes('pdf'),
      },
      interleaved: false,
    },
    cost: {
      input: m.pricing.input ?? m.pricing.inputPerMillionTokens ?? 0,
      output: m.pricing.output ?? m.pricing.outputPerMillionTokens ?? 0,
      cache: {
        read: m.pricing.cacheRead ?? 0,
        write: m.pricing.cacheWrite ?? 0,
      },
    },
    limit: {
      context: m.contextWindow,
      output: m.maxOutput ?? m.maxModelLen ?? 8192,
    },
    status: m.status ?? (m.available === false ? 'alpha' : 'active'),
    options: {},
    headers: {},
    release_date: new Date(0).toISOString(),
  };
}

/** `capix/auto` — server selects the model; client keeps no placement memory. */
function toSdkAutoModel(): Model {
  return {
    id: 'auto',
    providerID: 'capix',
    api: {
      id: 'auto',
      url: inferenceBase(),
      npm: '@capix/runtime-provider',
    },
    name: 'Capix Auto (server-authoritative routing)',
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 64000 },
    status: 'active',
    options: {},
    headers: {},
    release_date: new Date(0).toISOString(),
  };
}

/**
 * Build an OpenCode ProviderHook for the `capix` provider id. The hook is what
 * plugin.ts registers on `Hooks.provider`. The engine calls `models()` to
 * enumerate the catalog; streaming is served by the `stream` generator above
 * through the native provider adapter.
 */
export function createCapixProviderHook(): ProviderHook {
  return {
    id: 'capix',
    models: async (
      _provider: Provider,
      _ctx: ProviderHookContext
    ): Promise<Record<string, Model>> => {
      return models();
    },
  };
}

/** Auth loader: bridge the hook's OAuth flow to the credential broker. */
export async function capixAuthLoader(
  auth: () => Promise<Auth>,
  _provider: Provider
): Promise<Record<string, unknown>> {
  const a = await auth();
  if (a.type === 'oauth') {
    return { Authorization: `Bearer ${a.access}`, 'X-Capix-Account': a.accountId ?? '' };
  }
  if (a.type === 'api') {
    return { Authorization: `Bearer ${a.key}` };
  }
  return {};
}

/** Convenience wrapper for environments that want the legacy object shape. */
export const capixProvider = {
  name: 'capix',
  models,
  stream,
  list,
  createHook: createCapixProviderHook,
  authLoader: capixAuthLoader,
};

export type { ProviderHook, ProviderHookContext };
