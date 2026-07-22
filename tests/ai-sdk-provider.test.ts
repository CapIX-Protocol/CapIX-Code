import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();

import { CapixLanguageModel, setRouteObserver } from '../src/ai-sdk-provider';
import { CapixHttpError, readPreferredProvider } from '../src/capix-provider';

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
  beforeEach(() => {
    streamMock.mockReset();
    setRouteObserver(null);
  });

  it('loads through the local package name OpenCode receives from api.npm', async () => {
    const runtime = await import('@capix/runtime-provider');
    const model = runtime.createCapix().languageModel!('auto');
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('capix');
    expect(model.modelId).toBe('auto');
  });

  it('maps text, tool deltas, usage and terminal receipt to LanguageModelV3', async () => {
    const routed = vi.fn();
    setRouteObserver(routed);
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
      yield {
        type: 'usage',
        input: 4,
        output: 6,
        cacheRead: 2,
        cost: { amount: '1500000', asset: 'USDC', scale: 6 },
      };
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
    // The v3 nested usage shape is what the engine (ai v6 streamText) reads —
    // a flat v2 shape is misread as zeros and the step-finish event then
    // reports {"tokens":{"input":0,"output":0},"cost":0}.
    expect(events.find((e) => e.type === 'finish')).toMatchObject({
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: {
        inputTokens: { total: 4, cacheRead: 2 },
        outputTokens: { total: 6 },
      },
      providerMetadata: {
        capix: { receiptId: 'receipt-1', retryCount: 1, costUsd: 1.5, costAsset: 'USDC' },
      },
    });
    expect(streamMock.mock.calls[0][1].signal).toBe(call.abortSignal);
    expect(routed).toHaveBeenCalledWith('model-a');
  });

  it('wraps reasoning deltas in reasoning-start/end parts', async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: 'reasoning', delta: 'thinking' };
      yield { type: 'text', delta: 'answer' };
      yield { type: 'finish', finishReason: 'stop', receiptId: 'r3' };
    });
    const result = await new CapixLanguageModel('auto', { transport: streamMock }).doStream(call);
    const types = ((await collect(result.stream)) as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual([
      'stream-start',
      'reasoning-start',
      'reasoning-delta',
      'text-start',
      'text-delta',
      'reasoning-end',
      'text-end',
      'finish',
    ]);
  });

  it('re-throws stream error chunks as CapixHttpError preserving supportId and capixCode', async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: 'text', delta: 'partial' };
      yield {
        type: 'error',
        capixCode: 'insufficient_balance',
        message: 'Payment required',
        supportId: 'trace-abc-123',
        retryClass: 'none',
      };
    });
    const result = await new CapixLanguageModel('auto', { transport: streamMock }).doStream(call);
    const events = (await collect(result.stream)) as Array<{ type: string; error?: unknown }>;
    const part = events.find((e) => e.type === 'error');
    expect(part?.error).toBeInstanceOf(CapixHttpError);
    const error = part?.error as CapixHttpError;
    expect(error.message).toBe('Payment required');
    expect(error.capixCode).toBe('insufficient_balance');
    expect(error.supportId).toBe('trace-abc-123');
    expect(error.retryClass).toBe('none');
  });

  it('doGenerate surfaces the wrapped CapixHttpError', async () => {
    streamMock.mockImplementation(async function* () {
      yield {
        type: 'error',
        capixCode: 'inference_route_failed',
        message: 'Route temporarily unavailable',
        supportId: 'trace-def-456',
        retryClass: 'retry',
      };
    });
    await expect(
      new CapixLanguageModel('auto', { transport: streamMock }).doGenerate(call)
    ).rejects.toMatchObject({
      name: 'CapixHttpError',
      message: 'Route temporarily unavailable',
      supportId: 'trace-def-456',
    });
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
