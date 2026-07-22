/**
 * Capix Intelligence Layer — Consolidation Engine
 *
 * Ported from Covenant Framework's Consolidation ritual.
 *
 * After every N cycles, the system reviews itself:
 * 1. Checkpoint current state
 * 2. Gather unconsolidated handoff
 * 3. Synthesize into semantic memory
 * 4. Update user model
 * 5. Review memos
 * 6. Assess progress
 * 7. Compute health score
 * 8. Retrospective
 * 9. Update spirit
 * 10. Generate parables from failures/successes
 */

import { loadSpirit, updateSpirit, addLearning, type Spirit } from "./spirit";
import {
  getUnconsolidatedHandoff,
  writeSemanticMemory,
  markConsolidated,
  getUnreadMemos,
  markMemoRead,
  writeParable,
  type ExitReport,
  type StructuredMemo,
} from "./memory/store";

export interface ConsolidationReport {
  timestamp: string;
  cycle: string;
  summary: string;
  whatWorked: string[];
  whatFailed: string[];
  whatILearned: string[];
  whoNeedsFollowUp: string[];
  spiritUpdate: {
    mandate: string;
    whereWeAre: string;
    newLearnings: string[];
  };
  healthScore: {
    total: number;
    hygiene: number;
    compliance: number;
    trust: number;
    freshness: number;
  };
  nextActions: string[];
  parablesGenerated: number;
}

const CONSOLIDATION_INTERVAL = 10; // Run after every 10 cycles

/**
 * Check if consolidation should run.
 */
export function shouldConsolidate(soulName: string = "capix-code"): boolean {
  const spirit = loadSpirit(soulName);
  return spirit.cycleCount > 0 && spirit.cycleCount % CONSOLIDATION_INTERVAL === 0;
}

/**
 * Run the full consolidation ritual.
 */
export function consolidate(soulName: string = "capix-code"): ConsolidationReport {
  const spirit = loadSpirit(soulName);
  const handoff = getUnconsolidatedHandoff(soulName);
  const memos = getUnreadMemos(soulName);
  const whatWorked: string[] = [];
  const whatFailed: string[] = [];
  const whatILearned: string[] = [];
  let parablesGenerated = 0;

  // 1. Analyze handoff reports
  for (const report of handoff) {
    if (report.whatWorked) whatWorked.push(`${report.agentId}: ${report.whatWorked.slice(0, 100)}`);
    if (report.whatFailed) whatFailed.push(`${report.agentId}: ${report.whatFailed.slice(0, 100)}`);
    if (report.spiritContribution) whatILearned.push(report.spiritContribution.slice(0, 100));
  }

  // 2. Synthesize into semantic memory
  const semanticContent = buildSemanticDocument(spirit, handoff, whatWorked, whatFailed, whatILearned);
  writeSemanticMemory(
    `Consolidation — Cycle ${spirit.cycleCount}`,
    semanticContent,
    soulName,
  );

  // 3. Mark handoff as consolidated
  for (const report of handoff) {
    markConsolidated(report.agentId, soulName);
  }

  // 4. Review memos
  for (const memo of memos) {
    markMemoRead(memo.id, soulName);
  }

  // 5. Generate parables from notable failures/successes
  for (const report of handoff) {
    if (report.whatFailed && report.shouldHaveBeenSplit) {
      writeParable(
        `The ${report.mandate.slice(0, 30)} That Was Too Big`,
        report.whatFailed,
        "Some mandates are too big for one agent. If the scope felt overwhelming, the mandate should have been split before execution.",
        "Before starting a task, assess if it needs to be broken down into smaller pieces.",
        soulName,
      );
      parablesGenerated++;
    }
  }

  // 6. Compute health score
  const healthScore = computeHealthScore(spirit, handoff, memos);

  // 7. Generate next actions
  const nextActions = generateNextActions(spirit, whatWorked, whatFailed, healthScore);

  // 8. Generate new learnings
  const newLearnings: string[] = [];
  if (whatWorked.length > whatFailed.length) {
    newLearnings.push("This cycle was mostly successful. Continue the current approach.");
  } else if (whatFailed.length > whatWorked.length) {
    newLearnings.push("This cycle had more failures than successes. Adjust approach before next cycle.");
  }
  if (handoff.length > 5) {
    newLearnings.push("High agent turnover — consider if tasks are being scoped correctly.");
  }
  if (memos.length > 3) {
    newLearnings.push("Communication backlog detected — stay on top of unread memos.");
  }

  // 9. Update the spirit
  const updatedSpirit = updateSpirit({
    currentMandate: generateNextMandate(spirit, whatWorked, whatFailed, healthScore, nextActions),
    whereWeAre: `Cycle ${spirit.cycleCount + 1}. ${handoff.length} reports consolidated. ${whatWorked.length} wins, ${whatFailed.length} issues. Health: ${healthScore.total}/100. ${newLearnings.length} new learnings. ${parablesGenerated} parables generated.`,
    spiritOfTheWork: evolveSpiritOfWork(spirit, whatWorked, whatFailed, newLearnings),
  }, soulName);

  // 10. Add learnings to spirit
  for (const learning of newLearnings) {
    addLearning(learning, "consolidation", soulName);
  }

  const report: ConsolidationReport = {
    timestamp: new Date().toISOString(),
    cycle: `consolidation-${spirit.cycleCount}`,
    summary: `Consolidation complete. ${handoff.length} reports processed. ${whatWorked.length} wins, ${whatFailed.length} issues. Health: ${healthScore.total}/100.`,
    whatWorked: whatWorked.slice(0, 5),
    whatFailed: whatFailed.slice(0, 5),
    whatILearned: newLearnings,
    whoNeedsFollowUp: [], // Populated from spirit contacts
    spiritUpdate: {
      mandate: updatedSpirit.currentMandate,
      whereWeAre: updatedSpirit.whereWeAre,
      newLearnings,
    },
    healthScore,
    nextActions,
    parablesGenerated,
  };

  return report;
}

/** Build the semantic memory document. */
function buildSemanticDocument(
  spirit: Spirit,
  handoff: ExitReport[],
  whatWorked: string[],
  whatFailed: string[],
  whatILearned: string[],
): string {
  const parts: string[] = [];

  parts.push("## What Was Accomplished");
  for (const r of handoff.slice(0, 10)) {
    parts.push(`- ${r.agentId}: ${r.mandate} (${r.mandateCompleted ? "completed" : "incomplete"})`);
  }

  if (whatWorked.length > 0) {
    parts.push("\n## What Was Learned");
    for (const w of whatWorked.slice(0, 5)) {
      parts.push(`- ${w}`);
    }
  }

  if (whatFailed.length > 0) {
    parts.push("\n## What Failed or Was Rejected");
    for (const f of whatFailed.slice(0, 5)) {
      parts.push(`- ${f}`);
    }
  }

  if (whatILearned.length > 0) {
    parts.push("\n## Recommendations for Next Cycle");
    for (const l of whatILearned.slice(0, 5)) {
      parts.push(`- ${l}`);
    }
  }

  parts.push("\n## Spirit State");
  parts.push(`- Mandate: ${spirit.currentMandate}`);
  parts.push(`- Where we are: ${spirit.whereWeAre}`);

  return parts.join("\n");
}

/** Compute the health score (4 components × 25pts = 100). */
function computeHealthScore(
  spirit: Spirit,
  handoff: ExitReport[],
  memos: StructuredMemo[],
): { total: number; hygiene: number; compliance: number; trust: number; freshness: number } {
  // Hygiene: no orphans, no stale data
  let hygiene = 25;
  if (handoff.length > 20) hygiene -= 10; // Too much unprocessed handoff

  // Compliance: agents following rules (simplified)
  let compliance = 25;
  const incomplete = handoff.filter((r) => !r.mandateCompleted);
  if (incomplete.length > handoff.length / 2) compliance -= 10;

  // Trust: progressive trust (simplified — based on cycle count)
  const trust = Math.min(25, spirit.cycleCount * 2);

  // Freshness: memory is current
  let freshness = 25;
  if (spirit.learnings.length === 0) freshness -= 15;
  if (memos.length > 5) freshness -= 10; // Backlog

  const total = hygiene + compliance + trust + freshness;
  return { total, hygiene, compliance, trust, freshness };
}

/** Generate the next mandate based on current state. */
function generateNextMandate(
  spirit: Spirit,
  whatWorked: string[],
  whatFailed: string[],
  healthScore: ConsolidationReport["healthScore"],
  _nextActions: string[],
): string {
  if (whatFailed.length > whatWorked.length) {
    return "Previous cycle had more failures than successes. Adjust approach. Focus on what worked before.";
  }
  if (healthScore.total < 50) {
    return "System health is low. Focus on cleanup, reducing scope, and fixing root causes.";
  }
  return spirit.currentMandate; // Keep the same mandate if things are going well
}

/** Evolve the spirit of the work based on what happened. */
function evolveSpiritOfWork(
  spirit: Spirit,
  whatWorked: string[],
  whatFailed: string[],
  newLearnings: string[],
): string {
  // If we have learnings, append them to the spirit
  if (newLearnings.length > 0) {
    return `${spirit.spiritOfTheWork} | Cycle update: ${newLearnings[0]}`;
  }
  return spirit.spiritOfTheWork;
}

/** Generate next actions based on state. */
function generateNextActions(
  spirit: Spirit,
  whatWorked: string[],
  whatFailed: string[],
  healthScore: ConsolidationReport["healthScore"],
): string[] {
  const actions: string[] = [];

  if (healthScore.total < 50) {
    actions.push("System health critical — reduce scope, focus on cleanup");
  }

  if (whatFailed.length > whatWorked.length) {
    actions.push("More failures than wins — review approach before next cycle");
  }

  if (spirit.learnings.filter((l) => !l.applied).length > 5) {
    actions.push("Many unapplied learnings — review and apply past lessons");
  }

  if (spirit.cycleCount < 5) {
    actions.push("Still early cycles — focus on building foundational patterns");
  } else if (spirit.cycleCount > 50) {
    actions.push("Mature system — take creative risks, try ambitious builds");
  }

  return actions;
}
