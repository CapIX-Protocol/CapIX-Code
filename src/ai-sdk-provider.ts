import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  ProviderV3,
  SharedV3ProviderMetadata,
} from '@ai-sdk/provider';

import {
  CapixHttpError,
  stream as capixStream,
  type CapixClientMeta,
  type CapixProviderChunk,
  type CapixQualityTier,
  type CapixStreamInput,
} from './capix-provider.js';

export interface CapixAiSdkProviderOptions {
  projectId?: string;
  savedPolicyId?: string;
  privateEndpointId?: string;
  preferredProvider?: 'auto' | 'openrouter' | 'surplus' | 'usepod';
  preferredModel?: string;
  /** Smart-router quality tier for every call (X-Capix-Quality-Tier). */
  qualityTier?: CapixQualityTier;
  /** Specialist subagent role, forwarded as X-Capix-Agent-Class metadata. */
  agentClass?: string;
  meta?: Partial<CapixClientMeta>;
  /** Test/native injection point; defaults to the strict broker-backed transport. */
  transport?: typeof capixStream;
}

const DEFAULT_META: CapixClientMeta = {
  releaseId: 'bundled',
  client: 'capix-code',
  clientVersion: '2.4.15',
  pluginVersion: '2.4.15',
  acpVersion: '1',
};

const ROUTE_OBSERVER = Symbol.for('capix.code.routeObserver');
type RouteObserverGlobal = typeof globalThis & {
  [ROUTE_OBSERVER]?: ((servedModel: string) => void) | null;
};

/** Bridge route metadata into the Capix TUI without coupling the provider to UI modules. */
export function setRouteObserver(observer: ((servedModel: string) => void) | null): void {
  (globalThis as RouteObserverGlobal)[ROUTE_OBSERVER] = observer;
}

export interface CapixToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CapixMessage {
  role: string;
  content: string | null;
  tool_calls?: CapixToolCall[];
  tool_call_id?: string;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return String(part);
      const p = part as unknown as Record<string, unknown>;
      if (p.type === 'text' || p.type === 'reasoning') return String(p.text ?? '');
      if (p.type === 'tool-call') return JSON.stringify({ toolCall: p.toolName, input: p.input });
      if (p.type === 'tool-result')
        return JSON.stringify({ toolResult: p.toolName, result: p.output ?? p.result });
      return JSON.stringify(p);
    })
    .join('\n');
}

function toolResultText(part: Record<string, unknown>): string {
  const output = part.output ?? part.result;
  if (typeof output === 'string') return output;
  // AI SDK v2 tool outputs may be {type:'text', value} or structured content.
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (o.type === 'text' && typeof o.value === 'string') return o.value;
    if (o.type === 'error-text' && typeof o.value === 'string') return o.value;
  }
  return JSON.stringify(output ?? null);
}

/**
 * Map the AI SDK v2 prompt into OpenAI-valid chat messages. Assistant
 * tool-call parts become a real `tool_calls` array and tool results become
 * {role:'tool', tool_call_id} messages, preserving the invariant every
 * OpenAI-compatible lane enforces (a tool message must answer a tool_call).
 */
export function toCapixMessages(
  prompt: LanguageModelV3CallOptions['prompt']
): CapixMessage[] {
  const out: CapixMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const textParts: unknown[] = [];
      const toolCalls: CapixToolCall[] = [];
      for (const part of message.content) {
        if (part && typeof part === 'object' && (part as unknown as Record<string, unknown>).type === 'tool-call') {
          const p = part as unknown as Record<string, unknown>;
          toolCalls.push({
            id: String(p.toolCallId ?? p.id ?? `call_${toolCalls.length}`),
            type: 'function',
            function: {
              name: String(p.toolName ?? 'tool'),
              arguments: JSON.stringify(p.input ?? p.args ?? {}),
            },
          });
        } else {
          textParts.push(part);
        }
      }
      const content = textParts.length > 0 ? textOf(textParts) : null;
      out.push(toolCalls.length > 0 ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content: content ?? '' });
      continue;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object' && (part as unknown as Record<string, unknown>).type === 'tool-result') {
          const p = part as unknown as Record<string, unknown>;
          out.push({
            role: 'tool',
            tool_call_id: String(p.toolCallId ?? ''),
            content: toolResultText(p),
          });
        } else {
          out.push({ role: 'user', content: textOf([part]) });
        }
      }
      continue;
    }
    out.push({ role: message.role, content: textOf(message.content) });
  }
  return out;
}

export function toCapixInput(
  modelId: string,
  options: LanguageModelV3CallOptions
): CapixStreamInput {
  return {
    model: modelId,
    messages: toCapixMessages(options.prompt),
    tools: options.tools,
  };
}

/**
 * Map the gateway's finish reason onto the AI SDK v3 shape: the unified
 * reason drives engine control flow; the raw gateway string is preserved for
 * diagnostics.
 */
function finishReason(reason: string): LanguageModelV3FinishReason {
  const unified = ((): LanguageModelV3FinishReason['unified'] => {
    if (reason === 'tool_calls') return 'tool-calls';
    if (reason === 'content_filter') return 'content-filter';
    switch (reason) {
      case 'stop':
      case 'length':
      case 'content-filter':
      case 'tool-calls':
      case 'error':
        return reason;
      default:
        return 'other';
    }
  })();
  return { unified, raw: reason };
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function metadata(
  receiptId?: string,
  extra: Record<string, unknown> = {}
): SharedV3ProviderMetadata {
  return { capix: { ...(receiptId ? { receiptId } : {}), ...extra } } as SharedV3ProviderMetadata;
}


/** 429/5xx/timeout/stream-stall and gateway retry-classified failures are retryable. */
function isTransientProviderError(err: unknown): boolean {
  const e = err as { message?: string; capixCode?: string; retryClass?: 'none' | 'retry' | 'retry-after'; status?: number };
  if (!e) return false;
  if (e.retryClass === 'retry' || e.retryClass === 'retry-after') return true;
  if (e.retryClass === 'none') return false;
  const code = e.capixCode ?? '';
  if (code === 'provider_rate_limited' || code === 'inference_route_failed' || code === 'ledger_unavailable' || code === 'STREAM_STALLED') return true;
  if (typeof e.status === 'number' && (e.status === 429 || e.status >= 500)) return true;
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('route temporarily unavailable') ||
    msg.includes(' 429') || msg.includes('status 429') ||
    msg.includes(' 500') || msg.includes(' 502') || msg.includes(' 503') || msg.includes(' 504') ||
    msg.includes('timeout') || msg.includes('timed out') || msg.includes('stall')
  );
}
export class CapixLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'capix';
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    readonly modelId: string,
    private readonly config: CapixAiSdkProviderOptions = {}
  ) {}

  private async *chunks(options: LanguageModelV3CallOptions): AsyncGenerator<CapixProviderChunk> {
    // Transient retry on the plain-run path (the engine core calls this
    // directly — the invoker's retry never covers it). Retry the whole
    // stream ONLY before any content: a lane that 500s/stalls at first
    // contact is retried with backoff; once content flows, errors propagate.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      let emittedContent = false;
      let pendingError: unknown = null;
      try {
        yield* this.chunksOnce(options, (chunk) => {
          if (chunk.type === 'text' || chunk.type === 'reasoning' || chunk.type === 'tool') emittedContent = true;
        });
        return;
      } catch (err) {
        pendingError = err;
      }
      const transient = isTransientProviderError(pendingError);
      if (emittedContent || !transient || attempt >= MAX_ATTEMPTS || options.abortSignal?.aborted) {
        throw pendingError;
      }
      const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  private chunksOnce(options: LanguageModelV3CallOptions, onChunk?: (chunk: CapixProviderChunk) => void): AsyncGenerator<CapixProviderChunk> {
    const source = (this.config.transport ?? capixStream)(toCapixInput(this.modelId, options), {
      signal: options.abortSignal,
      projectId: this.config.projectId,
      savedPolicyId: this.config.savedPolicyId,
      privateEndpointId: this.config.privateEndpointId,
      preferredProvider: this.config.preferredProvider,
      preferredModel: this.config.preferredModel,
      qualityTier: this.config.qualityTier,
      agentClass: this.config.agentClass,
      maxTokens: options.maxOutputTokens,
      temperature: options.temperature,
      meta: { ...DEFAULT_META, ...this.config.meta, client: 'capix-code' },
    });
    if (!onChunk) return source;
    return (async function* () {
      for await (const chunk of source) { onChunk(chunk); yield chunk; }
    })();
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const source = this.chunks(options);
    let receiptId: string | undefined;
    let usage = EMPTY_USAGE;
    let cost: { amount: string; asset: string; scale: number } | undefined;
    let textOpen = false;
    let reasoningOpen = false;
    const tools = new Map<string, { name: string; input: string }>();

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        try {
          for await (const chunk of source) {
            switch (chunk.type) {
              case 'route':
                receiptId = chunk.receiptId;
                (globalThis as RouteObserverGlobal)[ROUTE_OBSERVER]?.(chunk.model);
                controller.enqueue({
                  type: 'response-metadata',
                  id: chunk.receiptId,
                  modelId: chunk.model,
                });
                break;
              case 'text':
                if (!textOpen) {
                  textOpen = true;
                  controller.enqueue({
                    type: 'text-start',
                    id: 'text-0',
                    providerMetadata: metadata(receiptId),
                  });
                }
                controller.enqueue({ type: 'text-delta', id: 'text-0', delta: chunk.delta });
                break;
              case 'reasoning':
                if (!reasoningOpen) {
                  reasoningOpen = true;
                  controller.enqueue({ type: 'reasoning-start', id: 'reasoning-0' });
                }
                controller.enqueue({
                  type: 'reasoning-delta',
                  id: 'reasoning-0',
                  delta: chunk.delta,
                });
                break;
              case 'tool': {
                const prior = tools.get(chunk.toolCallId);
                const name = chunk.function?.name ?? prior?.name ?? 'unknown';
                const delta = chunk.function?.arguments ?? '';
                if (!prior) {
                  tools.set(chunk.toolCallId, { name, input: delta });
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: chunk.toolCallId,
                    toolName: name,
                  });
                } else {
                  prior.name = name;
                  prior.input += delta;
                }
                if (delta)
                  controller.enqueue({ type: 'tool-input-delta', id: chunk.toolCallId, delta });
                break;
              }
              case 'usage':
                usage = {
                  inputTokens: {
                    total: chunk.input,
                    noCache: undefined,
                    cacheRead: chunk.cacheRead,
                    cacheWrite: chunk.cacheWrite,
                  },
                  outputTokens: { total: chunk.output, text: undefined, reasoning: undefined },
                };
                // The receipt's provisional cost is the authoritative billed
                // amount (the catalog list price for capix/auto is zero), so
                // forward it for the engine's step-finish cost.
                if (chunk.cost) cost = chunk.cost;
                break;
              case 'finish':
                if (reasoningOpen) {
                  controller.enqueue({ type: 'reasoning-end', id: 'reasoning-0' });
                  reasoningOpen = false;
                }
                if (textOpen) {
                  controller.enqueue({ type: 'text-end', id: 'text-0' });
                  textOpen = false;
                }
                for (const [id, tool] of tools) {
                  controller.enqueue({ type: 'tool-input-end', id });
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: id,
                    toolName: tool.name,
                    input: tool.input,
                  });
                }
                receiptId = chunk.receiptId || receiptId;
                controller.enqueue({
                  type: 'finish',
                  finishReason: finishReason(chunk.finishReason),
                  usage,
                  providerMetadata: metadata(receiptId, {
                    retryCount: chunk.retryCount ?? 0,
                    ...(cost
                      ? { costUsd: Number(cost.amount) / 10 ** cost.scale, costAsset: cost.asset }
                      : {}),
                  }),
                });
                controller.close();
                return;
              case 'error':
                // Re-throw as a typed CapixHttpError so the gateway's
                // supportId/traceId and capixCode survive serialization into
                // the engine's session.error payload.
                controller.enqueue({
                  type: 'error',
                  error: new CapixHttpError(
                    0,
                    chunk.capixCode,
                    chunk.message,
                    chunk.supportId,
                    chunk.retryClass ?? 'none',
                    chunk.retryAfterMs
                  ),
                });
                controller.close();
                return;
            }
          }
          if (reasoningOpen) controller.enqueue({ type: 'reasoning-end', id: 'reasoning-0' });
          if (textOpen) controller.enqueue({ type: 'text-end', id: 'text-0' });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: 'error', error });
          controller.close();
        }
      },
      async cancel() {
        await source.return(undefined);
      },
    });
    return { stream, request: { body: toCapixInput(this.modelId, options) } };
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const result = await this.doStream(options);
    const reader = result.stream.getReader();
    const content: LanguageModelV3Content[] = [];
    let text = '';
    let usage = EMPTY_USAGE;
    let reason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
    let providerMetadata: SharedV3ProviderMetadata | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'text-delta') text += value.delta;
      if (value.type === 'tool-call') content.push(value);
      if (value.type === 'finish') {
        usage = value.usage;
        reason = value.finishReason;
        providerMetadata = value.providerMetadata;
      }
      if (value.type === 'error') throw value.error;
    }
    if (text) content.unshift({ type: 'text', text });
    return { content, finishReason: reason, usage, providerMetadata, warnings: [] };
  }
}

export function createCapix(options: CapixAiSdkProviderOptions = {}) {
  const provider = ((modelId: string) => new CapixLanguageModel(modelId, options)) as ((
    modelId: string
  ) => LanguageModelV3) &
    Partial<ProviderV3>;
  provider.languageModel = (modelId: string) => new CapixLanguageModel(modelId, options);
  return provider;
}

export const capix = createCapix();
export default createCapix;
