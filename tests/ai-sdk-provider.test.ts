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

import { toCapixMessages } from '../src/ai-sdk-provider';

describe('toCapixMessages — OpenAI-valid tool exchanges', () => {
  it('maps assistant tool-call parts to a structured tool_calls array', () => {
    const out = toCapixMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me write that.' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'write', input: { filePath: 'a.txt', content: 'x' } },
        ],
      } as never,
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'Let me write that.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"filePath":"a.txt","content":"x"}' } },
        ],
      },
    ]);
  });

  it('maps tool results to role:tool messages with tool_call_id', () => {
    const out = toCapixMessages([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'write', output: { type: 'text', value: 'done' } },
        ],
      } as never,
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'done' }]);
  });

  it('keeps plain user/system messages as strings', () => {
    const out = toCapixMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] } as never,
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
