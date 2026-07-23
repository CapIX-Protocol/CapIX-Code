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

import {
  CapixAgentRuntime,
  createAcpServer,
  type AcpServer,
  type ModelInvoker,
} from '@capix/agent-runtime';
import { CAPIX_ACP_VERSION, CAPIX_PLUGIN_VERSION, createRuntimeModelInvoker } from '../plugin.js';

let server: AcpServer | null = null;

export function createAcpRuntime(options: { modelInvoker?: ModelInvoker } = {}): CapixAgentRuntime {
  const version = process.env.CAPIX_CODE_VERSION?.trim() || CAPIX_PLUGIN_VERSION;
  const meta = {
    releaseId: process.env.CAPIX_RELEASE_ID?.trim() || 'bundled',
    client: 'capix-code' as const,
    clientVersion: version,
    pluginVersion: CAPIX_PLUGIN_VERSION,
    acpVersion: CAPIX_ACP_VERSION,
  };
  return new CapixAgentRuntime({
    dbPath: process.env.CAPIX_AGENT_RUNTIME_DB,
    workspaceRoot: process.cwd(),
    // The IDE/ACP surface must use the exact same broker-backed canonical
    // Capix stream as the TUI and autonomous runner. Without this injection
    // every message deterministically failed with "no model invoker".
    modelInvoker: options.modelInvoker ?? createRuntimeModelInvoker(meta),
  });
}

/// Start the ACP server reading from stdin and writing to stdout.
export function startAcpServer(): void {
  const runtime = createAcpRuntime();
  server = createAcpServer(runtime);
  server.start();
}

// Auto-start if run directly
if (process.argv.includes('--stdio') && !process.env.CAPIX_ACP_STARTED) {
  process.env.CAPIX_ACP_STARTED = '1';
  startAcpServer();
}
