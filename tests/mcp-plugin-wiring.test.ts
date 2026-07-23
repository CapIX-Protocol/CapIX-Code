import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PluginInput } from '@opencode-ai/plugin';

const { mockGetAccessToken } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn().mockResolvedValue({
    token: 'capix_test_access_after_login',
    expiresAt: new Date(Date.now() + 60_000),
  }),
}));

// Mock logger to keep test output clean.
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock CredentialBroker — instantiated at plugin load, must not touch the network.
vi.mock('../src/broker', () => ({
  CredentialBroker: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue(undefined),
    authorizationUrl: vi.fn().mockResolvedValue('https://api.capix.network/v1/auth/authorize'),
    exchangeCode: vi.fn().mockResolvedValue({ type: 'success' as const }),
    registerApiKey: vi.fn().mockResolvedValue({ type: 'success' as const, key: 'cpk_test' }),
    getAccessToken: mockGetAccessToken,
  })),
}));

// Mock WorkspaceSandbox — instantiated at plugin load, must not touch the fs.
vi.mock('../src/sandbox', () => ({
  WorkspaceSandbox: vi.fn().mockImplementation(() => ({
    profile: 'restricted' as const,
    shouldApproveCommand: vi.fn().mockReturnValue(true),
    scrubEnvironment: vi.fn().mockImplementation((env: Record<string, string>) => env),
    isSecretPath: vi.fn().mockReturnValue(false),
    closeToolCapabilities: vi.fn(),
  })),
}));

// Mock capix-provider — both statically and dynamically imported by plugin.ts.
vi.mock('../src/capix-provider', () => ({
  CapixHttpError: class CapixHttpError extends Error {},
  capixProvider: { name: 'capix' },
  createCapixProviderHook: vi.fn(() => ({ id: 'capix', models: vi.fn() })),
  capixAuthLoader: vi.fn(),
  CAPIX_INFERENCE_BASE: 'https://inference.capix.network',
  CAPIX_API_BASE: 'https://api.capix.network',
  setBrokerAccessor: vi.fn(),
  setInferenceBaseResolver: vi.fn(),
}));

import { getMcpSupervisor, plugin, sessionStatus } from '../src/plugin';

const STUB_TOOL_COUNT = 59;

/** Minimal MCP stdio server: answers `initialize` and `tools/list`. */
const STUB_SERVER = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const tools = Array.from({ length: ${STUB_TOOL_COUNT} }, (_, i) => ({
  name: 'capix_tool_' + i,
  description: 'stub tool',
  inputSchema: { type: 'object' },
}));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    if (process.env.STUB_TOKEN_CAPTURE) {
      fs.writeFileSync(process.env.STUB_TOKEN_CAPTURE, process.env.CAPIX_API_KEY || '');
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'capix-mcp', version: '1.0.0' } },
    }) + '\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools } }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const stubDir = mkdtempSync(join(tmpdir(), 'capix-plugin-mcp-'));
const stubEntry = join(stubDir, 'capix-mcp.js');
const tokenCapture = join(stubDir, 'token.txt');
writeFileSync(stubEntry, STUB_SERVER);

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
}

afterAll(() => {
  getMcpSupervisor().stop();
  delete process.env.CAPIX_MCP_PATH;
  delete process.env.STUB_TOKEN_CAPTURE;
  rmSync(stubDir, { recursive: true, force: true });
});

describe('P0 MCP connected state — customer runtime wiring', () => {
  it('plugin load supervises the MCP server and mirrors health into the session status', async () => {
    process.env.CAPIX_MCP_PATH = stubEntry;

    await plugin({} as unknown as PluginInput);

    await waitFor(() => sessionStatus.snapshot().mcp.state === 'connected');
    const mcp = sessionStatus.snapshot().mcp;
    expect(mcp.toolCount).toBe(STUB_TOOL_COUNT);
    expect(mcp.restartCount).toBe(0);
  });

  it('status line renders the connected state with the tool count', async () => {
    const { renderStatusLine } = await import('../src/tui/index.js');
    const line = renderStatusLine(sessionStatus.snapshot());
    expect(line).toContain(`mcp connected (${STUB_TOOL_COUNT} tools)`);
    expect(line).not.toContain('disconnected');
  });

  it('reconnects MCP with the broker token immediately after API-key login', async () => {
    process.env.CAPIX_MCP_PATH = stubEntry;
    process.env.STUB_TOKEN_CAPTURE = tokenCapture;
    const hooks = await plugin({} as unknown as PluginInput);
    const api = hooks.auth?.methods.find((method) => method.type === 'api');
    expect(api?.type).toBe('api');
    if (!api || api.type !== 'api' || !api.authorize) throw new Error('API auth method missing');

    await api.authorize({ apiKey: 'cpxk_customer_key' });

    await waitFor(() => {
      try {
        return (
          readFileSync(tokenCapture, 'utf8') === 'capix_test_access_after_login' &&
          sessionStatus.snapshot().mcp.state === 'connected'
        );
      } catch {
        return false;
      }
    });
    expect(mockGetAccessToken).toHaveBeenCalled();
    expect(sessionStatus.snapshot().mcp.state).toBe('connected');
  });

  it('a missing MCP entry point leaves the status disconnected and never throws', async () => {
    getMcpSupervisor().stop();
    process.env.CAPIX_MCP_PATH = join(stubDir, 'no-such-mcp.js');

    await expect(plugin({} as unknown as PluginInput)).resolves.toBeDefined();

    // The singleton supervisor was stopped above; with no entry point on disk
    // the status stays disconnected rather than reporting a phantom failure.
    expect(sessionStatus.snapshot().mcp.state).toBe('disconnected');
  });
});
