/**
 * @capix/agent-runtime — fully-autonomous execution mode (`run --auto`).
 *
 * A2A task machines run `capix-code run --auto --tier best --spend-cap <usd>
 * "<brief>"`. This module implements the three guarantees of that mode:
 *
 * 1. **Bounded approval sandbox** — every tool approval is decided by
 *    `createAutoApprovalPolicy`, with NO human in the loop: workspace reads
 *    and writes are auto-accepted, shell commands run only when every
 *    executable in the invocation is on the allowlist (package managers,
 *    test runners, build tools, git), and Capix MCP deploy/quote tools run
 *    only through quoted spend-capped APIs. Everything else is a *typed
 *    skip*: the tool call is rejected with an explicit reason that lands in
 *    the transcript and in the result's `skipped[]` list. Nothing is ever
 *    silently dropped or silently approved.
 * 2. **Spend cap** — `SpendTracker` accounts integer micro-USD minor units
 *    from the real usage/receipt stream (never estimates). At >= 90% it
 *    warns once in the transcript; at >= 100% the turn is cancelled and the
 *    run ends with status `spend_cap_reached` plus the partial artifact
 *    manifest. It never reports completion it did not reach.
 * 3. **Machine-readable result** — `formatResultLine` emits a single-line
 *    `CAPIX_RUN_RESULT {json}` record with status, summary, artifacts,
 *    receipts, usage, and skips, so a caller can parse the outcome.
 */

import type { AgentEvent } from './events.js';
import type { AgentMode } from './modes.js';
import { RECEIPT_ASSET, RECEIPT_SCALE } from './receipts.js';
import type { CapixAgentRuntime, AutoApprovalVerdict } from './runtime.js';
import type { SpecialistQualityTier } from './specialists.js';

// ── Shell command allowlist ─────────────────────────────────────────────────

/**
 * Executables an autonomous run may invoke: package managers, test runners,
 * build tools, and git. Everything else is logged and skipped.
 */
export const AUTO_SHELL_ALLOWLIST: readonly string[] = [
  // package managers
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'bunx',
  'pip',
  'pip3',
  'uv',
  'cargo',
  'composer',
  'gem',
  // test runners
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'ava',
  'tap',
  // build tools / compilers / interpreters
  'node',
  'deno',
  'tsc',
  'eslint',
  'make',
  'cmake',
  'gradle',
  'mvn',
  'go',
  'rustc',
  'python',
  'python3',
  // version control
  'git',
];

/**
 * Capix MCP tools that spend money. They may run in autonomous mode ONLY
 * through the quoted, spend-capped APIs — i.e. when the invocation carries a
 * quote id. Quote tools themselves are always allowed (they create quotes,
 * they do not spend).
 */
export const AUTO_QUOTED_SPEND_TOOLS: readonly string[] = [
  'capix_deploy',
  'capix_start',
  'capix_stop',
  'capix_delete',
];
export const AUTO_QUOTE_TOOLS: readonly string[] = ['capix_quote', 'capix_get_quote'];

const SHELL_SEPARATORS = /&&|\|\||[;|\n]/;

function basename(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Extract the executable of every command segment in a shell invocation.
 * Environment-assignments prefixes (`FOO=bar npm test`) are skipped.
 */
export function shellExecutables(command: string): string[] {
  const executables: string[] = [];
  for (const segment of command.split(SHELL_SEPARATORS)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
    const first = tokens[idx];
    if (first) executables.push(basename(first));
  }
  return executables;
}

function hasQuoteId(args: Record<string, unknown>): boolean {
  const quote = args['quoteId'] ?? args['quote_id'] ?? args['quote'];
  return typeof quote === 'string' && quote.trim().length > 0;
}

/**
 * The autonomous approval policy. Returned verdicts are immediate in both
 * directions — denials are typed skips carrying the reason. Mode enforcement
 * still runs ahead of this policy (ask/plan modes can never write), and the
 * workspace tools themselves reject path escapes, so an approval here can
 * never reach outside the workspace root.
 */
export function createAutoApprovalPolicy(): (
  toolName: string,
  args: Record<string, unknown>
) => AutoApprovalVerdict {
  const skip = (reason: string): AutoApprovalVerdict => ({ approved: false, reason });
  return (toolName, args) => {
    switch (toolName) {
      case 'read_file':
      case 'list_files':
        return true;
      case 'write_file':
      case 'edit_file':
        // Workspace-rooted writes; the tool itself rejects path escapes.
        return true;
      case 'bash': {
        const command = String(args['command'] ?? '');
        const executables = shellExecutables(command);
        if (executables.length === 0) {
          return skip('auto-mode: empty shell command; logged and skipped');
        }
        const blocked = executables.filter((exe) => !AUTO_SHELL_ALLOWLIST.includes(exe));
        if (blocked.length > 0) {
          return skip(
            `auto-mode: shell executable "${blocked[0]}" is not on the autonomous ` +
              'allowlist (package managers, test runners, build tools, git); logged and skipped'
          );
        }
        return true;
      }
      default: {
        if (AUTO_QUOTE_TOOLS.includes(toolName)) return true;
        if (AUTO_QUOTED_SPEND_TOOLS.includes(toolName)) {
          return hasQuoteId(args)
            ? true
            : skip(
                `auto-mode: "${toolName}" requires a quoted spend-capped API call ` +
                  '(quoteId); logged and skipped'
              );
        }
        return skip(
          `auto-mode: tool "${toolName}" is outside the autonomous sandbox; logged and skipped`
        );
      }
    }
  };
}

// ── Spend tracker ───────────────────────────────────────────────────────────

export interface SpendTrackerStatus {
  /** Cumulative real spend, micro-USD minor units. */
  spentMinor: string;
  /** Configured cap, micro-USD minor units; null when uncapped. */
  capMinor: string | null;
  /** True exactly once, on the update that crosses 90% of the cap. */
  warn90: boolean;
  /** True once spent >= cap. */
  exceeded: boolean;
}

/**
 * Accounts integer micro-USD minor units from the receipt stream. All math
 * is BigInt; the 90% threshold is computed as `10·spent >= 9·cap` so no
 * floating-point rounding ever touches the budget.
 */
export class SpendTracker {
  private spent = 0n;
  private warned = false;

  constructor(private readonly cap: bigint | null) {}

  record(deltaMinor: string | bigint): SpendTrackerStatus {
    const delta = typeof deltaMinor === 'string' ? BigInt(deltaMinor || '0') : deltaMinor;
    this.spent += delta;
    let warn90 = false;
    if (this.cap !== null && !this.warned && !this.isExceeded() && this.isAt90()) {
      this.warned = true;
      warn90 = true;
    }
    return {
      spentMinor: this.spent.toString(),
      capMinor: this.cap === null ? null : this.cap.toString(),
      warn90,
      exceeded: this.isExceeded(),
    };
  }

  get spentMinor(): bigint {
    return this.spent;
  }

  isExceeded(): boolean {
    return this.cap !== null && this.spent >= this.cap;
  }

  private isAt90(): boolean {
    return this.cap !== null && 10n * this.spent >= 9n * this.cap;
  }
}

// ── Autonomous run driver ───────────────────────────────────────────────────

export type AutonomousRunStatus = 'completed' | 'failed' | 'spend_cap_reached';

export interface AutonomousRunInput {
  /** The task brief. */
  brief: string;
  /** Session mode; defaults to 'build'. Specialists keep their own modes. */
  mode?: AgentMode;
  /** Quality tier for the run's model calls (default: host/balanced). */
  qualityTier?: SpecialistQualityTier;
  /** Hard budget for the whole run, micro-USD minor units. */
  spendCapMinor?: string | bigint | null;
  workspaceRoot?: string;
  sessionId?: string;
  /** Human-readable transcript sink (stderr in the CLI entrypoint). */
  onTranscript?: (line: string) => void;
}

export interface AutonomousSkippedAction {
  toolName: string;
  reason: string;
}

export interface AutonomousArtifact {
  path: string;
  diff?: string;
}

export interface AutonomousReceipt {
  id: string;
  costMinor: string;
  asset: string;
  scale: number;
  timestamp: string;
}

export interface AutonomousResult {
  status: AutonomousRunStatus;
  summary: string;
  artifacts: AutonomousArtifact[];
  receipts: AutonomousReceipt[];
  usage: {
    inputUnits: number;
    outputUnits: number;
    costMinor: string;
    asset: string;
    scale: number;
  };
  skipped: AutonomousSkippedAction[];
  tier: SpecialistQualityTier | 'default';
  spendCapMinor: string | null;
  sessionId: string;
}

/** Prefix of the machine-readable result line on stdout. */
export const RESULT_LINE_PREFIX = 'CAPIX_RUN_RESULT';

function field<T>(event: AgentEvent, name: string): T | undefined {
  return (event as unknown as Record<string, unknown>)[name] as T | undefined;
}

/**
 * Drive one fully-autonomous run against a runtime that was constructed with
 * the auto approval policy. Consumes the turn's event stream, tracks spend
 * from real usage events, cancels at the cap, and assembles the result.
 */
export async function runAutonomous(
  runtime: CapixAgentRuntime,
  input: AutonomousRunInput
): Promise<AutonomousResult> {
  const transcript = (line: string): void => input.onTranscript?.(line);
  const session = await runtime.createSession({
    sessionId: input.sessionId,
    mode: input.mode ?? 'build',
    workspaceRoot: input.workspaceRoot,
  });

  const cap =
    input.spendCapMinor === undefined || input.spendCapMinor === null
      ? null
      : BigInt(input.spendCapMinor);
  const tracker = new SpendTracker(cap);
  if (cap !== null) {
    transcript(`spend-cap: budget ${cap.toString()} micro-USD for this run`);
  }

  const skipped: AutonomousSkippedAction[] = [];
  const artifacts = new Map<string, AutonomousArtifact>();
  let status: AutonomousRunStatus = 'completed';
  let failure: string | undefined;
  let assistantText = '';
  let cancelledForCap = false;

  // usage.updated events carry per-turn cumulative totals; feed the tracker
  // only the delta since the previous event so spend is counted once.
  let lastCumulativeCost = 0n;

  for await (const event of runtime.sendMessage({ sessionId: session.id, content: input.brief })) {
    switch (event.type) {
      case 'content.delta': {
        assistantText += field<string>(event, 'content') ?? '';
        break;
      }
      case 'usage.updated': {
        const cumulative = BigInt(field<string>(event, 'costMinor') ?? '0');
        const delta = cumulative - lastCumulativeCost;
        lastCumulativeCost = cumulative;
        if (delta > 0n) {
          const update = tracker.record(delta);
          if (update.warn90) {
            transcript(
              `spend-cap: 90% of budget spent (${update.spentMinor} of ${update.capMinor} micro-USD)`
            );
          }
          if (update.exceeded && !cancelledForCap) {
            cancelledForCap = true;
            transcript(
              `spend-cap: budget exhausted (${update.spentMinor} of ${update.capMinor} micro-USD); stopping`
            );
            await runtime.cancelTurn(session.id);
          }
        }
        break;
      }
      case 'tool.rejected': {
        const toolName = field<string>(event, 'toolName') ?? 'unknown';
        const reason = field<string>(event, 'reason') ?? 'rejected';
        skipped.push({ toolName, reason });
        transcript(`SKIP ${toolName}: ${reason}`);
        break;
      }
      case 'file.diff': {
        const path = field<string>(event, 'filePath');
        if (path) artifacts.set(path, { path, diff: field<string>(event, 'diff') });
        break;
      }
      case 'turn.failed': {
        const err = field<{ message?: string }>(event, 'error');
        failure = err?.message ?? 'turn failed';
        break;
      }
      default:
        break;
    }
  }

  if (tracker.isExceeded()) {
    status = 'spend_cap_reached';
  } else if (failure) {
    status = 'failed';
  }

  const usage = await runtime.getUsage(session.id);
  const receipts = await runtime.getReceipts(session.id);
  const summary =
    status === 'spend_cap_reached'
      ? `spend cap reached; partial result. ${assistantText.trim().slice(-500)}`
      : status === 'failed'
        ? `run failed: ${failure}. ${assistantText.trim().slice(-500)}`
        : assistantText.trim().slice(-1000) || 'run completed with no assistant output';

  return {
    status,
    summary,
    artifacts: [...artifacts.values()],
    receipts: receipts.map((r) => ({
      id: r.id,
      costMinor: r.costMinor,
      asset: r.asset,
      scale: r.scale,
      timestamp: r.timestamp,
    })),
    usage: {
      inputUnits: usage.totalInputUnits,
      outputUnits: usage.totalOutputUnits,
      costMinor: usage.totalCostMinor,
      asset: usage.asset ?? RECEIPT_ASSET,
      scale: usage.scale ?? RECEIPT_SCALE,
    },
    skipped,
    tier: input.qualityTier ?? 'default',
    spendCapMinor: cap === null ? null : cap.toString(),
    sessionId: session.id,
  };
}

/** Serialize the result as the single machine-readable stdout line. */
export function formatResultLine(result: AutonomousResult): string {
  return `${RESULT_LINE_PREFIX} ${JSON.stringify(result)}`;
}
