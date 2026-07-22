/**
 * Capix Intelligence Layer — Exit Report Writer
 *
 * Ported from Covenant Framework's Exit Report (Constitution Section I.5).
 *
 * When any Capix agent finishes a task, it writes a structured exit report.
 * This is the mechanism by which wisdom accumulates — each completion
 * adds to the handoff layer, which gets consolidated into semantic memory.
 */

import { writeExitReport, type ExitReport } from "./memory/store";

export interface ExitReportInput {
  agentId: string;
  mandate: string;
  mandateCompleted: boolean;
  keyFindings?: string[];
  whatWorked?: string;
  whatFailed?: string;
  recommendationsForNextAgent?: string;
  tokensConsumed?: string;
  shouldHaveBeenSplit?: boolean;
  spiritContribution?: string;
  gaps?: ExitReport["gaps"];
  decisions?: ExitReport["decisions"];
}

/**
 * Write an exit report when an agent finishes.
 *
 * This should be called at the end of every agent task, whether it succeeded
 * or failed. The report captures what happened so future agents can learn
 * from it.
 *
 * Example:
 * ```typescript
 * writeReport({
 *   agentId: "nodey-build-42",
 *   mandate: "Build a meme generator and deploy on Capix",
 *   mandateCompleted: true,
 *   whatWorked: "Picked a simple single-file HTML approach instead of Next.js — deployed in 90s",
 *   whatFailed: "First attempt with Next.js took 8min and timed out the sandbox",
 *   recommendationsForNextAgent: "For small demos, use single-file HTML. Reserve Next.js for multi-page apps.",
 *   spiritContribution: "Small scope ships faster than perfect scope. The meme generator got 400 RTs.",
 *   tokensConsumed: "~8000",
 *   shouldHaveBeenSplit: false,
 *   decisions: [
 *     { choice: "HTML instead of Next.js", reasoning: "Faster deploy, no build step", confidence: 0.9 },
 *   ],
 * });
 * ```
 */
export function writeReport(input: ExitReportInput, soulName: string = "capix-code"): void {
  const report: ExitReport = {
    agentId: input.agentId,
    mandate: input.mandate,
    mandateCompleted: input.mandateCompleted,
    keyFindings: input.keyFindings ?? [],
    whatWorked: input.whatWorked ?? "",
    whatFailed: input.whatFailed ?? "",
    recommendationsForNextAgent: input.recommendationsForNextAgent ?? "",
    tokensConsumed: input.tokensConsumed ?? "",
    shouldHaveBeenSplit: input.shouldHaveBeenSplit ?? false,
    spiritContribution: input.spiritContribution ?? "",
    gaps: input.gaps ?? [],
    decisions: input.decisions ?? [],
    timestamp: new Date().toISOString(),
  };

  writeExitReport(report, soulName);
}

/**
 * Build an exit report from a failed task.
 * Shortcut for writing failure reports.
 */
export function writeFailureReport(
  agentId: string,
  mandate: string,
  error: string,
  soulName: string = "capix-code",
): void {
  writeReport({
    agentId,
    mandate,
    mandateCompleted: false,
    whatFailed: error,
    recommendationsForNextAgent: `Avoid the approach that led to: ${error.slice(0, 100)}`,
    spiritContribution: `Learning: ${error.slice(0, 100)}`,
  }, soulName);
}

/**
 * Build an exit report from a successful task.
 * Shortcut for writing success reports.
 */
export function writeSuccessReport(
  agentId: string,
  mandate: string,
  whatWorked: string,
  soulName: string = "capix-code",
): void {
  writeReport({
    agentId,
    mandate,
    mandateCompleted: true,
    whatWorked,
    spiritContribution: `Success: ${whatWorked.slice(0, 100)}`,
  }, soulName);
}
