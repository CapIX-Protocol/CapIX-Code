import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  ProviderV2,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';

import {
  stream as capixStream,
  type CapixClientMeta,
  type CapixProviderChunk,
  type CapixStreamInput,
} from './capix-provider.js';

export interface CapixAiSdkProviderOptions {
  projectId?: string;
  savedPolicyId?: string;
  privateEndpointId?: string;
  preferredProvider?: 'auto' | 'openrouter' | 'surplus' | 'usepod';
  preferredModel?: string;
  meta?: Partial<CapixClientMeta>;
  /** Test/native injection point; defaults to the strict broker-backed transport. */
  transport?: typeof capixStream;
}

const DEFAULT_META: CapixClientMeta = {
  releaseId: 'bundled',
  client: 'capix-code',
  clientVersion: '2.3.0',
  pluginVersion: '2.3.0',
  acpVersion: '1',
};

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return String(part);
      const p = part as Record<string, unknown>;
      if (p.type === 'text' || p.type === 'reasoning') return String(p.text ?? '');
      if (p.type === 'tool-call') return JSON.stringify({ toolCall: p.toolName, input: p.input });
      if (p.type === 'tool-result')
        return JSON.stringify({ toolResult: p.toolName, result: p.output ?? p.result });
      return JSON.stringify(p);
    })
    .join('\n');
}

export function toCapixInput(
  modelId: string,
  options: LanguageModelV2CallOptions
): CapixStreamInput {
  return {
    model: modelId,
    messages: options.prompt.map((message) => ({
      role: message.role,
      content: textOf(message.content),
    })),
    tools: options.tools,
  };
}

function finishReason(reason: string): LanguageModelV2FinishReason {
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
}

const EMPTY_USAGE: LanguageModelV2Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

function metadata(
  receiptId?: string,
  extra: Record<string, unknown> = {}
): SharedV2ProviderMetadata {
  return { capix: { ...(receiptId ? { receiptId } : {}), ...extra } } as SharedV2ProviderMetadata;
}

export class CapixLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'capix';
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    readonly modelId: string,
    private readonly config: CapixAiSdkProviderOptions = {}
  ) {}

  private chunks(options: LanguageModelV2CallOptions): AsyncGenerator<CapixProviderChunk> {
    return (this.config.transport ?? capixStream)(toCapixInput(this.modelId, options), {
      signal: options.abortSignal,
      projectId: this.config.projectId,
      savedPolicyId: this.config.savedPolicyId,
      privateEndpointId: this.config.privateEndpointId,
      preferredProvider: this.config.preferredProvider,
      preferredModel: this.config.preferredModel,
      maxTokens: options.maxOutputTokens,
      temperature: options.temperature,
      meta: { ...DEFAULT_META, ...this.config.meta, client: 'capix-code' },
    });
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const source = this.chunks(options);
    let receiptId: string | undefined;
    let usage = EMPTY_USAGE;
    let textOpen = false;
    const tools = new Map<string, { name: string; input: string }>();

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        try {
          for await (const chunk of source) {
            switch (chunk.type) {
              case 'route':
                receiptId = chunk.receiptId;
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
                  inputTokens: chunk.input,
                  outputTokens: chunk.output,
                  totalTokens: chunk.input + chunk.output,
                  cachedInputTokens: chunk.cacheRead,
                };
                break;
              case 'finish':
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
                  providerMetadata: metadata(receiptId, { retryCount: chunk.retryCount ?? 0 }),
                });
                controller.close();
                return;
              case 'error':
                controller.enqueue({ type: 'error', error: chunk });
                controller.close();
                return;
            }
          }
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

  async doGenerate(options: LanguageModelV2CallOptions) {
    const result = await this.doStream(options);
    const reader = result.stream.getReader();
    const content: LanguageModelV2Content[] = [];
    let text = '';
    let usage = EMPTY_USAGE;
    let reason: LanguageModelV2FinishReason = 'unknown';
    let providerMetadata: SharedV2ProviderMetadata | undefined;
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
  ) => LanguageModelV2) &
    Partial<ProviderV2>;
  provider.languageModel = (modelId: string) => new CapixLanguageModel(modelId, options);
  return provider;
}

export const capix = createCapix();
export default createCapix;
