/**
 * src/observability/agent-profiler — CLI-facing agent performance profiler.
 *
 * The profiling engine (`AgentProfiler`) lives in the shared
 * `@capix/agent-runtime` package so the Capix Code TUI and CapixIDE compute
 * the exact same numbers. This module adds what the CLI needs on top:
 *
 * - `teeProfiler` — tap a live runtime event stream into a profiler.
 * - `hydrateProfiler` — rebuild a past session's profile from the store.
 * - `renderProfileReport` — plain-text rendering for terminal surfaces:
 *   totals, per-tool table (time, tokens, cost), and ranked bottlenecks.
 */

import {
  AgentProfiler,
  type AgentEvent,
  type AgentProfileReport,
  type RuntimeStore,
} from '@capix/agent-runtime';

export {
  AgentProfiler,
  type AgentProfileReport,
  type Bottleneck,
  type BottleneckKind,
  type ProfileStepMetric,
  type ToolProfile,
} from '@capix/agent-runtime';

/**
 * Tap a runtime event stream: record every event into `profiler` while
 * passing it through unchanged.
 */
export async function* teeProfiler(
  stream: AsyncIterable<AgentEvent>,
  profiler: AgentProfiler
): AsyncGenerator<AgentEvent> {
  for await (const event of stream) {
    profiler.record(event);
    yield event;
  }
}

/** Rebuild a session's profile from the durable store. */
export function hydrateProfiler(store: RuntimeStore, sessionId: string): AgentProfiler {
  return AgentProfiler.hydrateFromStore(store, sessionId);
}

/** `12.340000` from integer minor units at the receipt scale (default 6). */
export function formatCostMinor(costMinor: string, scale = 6): string {
  const negative = costMinor.startsWith('-');
  const digits = (negative ? costMinor.slice(1) : costMinor).padStart(scale + 1, '0');
  const major = digits.slice(0, -scale) || '0';
  const minor = digits.slice(-scale);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

/** Render the profile as terminal text: totals, per-tool table, bottlenecks. */
export function renderProfileReport(report: AgentProfileReport): string {
  const lines: string[] = [];
  lines.push(
    `Session: ${report.totalDurationMs}ms · ` +
      `${report.totalInputUnits} in / ${report.totalOutputUnits} out · ` +
      `$${formatCostMinor(report.totalCostMinor)} · ` +
      `${report.toolCalls} tool calls (${report.failedToolCalls} failed)`
  );

  if (report.tools.length > 0) {
    lines.push('', 'Tools:');
    for (const tool of report.tools) {
      const failures = tool.failures > 0 ? `, ${tool.failures} failed` : '';
      lines.push(
        `  ${tool.toolName}: ${tool.calls} calls${failures}, ` +
          `${tool.totalMs}ms total (avg ${tool.avgMs}ms, max ${tool.maxMs}ms), ` +
          `${tool.inputUnits + tool.outputUnits} units, $${formatCostMinor(tool.costMinor)}`
      );
    }
  }

  if (report.bottlenecks.length > 0) {
    lines.push('', 'Bottlenecks:');
    for (const bottleneck of report.bottlenecks) {
      lines.push(`  [${bottleneck.kind}] ${bottleneck.detail}`);
    }
  }

  return lines.join('\n');
}
