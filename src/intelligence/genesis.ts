/**
 * Capix Intelligence Layer — Genesis Phase
 *
 * Ported from Covenant Framework's Genesis Phase (Constitution Section I(b)).
 *
 * Before any agent takes its first action, it must build a world model:
 * read the spirit, check the registry, review handoff/inheritance,
 * scan unread memos, and search semantic memory for relevant past
 * learnings. Then state its understanding before acting.
 *
 * This is what makes agents smarter over time — they start each
 * cycle already knowing what previous cycles learned.
 */

import { loadSpirit, type Spirit } from "./spirit";
import {
  getUnconsolidatedHandoff,
  getUnreadMemos,
  searchMemory,
  loadUserModel,
} from "./memory/store";

export interface GenesisBriefing {
  agentId: string;
  generatedAt: string;
  genesisTier: "light" | "full";

  // The Spirit — current orientation
  spirit: {
    currentMandate: string;
    spiritOfTheWork: string;
    whatToProtect: string[];
    currentTemptations: string[];
    whereWeAre: string;
    cycleCount: number;
  };

  // Recent handoff (what predecessors left)
  recentHandoff: Array<{
    agentId: string;
    mandate: string;
    whatWorked: string;
    whatFailed: string;
    recommendationsForNextAgent: string;
  }>;

  // Unread memos (lateral messages waiting)
  unreadMemos: Array<{
    from: string;
    subject: string;
    priority: string;
    content: { practical: string };
  }>;

  // Semantic memory hits (past consolidated learnings)
  memoryHits: Array<{
    source: string;
    content: string;
    weight: number;
  }>;

  // User model (what we know about the developer)
  userModel: {
    statedGoals: string[];
    observedPatterns: string[];
    recurringFrustrations: string[];
  };

  // The world model — agent's own understanding
  worldModel: string;
}

/**
 * Run the Genesis Phase — gather all context before an agent acts.
 *
 * @param agentId The agent's unique ID
 * @param mandate What the agent is trying to do
 * @param soulName Which soul (nodey, capix-code, etc.)
 * @param tokensExpected Low/medium/high (determines briefing depth)
 */
export function genesis(
  agentId: string,
  mandate: string,
  soulName: string = "capix-code",
  tokensExpected: "low" | "medium" | "high" = "medium",
): GenesisBriefing {
  const tier: "light" | "full" = tokensExpected === "high" ? "full" : "light";

  // 1. Read the Spirit
  const spirit = loadSpirit(soulName);

  // 2. Read recent handoff (exit reports from previous agents)
  const allHandoff = getUnconsolidatedHandoff(soulName);
  const recentHandoff = allHandoff.slice(0, tier === "full" ? 10 : 3).map((r) => ({
    agentId: r.agentId,
    mandate: r.mandate,
    whatWorked: r.whatWorked,
    whatFailed: r.whatFailed,
    recommendationsForNextAgent: r.recommendationsForNextAgent,
  }));

  // 3. Check unread memos
  const memos = getUnreadMemos(soulName);
  const unreadMemos = memos.slice(0, tier === "full" ? 10 : 3).map((m) => ({
    from: m.from,
    subject: m.subject,
    priority: m.priority,
    content: { practical: m.content.practical },
  }));

  // 4. Search semantic memory for relevant past learnings
  const searchMode = tier === "full" ? "deep" : tier === "light" ? "fast" : "balanced";
  const memoryHits = searchMemory(mandate, searchMode, soulName).map((h) => ({
    source: h.source,
    content: h.content.slice(0, tier === "full" ? 2000 : 500),
    weight: h.weight,
  }));

  // 5. Load user model
  const userModel = loadUserModel(soulName);

  // 6. Form the world model — a 1-2 sentence statement of understanding
  const worldModel = formWorldModel(spirit, mandate, recentHandoff, unreadMemos, memoryHits);

  return {
    agentId,
    generatedAt: new Date().toISOString(),
    genesisTier: tier,
    spirit: {
      currentMandate: spirit.currentMandate,
      spiritOfTheWork: spirit.spiritOfTheWork,
      whatToProtect: spirit.whatToProtect,
      currentTemptations: spirit.currentTemptations,
      whereWeAre: spirit.whereWeAre,
      cycleCount: spirit.cycleCount,
    },
    recentHandoff,
    unreadMemos,
    memoryHits,
    userModel: {
      statedGoals: userModel.statedGoals,
      observedPatterns: userModel.observedPatterns.slice(-5),
      recurringFrustrations: userModel.recurringFrustrations.slice(-3),
    },
    worldModel,
  };
}

/**
 * Form a world model — the agent's understanding of its situation.
 * Derived from the spirit, mandate, handoff, memos, and memory.
 */
function formWorldModel(
  spirit: Spirit,
  mandate: string,
  handoff: GenesisBriefing["recentHandoff"],
  memos: GenesisBriefing["unreadMemos"],
  memory: GenesisBriefing["memoryHits"],
): string {
  const parts: string[] = [];

  // What's the spirit saying?
  parts.push(`Current mandate: ${spirit.currentMandate}`);

  // My task
  parts.push(`My task: ${mandate}`);

  // What predecessors learned
  if (handoff.length > 0) {
    const topRecommendation = handoff[0]?.recommendationsForNextAgent;
    if (topRecommendation) {
      parts.push(`Previous agent recommended: ${topRecommendation.slice(0, 120)}`);
    }
    const topFailure = handoff[0]?.whatFailed;
    if (topFailure) {
      parts.push(`Previous agent's failure: ${topFailure.slice(0, 120)}`);
    }
  }

  // Unread memos
  if (memos.length > 0) {
    parts.push(`${memos.length} unread memo(s). Most urgent: ${memos[0].subject}`);
  }

  // Relevant memory
  if (memory.length > 0) {
    parts.push(`Found ${memory.length} relevant past learnings (top weight: ${memory[0].weight})`);
  }

  // What to protect
  if (spirit.whatToProtect.length > 0) {
    parts.push(`Protecting: ${spirit.whatToProtect.slice(0, 2).join(", ")}`);
  }

  return parts.join(". ");
}

/**
 * Build the Genesis prompt — what gets prepended to the system prompt.
 * This is the accumulated context that makes the agent smarter.
 */
export function buildGenesisPrompt(briefing: GenesisBriefing): string {
  const lines: string[] = [];

  lines.push("## Your Context (Genesis Briefing)");
  lines.push("");
  lines.push(`**Spirit:** ${briefing.spirit.spiritOfTheWork}`);
  lines.push(`**Mandate:** ${briefing.spirit.currentMandate}`);
  lines.push(`**Where we are:** ${briefing.spirit.whereWeAre}`);
  lines.push(`**Protect:** ${briefing.spirit.whatToProtect.join(", ")}`);
  lines.push(`**Temptations to avoid:** ${briefing.spirit.currentTemptations.join(", ")}`);
  lines.push("");

  if (briefing.recentHandoff.length > 0) {
    lines.push("## What Previous Agents Learned");
    for (const h of briefing.recentHandoff.slice(0, 3)) {
      lines.push(`- ${h.agentId}: ${h.mandate}`);
      if (h.whatWorked) lines.push(`  Worked: ${h.whatWorked.slice(0, 150)}`);
      if (h.whatFailed) lines.push(`  Failed: ${h.whatFailed.slice(0, 150)}`);
      if (h.recommendationsForNextAgent) lines.push(`  Recommendation: ${h.recommendationsForNextAgent.slice(0, 150)}`);
    }
    lines.push("");
  }

  if (briefing.unreadMemos.length > 0) {
    lines.push("## Unread Memos");
    for (const m of briefing.unreadMemos) {
      lines.push(`- [${m.priority}] from ${m.from}: ${m.subject}`);
      lines.push(`  ${m.content.practical.slice(0, 200)}`);
    }
    lines.push("");
  }

  if (briefing.memoryHits.length > 0) {
    lines.push("## Relevant Past Learnings");
    for (const m of briefing.memoryHits.slice(0, 3)) {
      lines.push(`- (weight: ${m.weight}) ${m.source}: ${m.content.slice(0, 200)}`);
    }
    lines.push("");
  }

  if (briefing.userModel.observedPatterns.length > 0) {
    lines.push("## User Patterns");
    for (const p of briefing.userModel.observedPatterns.slice(0, 5)) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  lines.push("## World Model");
  lines.push(briefing.worldModel);
  lines.push("");

  return lines.join("\n");
}
