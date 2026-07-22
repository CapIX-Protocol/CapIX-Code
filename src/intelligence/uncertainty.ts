/**
 * Capix Intelligence Layer — Uncertainty Protocol
 *
 * Ported from Covenant Framework's Uncertainty Protocol (Constitution Section XXIX).
 *
 * When an agent doesn't know something, it must say so — never fabricate,
 * never act confidently on uncertain information. This builds trust.
 *
 * The protocol has 3 levels:
 * 1. HIGH confidence (>0.8): proceed without asking
 * 2. MEDIUM confidence (0.5-0.8): proceed but flag the uncertainty in output
 * 3. LOW confidence (<0.5): STOP and ask for guidance
 */

export type Confidence = "high" | "medium" | "low";

export interface UncertaintyAssessment {
  confidence: Confidence;
  whatIKnow: string;
  whatIDontKnow: string[];
  recommendation: "proceed" | "proceed-with-caveat" | "stop-and-ask";
  caveat?: string;
}

/**
 * Assess confidence for an action.
 *
 * @param confidenceScore 0.0 to 1.0
 * @param whatIKnow What the agent is certain about
 * @param unknowns What the agent doesn't know
 * @returns An assessment with a recommendation
 */
export function assessConfidence(
  confidenceScore: number,
  whatIKnow: string,
  unknowns: string[],
): UncertaintyAssessment {
  if (confidenceScore >= 0.8) {
    return {
      confidence: "high",
      whatIKnow,
      whatIDontKnow: unknowns,
      recommendation: "proceed",
    };
  }

  if (confidenceScore >= 0.5) {
    return {
      confidence: "medium",
      whatIKnow,
      whatIDontKnow: unknowns,
      recommendation: "proceed-with-caveat",
      caveat: `I'm not fully certain about: ${unknowns.join(", ")}. Proceeding with best judgment.`,
    };
  }

  return {
    confidence: "low",
    whatIKnow,
    whatIDontKnow: unknowns,
    recommendation: "stop-and-ask",
    caveat: `I don't know enough about: ${unknowns.join(", ")}. I should ask before proceeding.`,
  };
}

/**
 * Build an uncertainty disclaimer for inclusion in agent output.
 */
export function buildUncertaintyDisclaimer(assessment: UncertaintyAssessment): string | null {
  if (assessment.recommendation === "proceed") return null;
  if (assessment.recommendation === "proceed-with-caveat" && assessment.caveat) {
    return `⚠️ ${assessment.caveat}`;
  }
  if (assessment.recommendation === "stop-and-ask") {
    return `❓ I need more information before proceeding. I'm uncertain about: ${assessment.whatIDontKnow.join(", ")}`;
  }
  return null;
}
