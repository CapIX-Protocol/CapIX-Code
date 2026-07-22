/**
 * Capix Intelligence Layer — Progressive Trust
 *
 * Ported from Covenant Framework's Progressive Trust (Constitution Section XXXII).
 *
 * Agents earn autonomy through proven reliability:
 *   Untested → Proven → Trusted → Veteran
 *
 * In Capix Code:
 * - New users: build mode (every write needs approval)
 * - After 10 successful deploys: auto mode (auto-approve within spend cap)
 * - After 50: veteran (higher caps, fewer guardrails)
 *
 * For Nodey:
 * - First 5 posts: manual approval required
 * - After 5: auto-post within guidelines
 * - After 20: veteran (can post without daily limit)
 */

export type TrustLevel = "untested" | "proven" | "trusted" | "veteran";

export interface TrustRecord {
  agentId: string;
  level: TrustLevel;
  successfulActions: number;
  failedActions: number;
  totalSpendCents: number;
  history: TrustEvent[];
  lastUpdated: string;
}

interface TrustEvent {
  timestamp: string;
  action: string;
  outcome: "success" | "failure" | "partial";
  spendCents: number;
}

const THRESHOLDS: Record<TrustLevel, { minSuccess: number; maxFailure: number; nextLevel?: TrustLevel }> = {
  untested: { minSuccess: 5, maxFailure: 2, nextLevel: "proven" },
  proven: { minSuccess: 15, maxFailure: 4, nextLevel: "trusted" },
  trusted: { minSuccess: 40, maxFailure: 8, nextLevel: "veteran" },
  veteran: { minSuccess: Infinity, maxFailure: Infinity },
};

/**
 * Check if an agent can auto-approve an action based on its trust level.
 */
export function canAutoApprove(trust: TrustRecord, actionType: string): boolean {
  switch (trust.level) {
    case "veteran":
      return true;
    case "trusted":
      // Trusted agents can auto-approve within their domain
      return true;
    case "proven":
      // Proven agents can auto-approve simple actions
      return ["reply", "analyze", "help", "search"].includes(actionType);
    case "untested":
    default:
      return false;
  }
}

/**
 * Record a successful action and potentially promote trust level.
 */
export function recordSuccess(trust: TrustRecord, action: string, spendCents: number): TrustRecord {
  trust.successfulActions++;
  trust.totalSpendCents += spendCents;
  trust.history.push({
    timestamp: new Date().toISOString(),
    action,
    outcome: "success",
    spendCents,
  });
  trust.lastUpdated = new Date().toISOString();

  // Check for promotion
  const threshold = THRESHOLDS[trust.level];
  if (threshold.nextLevel && trust.successfulActions >= threshold.minSuccess && trust.failedActions <= threshold.maxFailure) {
    trust.level = threshold.nextLevel;
  }

  return trust;
}

/**
 * Record a failure. Too many failures might demote trust level.
 */
export function recordFailure(trust: TrustRecord, action: string, spendCents: number): TrustRecord {
  trust.failedActions++;
  trust.history.push({
    timestamp: new Date().toISOString(),
    action,
    outcome: "failure",
    spendCents,
  });
  trust.lastUpdated = new Date().toISOString();

  // Demote if failure rate is too high
  const totalActions = trust.successfulActions + trust.failedActions;
  if (totalActions > 5) {
    const failureRate = trust.failedActions / totalActions;
    if (failureRate > 0.4 && trust.level !== "untested") {
      const levels: TrustLevel[] = ["untested", "proven", "trusted", "veteran"];
      const currentIndex = levels.indexOf(trust.level);
      if (currentIndex > 0) {
        trust.level = levels[currentIndex - 1];
      }
    }
  }

  return trust;
}

/**
 * Get the spend cap for a trust level.
 */
export function getSpendCap(level: TrustLevel): number {
  switch (level) {
    case "veteran": return 2000; // $20/day
    case "trusted": return 1000; // $10/day
    case "proven": return 500;   // $5/day
    case "untested":
    default: return 200;         // $2/day
  }
}
