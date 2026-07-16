import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();

import { CapixLanguageModel } from '../src/ai-sdk-provider';
import { readPreferredProvider } from '../src/capix-provider';

const call = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  abortSignal: new AbortController().signal,
};

async function collect(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  const out: unknown[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return out;
    out.push(next.value);
  }
}

describe('bundled Capix AI SDK provider', () => {
  it('normalizes route preference and fails safe to auto', () => {
    process.env.CAPIX_PREFERRED_PROVIDER = 'openrouter';
    expect(readPreferredProvider()).toBe('openrouter');
    process.env.CAPIX_PREFERRED_PROVIDER = 'unknown-lane';
    expect(readPreferredProvider()).toBe('auto');
    delete process.env.CAPIX_PREFERRED_PROVIDER;
  });
  beforeEach(() => streamMock.mockReset());

  it('loads through the local package name OpenCode receives from api.npm', async () => {
    const runtime = await import('@capix/runtime-provider');
    const model = runtime.createCapix().languageModel!('auto');
    expect(model.specificationVersion).toBe('v2');
    expect(model.provider).toBe('capix');
    expect(model.modelId).toBe('auto');
  });

  it('maps text, tool deltas, usage and terminal receipt to LanguageModelV2', async () => {
    streamMock.mockImplementation(async function* () {
      yield {
        type: 'route',
        receiptId: 'receipt-1',
        model: 'model-a',
        region: 'gb',
        privacyClass: 'private',
      };
      yield { type: 'text', delta: 'hello ' };
      yield { type: 'text', delta: 'world' };
      yield {
        type: 'tool',
        toolCallId: 'tool-1',
        index: 0,
        function: { name: 'read', arguments: '{"p"' },
      };
      yield { type: 'tool', toolCallId: 'tool-1', index: 0, function: { arguments: ':"x"}' } };
      yield { type: 'usage', input: 4, output: 6, cacheRead: 2 };
      yield { type: 'finish', finishReason: 'tool_calls', receiptId: 'receipt-1', retryCount: 1 };
    });

    const result = await new CapixLanguageModel('auto', { transport: streamMock }).doStream(call);
    const events = (await collect(result.stream)) as Array<Record<string, unknown>>;
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.delta)).toEqual([
      'hello ',
      'world',
    ]);
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({
      toolCallId: 'tool-1',
      toolName: 'read',
      input: '{"p":"x"}',
    });
    expect(events.find((e) => e.type === 'finish')).toMatchObject({
      finishReason: 'tool-calls',
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10, cachedInputTokens: 2 },
      providerMetadata: { capix: { receiptId: 'receipt-1', retryCount: 1 } },
    });
    expect(streamMock.mock.calls[0][1].signal).toBe(call.abortSignal);
  });

  it('aggregates the same strict stream for non-streaming generation', async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: 'text', delta: 'complete' };
      yield { type: 'usage', input: 1, output: 1 };
      yield { type: 'finish', finishReason: 'stop', receiptId: 'r2' };
    });
    const result = await new CapixLanguageModel('auto', { transport: streamMock }).doGenerate(call);
    expect(result.content).toEqual([{ type: 'text', text: 'complete' }]);
    expect(result.providerMetadata).toEqual({ capix: { receiptId: 'r2', retryCount: 0 } });
  });
});
