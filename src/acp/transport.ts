/**
 * ACP (Agent Communication Protocol) Transport
 * 
 * A line-delimited JSON protocol over stdio that the IDE uses to
 * communicate with the Capix Code agent runtime.
 * 
 * Protocol version: 1
 * 
 * Message format: one JSON object per line on stdin/stdout
 * 
 * Request: { "id": "uuid", "method": "session.create", "params": {...} }
 * Response: { "id": "uuid", "result": {...} } or { "id": "uuid", "error": {...} }
 * Event: { "event": "message.delta", "sessionId": "...", "data": {...} }
 */

import { CapixAgentRuntime } from '../../packages/agent-runtime/src/runtime.js';
import type { AgentEvent } from '../../packages/agent-runtime/src/events.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const ACP_VERSION = 1;

interface AcpRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface AcpResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

interface AcpEvent {
  event: string;
  sessionId?: string;
  data: unknown;
}

const runtime = new CapixAgentRuntime();

function respond(response: AcpResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function emitEvent(event: AcpEvent): void {
  process.stdout.write(JSON.stringify({ ...event, version: ACP_VERSION }) + '\n');
}

async function handleRequest(request: AcpRequest): Promise<void> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'handshake': {
        respond({ id, result: { version: ACP_VERSION, runtimeVersion: runtime.version, capabilities: ['sessions', 'streaming', 'tools', 'diffs', 'commands', 'models', 'receipts', 'workspace'] } });
        break;
      }

      case 'session.create': {
        const session = await runtime.createSession(params as any);
        respond({ id, result: session });
        break;
      }

      case 'session.resume': {
        const sessionId = params?.sessionId as string;
        const session = await runtime.resumeSession(sessionId);
        respond({ id, result: session });
        break;
      }

      case 'session.list': {
        const result = await runtime.listSessions(params as any);
        respond({ id, result });
        break;
      }

      case 'session.dispose': {
        const sessionId = params?.sessionId as string;
        await runtime.disposeSession(sessionId);
        respond({ id, result: { disposed: true } });
        break;
      }

      case 'message.send': {
        const sessionId = params?.sessionId as string;
        const content = params?.content as string;
        const modelId = params?.modelId as string | undefined;

        // Acknowledge the request
        respond({ id, result: { streaming: true } });

        // Stream events
        try {
          for await (const event of runtime.sendMessage({ sessionId, content, modelId })) {
            emitEvent({
              event: event.type,
              sessionId,
              data: event,
            });
          }
        } catch (err) {
          emitEvent({
            event: 'error',
            sessionId,
            data: { message: String(err) },
          });
        }
        break;
      }

      case 'message.cancel': {
        const sessionId = params?.sessionId as string;
        await runtime.cancelTurn(sessionId);
        respond({ id, result: { cancelled: true } });
        break;
      }

      case 'tool.approve': {
        const sessionId = params?.sessionId as string;
        const toolCallId = params?.toolCallId as string;
        const approved = params?.approved as boolean;
        const reason = params?.reason as string | undefined;
        await runtime.approveTool(sessionId, toolCallId, approved, reason);
        respond({ id, result: { processed: true } });
        break;
      }

      case 'model.list': {
        const models = await runtime.listModels();
        respond({ id, result: models });
        break;
      }

      case 'model.select': {
        const sessionId = params?.sessionId as string;
        const modelId = params?.modelId as string;
        await runtime.selectModel(sessionId, modelId);
        respond({ id, result: { selected: true } });
        break;
      }

      case 'usage.get': {
        const sessionId = params?.sessionId as string;
        const usage = await runtime.getUsage(sessionId);
        respond({ id, result: usage });
        break;
      }

      case 'receipts.get': {
        const sessionId = params?.sessionId as string;
        const receipts = await runtime.getReceipts(sessionId);
        respond({ id, result: receipts });
        break;
      }

      case 'workspace.attach': {
        const sessionId = params?.sessionId as string;
        const workspaceRoot = params?.workspaceRoot as string;
        await runtime.attachWorkspace(sessionId, workspaceRoot);
        respond({ id, result: { attached: true } });
        break;
      }

      case 'diff.get': {
        const sessionId = params?.sessionId as string;
        const filePath = params?.filePath as string | undefined;
        const diffs = await runtime.getDiff(sessionId, filePath);
        respond({ id, result: diffs });
        break;
      }

      case 'diff.apply': {
        const sessionId = params?.sessionId as string;
        const filePath = params?.filePath as string;
        const patch = params?.patch as string;
        await runtime.applyPatch(sessionId, filePath, patch);
        respond({ id, result: { applied: true } });
        break;
      }

      case 'command.run': {
        const sessionId = params?.sessionId as string;
        const command = params?.command as string;
        const cwd = params?.cwd as string | undefined;
        const result = await runtime.runCommand(sessionId, command, cwd);
        respond({ id, result });
        break;
      }

      default: {
        respond({ id, error: { code: 'unknown_method', message: `Unknown method: ${method}` } });
      }
    }
  } catch (err) {
    respond({ id, error: { code: 'runtime_error', message: err instanceof Error ? err.message : String(err) } });
  }
}

/// Start the ACP server reading from stdin and writing to stdout.
export function startAcpServer(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line) as AcpRequest;
      if (!request.id || !request.method) return;
      void handleRequest(request);
    } catch {
      // Invalid JSON — ignore
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// Auto-start if run directly
if (process.argv.includes('--stdio') && !process.env.CAPIX_ACP_STARTED) {
  process.env.CAPIX_ACP_STARTED = '1';
  startAcpServer();
}
