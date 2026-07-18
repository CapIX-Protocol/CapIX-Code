import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = resolve(process.argv[2] ?? 'dist/customer');
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
const entry = resolve(root, 'mcp/capix-mcp.js');
const child = spawn(process.execPath, [entry, 'server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CAPIX_API_KEY: 'cpxk_packaged_mcp_release_smoke',
    CAPIX_BASE_URL: 'https://www.capix.network',
  },
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(chunk));
const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => fail('MCP initialize/tools-list timed out'), 10_000);

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(toolCount) {
  clearTimeout(timeout);
  child.kill('SIGTERM');
  console.log(`✓ packaged MCP initialized with ${toolCount} tools`);
  process.exit(0);
}

function fail(message) {
  clearTimeout(timeout);
  child.kill('SIGTERM');
  console.error(`✗ ${message}`);
  if (stderr.length) console.error(stderr.join('').trim());
  process.exit(1);
}

child.once('error', (error) => fail(`MCP process could not start: ${error.message}`));
child.once('exit', (code) => {
  if (code !== null && code !== 0) fail(`MCP process exited before handshake (${code})`);
});

lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 1 && message.result) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    return;
  }
  if (message.id === 2) {
    const toolCount = message.result?.tools?.length ?? 0;
    if (toolCount < 40) fail(`MCP exposed only ${toolCount} tools; expected at least 40`);
    finish(toolCount);
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'capix-code-release-smoke', version },
  },
});
