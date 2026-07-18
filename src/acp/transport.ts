/**
 * ACP (Agent Communication Protocol) entry point.
 *
 * The protocol implementation lives in `@capix/agent-runtime`
 * (packages/agent-runtime/src/transport.ts) — a line-delimited JSON-RPC
 * transport over stdio exposing the full runtime surface (sessions, modes,
 * specialists, tools, plans, diffs, receipts, commands). This module only
 * wires the stdio auto-start used when the CLI is launched with `--stdio`.
 *
 * Protocol version: 1
 */

import { CapixAgentRuntime, createAcpServer, type AcpServer } from '@capix/agent-runtime';

let server: AcpServer | null = null;

/// Start the ACP server reading from stdin and writing to stdout.
export function startAcpServer(): void {
  const runtime = new CapixAgentRuntime({
    dbPath: process.env.CAPIX_AGENT_RUNTIME_DB,
  });
  server = createAcpServer(runtime);
  server.start();
}

// Auto-start if run directly
if (process.argv.includes('--stdio') && !process.env.CAPIX_ACP_STARTED) {
  process.env.CAPIX_ACP_STARTED = '1';
  startAcpServer();
}
