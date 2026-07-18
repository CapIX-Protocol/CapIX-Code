/**
 * Sandpit tool definitions — exposes the sandpit planner (create / refactor /
 * review / test / destroy) to the agent runtime as host tools.
 *
 * Mirrors the `ToolDefinition` contract from `@capix/agent-runtime`: each
 * tool declares a risk class so the runtime's mode permission profile gates
 * execution. `sandpit_create` and `sandpit_destroy` are `billing`-class and
 * always require approval — they provision and tear down paid infrastructure.
 *
 * Refs:
 * - src/planner/sandpit.ts (the Sandpit planner these tools delegate to)
 * - packages/agent-runtime/src/tools.ts (ToolDefinition / ToolRegistry)
 */

import type { ToolDefinition, ToolResult } from '@capix/agent-runtime';

import { formatMoney } from '../routing-client.js';
import type { Sandpit, SandpitJobResult, SandpitProgressEvent } from '../planner/sandpit.js';

/** Render progress events into a transcript for the tool output. */
function collectEvents(): { events: SandpitProgressEvent[]; onEvent: (e: SandpitProgressEvent) => void } {
  const events: SandpitProgressEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function summarize(events: SandpitProgressEvent[]): string {
  return events
    .map((e) => {
      switch (e.type) {
        case 'state':
          return `${e.workload}: ${e.state}${e.summary ? ` — ${e.summary}` : ''}`;
        case 'quoted':
          return `${e.workload}: quoted (expires ${e.expiresAt})`;
        case 'committed':
          return `${e.workload}: committed → ${e.deploymentId}`;
        case 'failed':
          return `failed: ${e.error}`;
        default:
          return null;
      }
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Options threaded through to every planner call the tools make. */
export interface SandpitToolOptions {
  projectId?: string;
  pollIntervalMs?: number;
}

/**
 * Build the sandpit host tools around a shared `Sandpit` planner instance
 * (sessions are tracked in-memory on the planner, so the tools must share
 * one instance).
 */
export function createSandpitTools(
  sandpit: Sandpit,
  toolOpts: SandpitToolOptions = {}
): ToolDefinition[] {
  return [
    {
      name: 'sandpit_create',
      description:
        'Spin up an isolated sandpit container with a source directory mounted, ' +
        'for safe refactor/review/test without touching the local environment.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args): Promise<ToolResult> {
        const sourcePath = String(args.source_path ?? '');
        if (!sourcePath.trim()) return { output: 'source_path is required', isError: true };
        const { events, onEvent } = collectEvents();
        const result = await sandpit.create({ sourcePath, onEvent, ...toolOpts });
        if (result.status === 'failed') {
          return { output: `${result.error}\n${summarize(events)}`, isError: true };
        }
        return {
          output:
            `sandpit ${result.sandpitId} running (deployment ${result.deploymentId})\n` +
            `spend to date: ${formatMoney(result.spendToDate!)}\n${summarize(events)}`,
          metadata: { sandpitId: result.sandpitId, deploymentId: result.deploymentId },
        };
      },
    },
    {
      name: 'sandpit_refactor',
      description: 'Run a refactor job inside a sandpit, guided by an instruction.',
      riskClass: 'execute',
      async execute(args): Promise<ToolResult> {
        const sandpitId = String(args.sandpit_id ?? '');
        const instruction = String(args.instruction ?? '');
        if (!instruction.trim()) {
          return { output: 'instruction is required', isError: true };
        }
        const { events, onEvent } = collectEvents();
        const result = await sandpit.refactor({ sandpitId, instruction, onEvent, ...toolOpts });
        return jobToolResult(result, events);
      },
    },
    {
      name: 'sandpit_review',
      description: 'Run the security and quality review job inside a sandpit.',
      riskClass: 'execute',
      async execute(args): Promise<ToolResult> {
        const { events, onEvent } = collectEvents();
        const result = await sandpit.review({ sandpitId: String(args.sandpit_id ?? ''), onEvent, ...toolOpts });
        return jobToolResult(result, events);
      },
    },
    {
      name: 'sandpit_test',
      description: 'Run the full test suite inside a sandpit.',
      riskClass: 'execute',
      async execute(args): Promise<ToolResult> {
        const { events, onEvent } = collectEvents();
        const result = await sandpit.test({ sandpitId: String(args.sandpit_id ?? ''), onEvent, ...toolOpts });
        return jobToolResult(result, events);
      },
    },
    {
      name: 'sandpit_destroy',
      description: 'Tear a sandpit down and report the total spend.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args): Promise<ToolResult> {
        const { events, onEvent } = collectEvents();
        const result = await sandpit.destroy({ sandpitId: String(args.sandpit_id ?? ''), onEvent, ...toolOpts });
        if (result.status === 'failed') {
          return { output: `${result.error}\n${summarize(events)}`, isError: true };
        }
        return {
          output:
            `sandpit ${result.sandpitId} destroyed\n` +
            `total cost: ${formatMoney(result.totalCost!)}\n${summarize(events)}`,
          metadata: { sandpitId: result.sandpitId, totalCostMinor: result.totalCost!.amountMinor },
        };
      },
    },
  ];
}

function jobToolResult(result: SandpitJobResult, events: SandpitProgressEvent[]): ToolResult {
  if (result.status === 'failed') {
    return { output: `${result.error}\n${summarize(events)}`, isError: true };
  }
  return {
    output:
      `sandpit ${result.action} succeeded (job ${result.deploymentId})\n` +
      (result.summary ? `${result.summary}\n` : '') +
      (result.cost ? `job cost: ${formatMoney(result.cost)}\n` : '') +
      summarize(events),
    metadata: {
      sandpitId: result.sandpitId,
      action: result.action,
      deploymentId: result.deploymentId,
    },
  };
}
