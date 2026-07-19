/**
 * src/observability/agent-timeline — CLI-facing agent execution timeline.
 *
 * The timeline engine itself (`AgentTimeline`) lives in the shared
 * `@capix/agent-runtime` package so the Capix Code TUI and CapixIDE run the
 * exact same code. This module adds what the CLI needs on top:
 *
 * - `teeTimeline` — tap a live runtime event stream: every event is recorded
 *   into a timeline as it flows through to the TUI.
 * - `hydrateTimeline` — rebuild a past session's timeline from the durable
 *   runtime store (with rollback enabled against its workspace root).
 * - `formatTimelineStep` / `renderTimeline` — plain-text rendering for
 *   terminal surfaces.
 */

import {
  AgentTimeline,
  type AgentEvent,
  type RuntimeStore,
  type TimelineStep,
} from '@capix/agent-runtime';

export {
  AgentTimeline,
  type FileChangeDetail,
  type TimelineOptions,
  type TimelineStep,
  type TimelineStepKind,
  type ToolCallInspection,
  type ToolCallStatus,
} from '@capix/agent-runtime';

/**
 * Tap a runtime event stream: record every event into `timeline` while
 * passing it through unchanged.
 */
export async function* teeTimeline(
  stream: AsyncIterable<AgentEvent>,
  timeline: AgentTimeline
): AsyncGenerator<AgentEvent> {
  for await (const event of stream) {
    timeline.record(event);
    yield event;
  }
}

/** Rebuild a session's timeline from the durable store. */
export function hydrateTimeline(
  store: RuntimeStore,
  sessionId: string,
  options: { workspaceRoot?: string } = {}
): AgentTimeline {
  return AgentTimeline.hydrateFromStore(store, sessionId, options);
}

const KIND_MARKER: Record<TimelineStep['kind'], string> = {
  turn: '◆',
  reasoning: '…',
  content: '›',
  tool_call: '⚙',
  file_change: '✎',
  checkpoint: '▣',
  error: '✗',
};

/** One terminal line for a step: marker, title, explanation. */
export function formatTimelineStep(step: TimelineStep): string {
  const marker = KIND_MARKER[step.kind];
  const rolledBack = step.rolledBack ? ' [rolled back]' : '';
  return `${marker} ${step.title}${rolledBack} — ${step.explanation}`;
}

/** Render the whole timeline as terminal text, one line per step. */
export function renderTimeline(steps: TimelineStep[]): string {
  if (steps.length === 0) return '(no agent activity recorded yet)';
  return steps.map(formatTimelineStep).join('\n');
}
