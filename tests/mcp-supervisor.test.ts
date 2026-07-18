import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSupervisor, type McpHealth } from '../src/mcp-supervisor.js';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

/** Number of tools the packaged Capix MCP server advertises. */
const STUB_TOOL_COUNT = 59;

/**
 * Minimal MCP stdio server: answers `initialize` and `tools/list`, captures
 * the clientInfo from the handshake for assertion, exits when stdin closes.
 */
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
    if (process.env.STUB_INIT_CAPTURE) {
      fs.writeFileSync(process.env.STUB_INIT_CAPTURE, JSON.stringify(req.params.clientInfo));
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'capix-mcp', version: '1.0.0' },
      },
    }) + '\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools },
    }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const tmpdirs: string[] = [];
const supervisors: McpSupervisor[] = [];

function makeStub(): { dir: string; entry: string; initCapture: string } {
  const dir = mkdtempSync(join(tmpdir(), 'capix-mcp-stub-'));
  tmpdirs.push(dir);
  const entry = join(dir, 'capix-mcp.js');
  const initCapture = join(dir, 'init-capture.json');
  writeFileSync(entry, STUB_SERVER);
  return { dir, entry, initCapture };
}

function makeSupervisor(): McpSupervisor {
  const supervisor = new McpSupervisor();
  supervisors.push(supervisor);
  return supervisor;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('timed out waiting for condition');
}

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.stop();
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('P0 MCP connected state — supervisor health check and tool listing', () => {
  it('connects through initialize + tools/list and reports the real tool count', async () => {
    const { entry, initCapture } = makeStub();
    const supervisor = makeSupervisor();
    const transitions: McpHealth['state'][] = [];
    supervisor.onHealthChange((h) => transitions.push(h.state));

    supervisor.start(entry, { STUB_INIT_CAPTURE: initCapture });

    await waitFor(() => supervisor.getHealth().state === 'connected');
    const health = supervisor.getHealth();
    expect(health.toolCount).toBe(STUB_TOOL_COUNT);
    expect(health.restartCount).toBe(0);
    expect(health.lastCheckedAt).not.toBe('');
    expect(transitions).toContain('starting');
    expect(transitions).toContain('authenticating');
    expect(transitions[transitions.length - 1]).toBe('connected');
  });

  it('identifies itself to the MCP server as capix-code at the package version', async () => {
    const { entry, initCapture } = makeStub();
    const supervisor = makeSupervisor();

    supervisor.start(entry, { STUB_INIT_CAPTURE: initCapture });

    await waitFor(() => supervisor.getHealth().state === 'connected');
    expect(JSON.parse(readFileSync(initCapture, 'utf8'))).toEqual({
      name: 'capix-code',
      version: pkg.version,
    });
  });

  it('degrades with bounded restart on a crashing entry point instead of crashing the runtime', async () => {
    const supervisor = makeSupervisor();
    const missing = join(tmpdir(), 'capix-mcp-does-not-exist', 'capix-mcp.js');
    expect(existsSync(missing)).toBe(false);

    // `node` itself spawns fine and exits non-zero ("Cannot find module") —
    // the supervisor must degrade and schedule a bounded restart, never throw.
    supervisor.start(missing, {});

    await waitFor(() => supervisor.getHealth().state === 'degraded');
    const health = supervisor.getHealth();
    expect(health.error).toContain('Process exited with code');
    expect(health.restartCount).toBe(1);

    // stop() cancels the pending backoff restart.
    supervisor.stop();
    expect(supervisor.getHealth().state).toBe('disconnected');
  });

  it('stop() disconnects without scheduling a respawn', async () => {
    const { entry } = makeStub();
    const supervisor = makeSupervisor();
    supervisor.start(entry, {});
    await waitFor(() => supervisor.getHealth().state === 'connected');

    supervisor.stop();

    const health = supervisor.getHealth();
    expect(health.state).toBe('disconnected');
    // Give any stale exit handler a chance to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 200));
    expect(supervisor.getHealth().state).toBe('disconnected');
    expect(supervisor.getHealth().restartCount).toBe(0);
  });
});
