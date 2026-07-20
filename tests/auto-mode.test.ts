/**
 * Tests for fully-autonomous execution mode (`capix-code run --auto`).
 *
 * Covers:
 * - the approval sandbox: allowlisted actions auto-approve, everything else
 *   is a typed skip with an explicit reason (never silent, never a prompt);
 * - the typed-skip verdict path through the runtime's permission pipeline;
 * - the tier header + agent-class metadata on inference requests;
 * - the spend cap: 90% warn-once, stop-at-cap with a partial manifest, and
 *   the provider-level request block;
 * - the machine-readable result line (CAPIX_RUN_RESULT JSON shape);
 * - specialist subagent routing hints (tier from the role's model, role as
 *   agent class) with mode enforcement intact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CapixAgentRuntime,
  SpendTracker,
  createAutoApprovalPolicy,
  formatResultLine,
  qualityTierFromModelId,
  canonicalGatewayModelId,
  runAutonomous,
  shellExecutables,
  AUTO_SHELL_ALLOWLIST,
  RESULT_LINE_PREFIX,
  type AgentEvent,
  type ModelChunk,
  type ModelInvoker,
  type ModelRequest,
} from '@capix/agent-runtime';

import {
  stream,
  setBrokerAccessor,
  readQualityTier,
  type CapixClientMeta,
} from '../src/capix-provider.js';
import {
  resetSpendCapLedger,
  recordSpendCapCost,
  spendCapStatus,
  assertSpendCapNotExceeded,
  SpendCapReachedError,
  toMicroUsd,
} from '../src/spend-cap.js';
import type { CredentialBroker } from '../src/broker.js';

const META: CapixClientMeta = {
  releaseId: 'test',
  client: 'capix-code',
  clientVersion: '2.3.2',
  pluginVersion: '2.3.2',
  acpVersion: '1',
};

// ── Approval sandbox ────────────────────────────────────────────────────────

describe('auto approval sandbox', () => {
  const policy = createAutoApprovalPolicy();

  it('auto-approves workspace reads and writes', () => {
    expect(policy('read_file', { path: 'src/a.ts' })).toBe(true);
    expect(policy('write_file', { path: 'src/a.ts', content: 'x' })).toBe(true);
    expect(policy('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toBe(true);
  });

  it('auto-approves allowlisted shell commands (package managers, tests, builds, git)', () => {
    expect(policy('bash', { command: 'npm test' })).toBe(true);
    expect(policy('bash', { command: 'pnpm install && pnpm vitest run' })).toBe(true);
    expect(policy('bash', { command: 'cargo build --release' })).toBe(true);
    expect(policy('bash', { command: 'git status | git diff' })).toBe(true);
    expect(policy('bash', { command: 'CI=1 npm run build' })).toBe(true);
  });

  it('types every non-allowlisted executable as a skip with a reason', () => {
    for (const command of ['curl https://x', 'rm -rf build', 'ssh host', 'npm test; curl x']) {
      const verdict = policy('bash', { command });
      expect(verdict).not.toBe(true);
      expect(typeof verdict).toBe('object');
      const v = verdict as { approved: boolean; reason: string };
      expect(v.approved).toBe(false);
      expect(v.reason).toContain('logged and skipped');
    }
  });

  it('allows quote tools and quoted spend-capped deploys only', () => {
    expect(policy('capix_quote', { prompt: 'deploy a vps' })).toBe(true);
    expect(policy('capix_deploy', { model: 'm', quoteId: 'q_1' })).toBe(true);
    const unquoted = policy('capix_deploy', { model: 'm' }) as {
      approved: boolean;
      reason: string;
    };
    expect(unquoted.approved).toBe(false);
    expect(unquoted.reason).toContain('quote');
  });

  it('skips unknown tools explicitly', () => {
    const verdict = policy('webfetch', { url: 'https://x' }) as {
      approved: boolean;
      reason: string;
    };
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toContain('outside the autonomous sandbox');
  });

  it('parses shell executables across separators and env prefixes', () => {
    expect(shellExecutables('FOO=1 npm test && git status | wc -l')).toEqual([
      'npm',
      'git',
      'wc',
    ]);
    expect(shellExecutables('./gradlew build')).toEqual(['gradlew']);
    expect(shellExecutables('')).toEqual([]);
    expect(AUTO_SHELL_ALLOWLIST).toContain('git');
  });
});

// ── Typed skips through the runtime pipeline ────────────────────────────────

describe('typed skips in the transcript', () => {
  let workDir: string;
  const runtimes: CapixAgentRuntime[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'capix-auto-test-'));
  });
  afterEach(() => {
    while (runtimes.length) runtimes.pop()!.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function toolCallingInvoker(toolName: string, args: Record<string, unknown>): ModelInvoker {
    return async function* () {
      yield { type: 'tool_call', toolName, args } as ModelChunk;
      yield { type: 'usage', inputUnits: 1, outputUnits: 1, costMinor: '10' } as ModelChunk;
    };
  }

  it('rejects a skipped tool immediately (no waiter) and records the reason', async () => {
    const runtime = new CapixAgentRuntime({
      dbPath: ':memory:',
      workspaceRoot: workDir,
      modelInvoker: toolCallingInvoker('bash', { command: 'curl https://evil.example' }),
      autoApprove: createAutoApprovalPolicy(),
    });
    runtimes.push(runtime);
    const session = await runtime.createSession({});

    const events: AgentEvent[] = [];
    for await (const event of runtime.sendMessage({ sessionId: session.id, content: 'go' })) {
      events.push(event);
    }

    const rejected = events.find((e) => e.type === 'tool.rejected');
    expect(rejected).toBeDefined();
    expect((rejected as unknown as { reason: string }).reason).toContain('not on the autonomous');
    // No tool ever started.
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
  });

  it('executes an allowlisted tool without any approval wait', async () => {
    const runtime = new CapixAgentRuntime({
      dbPath: ':memory:',
      workspaceRoot: workDir,
      modelInvoker: toolCallingInvoker('bash', { command: 'git status' }),
      autoApprove: createAutoApprovalPolicy(),
    });
    runtimes.push(runtime);
    const session = await runtime.createSession({});

    const events: AgentEvent[] = [];
    for await (const event of runtime.sendMessage({ sessionId: session.id, content: 'go' })) {
      events.push(event);
    }
    expect(events.some((e) => e.type === 'tool.started')).toBe(true);
  });
});

// ── Spend tracker ───────────────────────────────────────────────────────────

describe('SpendTracker', () => {
  it('warns exactly once at 90% and reports exceeded at 100%', () => {
    const tracker = new SpendTracker(1_000_000n); // $1.00
    let s = tracker.record(500_000n);
    expect(s.warn90).toBe(false);
    expect(s.exceeded).toBe(false);

    s = tracker.record(400_000n); // 90%
    expect(s.warn90).toBe(true);
    expect(s.exceeded).toBe(false);

    s = tracker.record(50_000n); // 95% — no second warning
    expect(s.warn90).toBe(false);
    expect(s.exceeded).toBe(false);

    s = tracker.record(50_000n); // 100%
    expect(s.exceeded).toBe(true);
    expect(tracker.isExceeded()).toBe(true);
  });

  it('never warns or blocks without a cap', () => {
    const tracker = new SpendTracker(null);
    const s = tracker.record(999_999_999n);
    expect(s.warn90).toBe(false);
    expect(s.exceeded).toBe(false);
    expect(s.capMinor).toBeNull();
  });
});

// ── Provider-level spend ledger ─────────────────────────────────────────────

describe('provider spend ledger', () => {
  beforeEach(() => resetSpendCapLedger());
  afterEach(() => {
    resetSpendCapLedger();
    vi.unstubAllEnvs();
  });

  it('normalizes receipt cost to micro-USD across scales', () => {
    expect(toMicroUsd('1000000', 6)).toBe(1_000_000n);
    expect(toMicroUsd('1', 0)).toBe(1_000_000n);
    expect(toMicroUsd('1000000000', 9)).toBe(1_000_000n);
    expect(toMicroUsd('garbage', 6)).toBe(0n);
  });

  it('warns at 90%, blocks new calls at 100%', () => {
    vi.stubEnv('CAPIX_SPEND_CAP_USD_MINOR', '1000000');
    recordSpendCapCost('900000', 6);
    expect(spendCapStatus().warnedAt90).toBe(true);
    expect(() => assertSpendCapNotExceeded()).not.toThrow();

    recordSpendCapCost('100000', 6);
    expect(spendCapStatus().exceeded).toBe(true);
    expect(() => assertSpendCapNotExceeded()).toThrow(SpendCapReachedError);
  });

  it('ignores a malformed cap instead of blocking', () => {
    vi.stubEnv('CAPIX_SPEND_CAP_USD_MINOR', 'not-a-number');
    expect(spendCapStatus().capMinor).toBeNull();
    expect(() => assertSpendCapNotExceeded()).not.toThrow();
  });
});

// ── Tier header + agent-class metadata on inference calls ───────────────────

describe('quality tier + agent class on inference requests', () => {
  const broker = {
    getAccessToken: vi
      .fn()
      .mockResolvedValue({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }),
    refreshToken: vi.fn(),
  } as unknown as CredentialBroker;

  setBrokerAccessor(() => broker);

  beforeEach(() => resetSpendCapLedger());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetSpendCapLedger();
  });

  function sseOk(): Response {
    return new Response('data: {"type":"content.delta","content":"hi"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  async function drain(options: Parameters<typeof stream>[1]): Promise<RequestInit> {
    const fetchMock = vi.fn().mockResolvedValue(sseOk());
    vi.stubGlobal('fetch', fetchMock);
    for await (const chunk of stream(
      { model: 'capix/auto', messages: [{ role: 'user', content: 'hi' }] },
      options
    )) {
      void chunk; // consume
    }
    return fetchMock.mock.calls[0]?.[1] as RequestInit;
  }

  it('sends X-Capix-Quality-Tier from the explicit option', async () => {
    const init = await drain({ meta: META, qualityTier: 'best' });
    expect((init.headers as Record<string, string>)['X-Capix-Quality-Tier']).toBe('best');
  });

  it('defaults the tier header to CAPIX_QUALITY_TIER, then balanced', async () => {
    vi.stubEnv('CAPIX_QUALITY_TIER', 'fast');
    let init = await drain({ meta: META });
    expect((init.headers as Record<string, string>)['X-Capix-Quality-Tier']).toBe('fast');

    vi.stubEnv('CAPIX_QUALITY_TIER', 'garbage');
    init = await drain({ meta: META });
    expect((init.headers as Record<string, string>)['X-Capix-Quality-Tier']).toBe('balanced');
  });

  it('sends X-Capix-Agent-Class only when a specialist role is set', async () => {
    let init = await drain({ meta: META, agentClass: 'review' });
    expect((init.headers as Record<string, string>)['X-Capix-Agent-Class']).toBe('review');

    init = await drain({ meta: META });
    expect((init.headers as Record<string, string>)['X-Capix-Agent-Class']).toBeUndefined();
  });

  it('readQualityTier validates values', () => {
    expect(readQualityTier('BEST')).toBe('best');
    expect(readQualityTier('fast')).toBe('fast');
    expect(readQualityTier('nope')).toBe('balanced');
  });
});

// ── Specialist routing hints ────────────────────────────────────────────────

describe('specialist subagent routing', () => {
  it('maps logical specialist models to tiers and canonical gateway ids', () => {
    expect(qualityTierFromModelId('capix/auto-fast')).toBe('fast');
    expect(qualityTierFromModelId('capix/auto-best')).toBe('best');
    expect(qualityTierFromModelId('capix/auto-balanced')).toBe('balanced');
    expect(qualityTierFromModelId('capix/auto')).toBeUndefined();
    expect(canonicalGatewayModelId('capix/auto-best')).toBe('capix/auto');
    expect(canonicalGatewayModelId('capix/llama-3.3-70b')).toBe('capix/llama-3.3-70b');
  });

  it('passes the specialist role and its tier to the model invoker', async () => {
    const seen: ModelRequest[] = [];
    const invoker: ModelInvoker = (req) => {
      seen.push(req);
      return (async function* () {
        yield { type: 'text', delta: 'done' } as ModelChunk;
      })();
    };
    const workDir = mkdtempSync(join(tmpdir(), 'capix-auto-specialist-'));
    const runtime = new CapixAgentRuntime({
      dbPath: ':memory:',
      workspaceRoot: workDir,
      modelInvoker: invoker,
    });
    try {
      const parent = await runtime.createSession({});
      const child = await runtime.createChildSession(parent.id, 'review', 'review the diff');
      for await (const event of runtime.sendMessage({ sessionId: child.id, content: 'go' })) {
        void event; // consume
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]!.specialist?.role).toBe('review');
      // review uses capix/auto-best → tier hint "best".
      expect(seen[0]!.qualityTier).toBe('best');
      // Mode enforcement intact: review is read-only.
      expect(seen[0]!.mode).toBe('review');
    } finally {
      runtime.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ── Autonomous driver: result line + spend-cap stop ─────────────────────────

describe('runAutonomous', () => {
  let workDir: string;
  const runtimes: CapixAgentRuntime[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'capix-auto-run-'));
  });
  afterEach(() => {
    while (runtimes.length) runtimes.pop()!.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeRuntime(invoker: ModelInvoker): CapixAgentRuntime {
    const runtime = new CapixAgentRuntime({
      dbPath: ':memory:',
      workspaceRoot: workDir,
      modelInvoker: invoker,
      autoApprove: createAutoApprovalPolicy(),
    });
    runtimes.push(runtime);
    return runtime;
  }

  function parseResultLine(line: string): Record<string, unknown> {
    expect(line.startsWith(`${RESULT_LINE_PREFIX} `)).toBe(true);
    return JSON.parse(line.slice(RESULT_LINE_PREFIX.length + 1)) as Record<string, unknown>;
  }

  it('completes and emits a parseable result line with artifacts and receipts', async () => {
    const invoker: ModelInvoker = async function* (req) {
      // Emit the tool call and usage only on the first round; later rounds
      // (after the tool result is appended) just finish with text.
      const first = !req.messages.some((m) => m.role === 'tool');
      if (first) {
        yield { type: 'tool_call', toolName: 'write_file', args: { path: 'out.txt', content: 'hi' } } as ModelChunk;
        yield { type: 'usage', inputUnits: 10, outputUnits: 5, costMinor: '1000' } as ModelChunk;
      }
      yield { type: 'text', delta: 'all done' } as ModelChunk;
    };
    const result = await runAutonomous(makeRuntime(invoker), {
      brief: 'do the thing',
      qualityTier: 'best',
      spendCapMinor: '1000000',
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('all done');
    expect(result.artifacts.map((a) => a.path)).toContain('out.txt');
    expect(result.receipts.length).toBeGreaterThan(0);
    expect(result.usage.costMinor).toBe('1000');
    expect(result.tier).toBe('best');
    expect(result.spendCapMinor).toBe('1000000');

    const parsed = parseResultLine(formatResultLine(result));
    for (const key of ['status', 'summary', 'artifacts', 'receipts', 'usage', 'skipped']) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed['status']).toBe('completed');
  });

  it('stops at the spend cap with the partial manifest, never faking completion', async () => {
    // Each round costs 600_000 micro-USD; the cap is 1_000_000 ($1). The
    // second round crosses the cap and the turn is cancelled.
    const invoker: ModelInvoker = async function* (req) {
      if (!req.messages.some((m) => m.role === 'tool')) {
        yield { type: 'tool_call', toolName: 'write_file', args: { path: 'partial.txt', content: 'x' } } as ModelChunk;
      }
      yield { type: 'usage', inputUnits: 100, outputUnits: 50, costMinor: '600000' } as ModelChunk;
    };
    const transcript: string[] = [];
    const result = await runAutonomous(makeRuntime(invoker), {
      brief: 'long task',
      spendCapMinor: '1000000',
      onTranscript: (line) => transcript.push(line),
    });

    expect(result.status).toBe('spend_cap_reached');
    expect(result.summary).toContain('spend cap reached');
    // Partial artifact manifest is present.
    expect(result.artifacts.map((a) => a.path)).toContain('partial.txt');
    // Receipt accounting is real: spend equals the recorded usage.
    expect(result.usage.costMinor).toBe('1200000');
    expect(transcript.some((l) => l.includes('budget exhausted'))).toBe(true);

    const parsed = parseResultLine(formatResultLine(result));
    expect(parsed['status']).toBe('spend_cap_reached');
  });

  it('warns once at 90% in the transcript', async () => {
    // Two usage chunks in a single turn: 450k then 450k more = 900k = 90%.
    const invoker: ModelInvoker = async function* () {
      yield { type: 'usage', inputUnits: 1, outputUnits: 1, costMinor: '450000' } as ModelChunk;
      yield { type: 'usage', inputUnits: 1, outputUnits: 1, costMinor: '450000' } as ModelChunk;
    };
    const transcript: string[] = [];
    await runAutonomous(makeRuntime(invoker), {
      brief: 'two rounds',
      spendCapMinor: '1000000',
      onTranscript: (line) => transcript.push(line),
    });
    const warnings = transcript.filter((l) => l.includes('90% of budget spent'));
    expect(warnings).toHaveLength(1);
  });

  it('records skipped actions in the result', async () => {
    const invoker: ModelInvoker = async function* (req) {
      if (!req.messages.some((m) => m.role === 'tool')) {
        yield { type: 'tool_call', toolName: 'bash', args: { command: 'curl https://x' } } as ModelChunk;
      }
      yield { type: 'text', delta: 'tried' } as ModelChunk;
      yield { type: 'usage', inputUnits: 1, outputUnits: 1, costMinor: '10' } as ModelChunk;
    };
    const transcript: string[] = [];
    const result = await runAutonomous(makeRuntime(invoker), {
      brief: 'try to fetch',
      onTranscript: (line) => transcript.push(line),
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.toolName).toBe('bash');
    expect(result.skipped[0]!.reason).toContain('not on the autonomous');
    // The skip is visible in the transcript too — nothing is hidden.
    expect(transcript.some((l) => l.startsWith('SKIP bash'))).toBe(true);
  });
});
