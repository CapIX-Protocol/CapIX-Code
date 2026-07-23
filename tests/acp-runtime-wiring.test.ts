import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInvoker } from '@capix/agent-runtime';

import { createAcpRuntime } from '../src/acp/transport.js';

const runtimes: Array<{ close(): void }> = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  delete process.env.CAPIX_AGENT_RUNTIME_DB;
});

describe('P0 ACP model wiring', () => {
  it('streams an IDE agent turn through the configured Capix model invoker', async () => {
    process.env.CAPIX_AGENT_RUNTIME_DB = ':memory:';
    const requests: Array<{ modelId: string; content: string }> = [];
    const invoker: ModelInvoker = async function* (request) {
      requests.push({
        modelId: request.modelId,
        content: request.messages[request.messages.length - 1]?.content ?? '',
      });
      yield { type: 'text', delta: 'Capix ACP is live' };
      yield { type: 'usage', inputUnits: 3, outputUnits: 4, costMinor: '5' };
    };
    const runtime = createAcpRuntime({ modelInvoker: invoker });
    runtimes.push(runtime);
    const session = await runtime.createSession({ modelId: 'capix/auto', mode: 'build' });

    const events = [];
    for await (const event of runtime.sendMessage({
      sessionId: session.id,
      content: 'Inspect this workspace',
    })) {
      events.push(event);
    }

    expect(requests).toEqual([{ modelId: 'capix/auto', content: 'Inspect this workspace' }]);
    expect(events.some((event) => event.type === 'content.delta')).toBe(true);
    expect(events.some((event) => event.type === 'usage.updated')).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
  });
});
