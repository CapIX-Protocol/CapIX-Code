/**
 * @capix/agent-runtime — ACP-compatible JSON-RPC transport.
 *
 * Line-delimited JSON-RPC over stdio (or any readable/writable pair) that
 * CapixIDE and other hosts use to drive the agent runtime.
 *
 * Protocol version: 1
 *
 * Message format: one JSON object per line.
 *
 * Request:      { "jsonrpc": "2.0", "id": "uuid", "method": "session.create", "params": {...} }
 *               (the legacy envelope `{ "id", "method", "params" }` is also accepted)
 * Response:     { "jsonrpc": "2.0", "id": "uuid", "result": {...} }
 * Error:        { "jsonrpc": "2.0", "id": "uuid", "error": { "code": -32000, "message": "...",
 *                 "data": <RFC 9457 problem detail> } }
 * Notification: { "event": "content.delta", "sessionId": "...", "data": {...}, "version": 1 }
 */

import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { CapixAgentRuntime } from './runtime.js';
import { CapixAgentError, CAPIX_ERROR_CODES, type CapixProblemDetail } from './contracts.js';
import { isAgentMode, type AgentMode } from './modes.js';
import type { PlanStepStatus } from './session.js';

export const ACP_VERSION = 1;

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const RUNTIME_ERROR = -32000;

interface AcpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface AcpServerOptions {
  input?: Readable;
  output?: Writable;
}

export interface AcpServer {
  /** Process one line of input. Exposed for tests and custom loops. */
  handleLine(line: string): Promise<void>;
  /** Start reading lines from the input stream. */
  start(): void;
  close(): void;
}

type Handler = (params: Record<string, unknown>) => unknown;

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CapixAgentError({
      type: `https://capix.network/problems/${CAPIX_ERROR_CODES.INTERNAL_ERROR}`,
      title: 'Invalid params',
      status: 400,
      detail: `missing or invalid string param: ${key}`,
      capixCode: CAPIX_ERROR_CODES.INTERNAL_ERROR,
    });
  }
  return value;
}

function optStr(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Create an ACP server bound to a runtime. All session/plan/mode/tool/
 * receipt/diff/command methods of the runtime are exposed as JSON-RPC
 * methods; streaming turns emit notifications.
 */
export function createAcpServer(
  runtime: CapixAgentRuntime,
  options: AcpServerOptions = {}
): AcpServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let rl: Interface | null = null;

  const write = (value: unknown): void => {
    output.write(JSON.stringify(value) + '\n');
  };

  const respond = (id: string | number | null, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result });
  };

  const respondProblem = (
    id: string | number | null,
    code: number,
    problem?: CapixProblemDetail
  ): void => {
    write({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: problem?.detail ?? problem?.title ?? 'error',
        ...(problem ? { data: problem } : {}),
      },
    });
  };

  const emitEvent = (sessionId: string | undefined, event: string, data: unknown): void => {
    write({ event, sessionId, data, version: ACP_VERSION });
  };

  const handlers: Record<string, Handler> = {
    handshake: async (params) => {
      const clientVersion = typeof params.version === 'number' ? params.version : 0;
      if (clientVersion !== ACP_VERSION) {
        throw new CapixAgentError({
          type: 'https://capix.network/problems/version_mismatch',
          title: 'Version mismatch',
          status: 400,
          detail: `client version ${clientVersion} does not match runtime version ${ACP_VERSION}`,
          capixCode: 'version_mismatch',
        });
      }
      return {
        version: ACP_VERSION,
        runtimeVersion: runtime.version,
        capabilities: [
          'sessions',
          'streaming',
          'modes',
          'specialists',
          'tools',
          'plans',
          'diffs',
          'commands',
          'models',
          'receipts',
          'settlement',
          'workspace',
        ],
      };
    },

    'session.create': (params) =>
      runtime.createSession({
        sessionId: optStr(params, 'sessionId'),
        modelId: optStr(params, 'modelId'),
        projectId: optStr(params, 'projectId'),
        workspaceRoot: optStr(params, 'workspaceRoot'),
        routeMode: optStr(params, 'routeMode') as 'auto' | 'private' | 'routed' | undefined,
        instructions: optStr(params, 'instructions'),
        mode: optStr(params, 'mode') as AgentMode | undefined,
      }),
    'session.resume': (params) => runtime.resumeSession(str(params, 'sessionId')),
    'session.list': (params) =>
      runtime.listSessions({
        limit: typeof params.limit === 'number' ? params.limit : undefined,
        cursor: optStr(params, 'cursor'),
      }),
    'session.dispose': async (params) => {
      await runtime.disposeSession(str(params, 'sessionId'));
      return { disposed: true };
    },
    'session.history': (params) => runtime.getHistory(str(params, 'sessionId')),
    'session.children': (params) => runtime.listChildSessions(str(params, 'sessionId')),

    'mode.set': async (params) => {
      const mode = str(params, 'mode');
      if (!isAgentMode(mode)) {
        throw new CapixAgentError({
          type: 'https://capix.network/problems/invalid_mode',
          title: 'Invalid mode',
          status: 400,
          detail: `unknown mode: ${mode}`,
          capixCode: CAPIX_ERROR_CODES.INTERNAL_ERROR,
        });
      }
      await runtime.setMode(str(params, 'sessionId'), mode);
      return { mode };
    },
    'mode.get': (params) => runtime.getMode(str(params, 'sessionId')),

    'message.send': async (params) => {
      const sessionId = str(params, 'sessionId');
      const content = str(params, 'content');
      const modelId = optStr(params, 'modelId');
      for await (const event of runtime.sendMessage({ sessionId, content, modelId })) {
        emitEvent(sessionId, event.type, event);
      }
      return { completed: true };
    },
    'message.cancel': async (params) => {
      await runtime.cancelTurn(str(params, 'sessionId'));
      return { cancelled: true };
    },

    'tool.approve': async (params) => {
      await runtime.approveTool(
        str(params, 'sessionId'),
        str(params, 'toolCallId'),
        params.approved === true,
        optStr(params, 'reason')
      );
      return { processed: true };
    },
    'tool.list': () =>
      Promise.resolve(
        runtime.tools.list().map((t) => ({
          name: t.name,
          description: t.description,
          riskClass: t.riskClass,
        }))
      ),

    'model.list': () => runtime.listModels(),
    'model.select': async (params) => {
      await runtime.selectModel(str(params, 'sessionId'), str(params, 'modelId'));
      return { selected: true };
    },

    'usage.get': (params) => runtime.getUsage(str(params, 'sessionId')),
    'receipts.get': (params) => runtime.getReceipts(str(params, 'sessionId')),
    'receipts.verify': (params) => runtime.verifyReceipt(str(params, 'receiptId')),
    'settlement.status': (params) => runtime.getSettlementStatus(str(params, 'sessionId')),
    'settlement.epoch': (params) =>
      runtime.getEpoch(str(params, 'sessionId'), BigInt(str(params, 'epoch'))),

    'workspace.attach': async (params) => {
      await runtime.attachWorkspace(str(params, 'sessionId'), str(params, 'workspaceRoot'));
      return { attached: true };
    },

    'diff.get': (params) => runtime.getDiff(str(params, 'sessionId'), optStr(params, 'filePath')),
    'diff.apply': async (params) => {
      await runtime.applyPatch(
        str(params, 'sessionId'),
        str(params, 'filePath'),
        str(params, 'patch')
      );
      return { applied: true };
    },

    'command.run': (params) =>
      runtime.runCommand(str(params, 'sessionId'), str(params, 'command'), optStr(params, 'cwd')),

    'plan.create': (params) =>
      runtime.createPlan(str(params, 'sessionId'), {
        goal: str(params, 'goal'),
        definitionOfDone: Array.isArray(params.definitionOfDone)
          ? (params.definitionOfDone as string[])
          : undefined,
        steps: Array.isArray(params.steps)
          ? (params.steps as Array<{ description: string; files?: string[]; tests?: string[] }>)
          : undefined,
      }),
    'plan.get': (params) => runtime.getPlan(str(params, 'planId')),
    'plan.list': (params) => runtime.listPlans(str(params, 'sessionId')),
    'plan.updateStep': (params) =>
      runtime.updatePlanStep(
        str(params, 'planId'),
        str(params, 'stepId'),
        str(params, 'status') as PlanStepStatus
      ),

    'specialist.list': () =>
      // BigInt spend bounds are serialized as strings (JSON has no bigint).
      runtime.listSpecialists().map((s) => ({
        ...s,
        maxSpendUsdMinor: s.maxSpendUsdMinor.toString(),
      })),
    'specialist.spawn': (params) =>
      runtime.createChildSession(
        str(params, 'sessionId'),
        str(params, 'role'),
        str(params, 'mandate')
      ),
  };

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let request: AcpRequest;
    try {
      request = JSON.parse(line) as AcpRequest;
    } catch {
      respondProblem(null, PARSE_ERROR);
      return;
    }
    const id = request.id ?? null;
    if (!request.method || typeof request.method !== 'string') {
      respondProblem(id, INVALID_REQUEST);
      return;
    }
    const handler = handlers[request.method];
    if (!handler) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `unknown method: ${request.method}` },
      });
      return;
    }
    try {
      const result = await handler(request.params ?? {});
      respond(id, result);
    } catch (err) {
      if (err instanceof CapixAgentError) {
        respondProblem(
          id,
          err.problem.status === 400 ? INVALID_PARAMS : RUNTIME_ERROR,
          err.problem
        );
      } else {
        respondProblem(id, RUNTIME_ERROR, {
          type: `https://capix.network/problems/${CAPIX_ERROR_CODES.INTERNAL_ERROR}`,
          title: 'Runtime error',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
          capixCode: CAPIX_ERROR_CODES.INTERNAL_ERROR,
        });
      }
    }
  }

  return {
    handleLine,
    start(): void {
      rl = createInterface({ input, terminal: false });
      rl.on('line', (line: string) => {
        void handleLine(line);
      });
      rl.on('close', () => {
        runtime.close();
      });
    },
    close(): void {
      rl?.close();
    },
  };
}

/** Start an ACP server over stdio bound to a fresh runtime. */
export function startAcpServer(runtime: CapixAgentRuntime): AcpServer {
  const server = createAcpServer(runtime);
  server.start();
  return server;
}
