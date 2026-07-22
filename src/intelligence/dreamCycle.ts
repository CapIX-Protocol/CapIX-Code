/**
 * Capix Intelligence Layer — Dream Cycle
 *
 * Ported from Covenant Framework's Dream Cycle (Constitution Section V-B).
 *
 * Between mandates, the system does housekeeping. Non-blocking, non-spawning,
 * idempotent. Runs when the system has been idle.
 *
 * - Freshness decay on exit reports
 * - Stale memo cleanup (>7 days unread → marked read)
 * - Orphan agent detection
 * - Domain memory refresh flagging
 * - External platform check (Nodey's X mentions)
 */

import { loadSpirit } from "./spirit";
import {
  getUnconsolidatedHandoff,
  getUnreadMemos,
  markMemoRead,
  type ExitReport,
  type StructuredMemo,
} from "./memory/store";
import { existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STALE_MEMO_DAYS = 7;
const STALE_HANDOFF_DAYS = 30;

export interface DreamCycleReport {
  timestamp: string;
  operations: string[];
  staleMemosCleaned: number;
  staleHandoffDetected: number;
  orphanAgentsDetected: number;
  compressionAnchorsCleaned: number;
}

/**
 * Run the Dream Cycle — housekeeping between mandates.
 */
export function runDreamCycle(soulName: string = "capix-code"): DreamCycleReport {
  const operations: string[] = [];
  let staleMemosCleaned = 0;
  let staleHandoffDetected = 0;
  let orphanAgentsDetected = 0;
  let compressionAnchorsCleaned = 0;

  const now = Date.now();
  const staleMemoMs = STALE_MEMO_DAYS * 24 * 60 * 60 * 1000;
  const staleHandoffMs = STALE_HANDOFF_DAYS * 24 * 60 * 60 * 1000;

  // 1. Stale memo cleanup
  const memos = getUnreadMemos(soulName);
  for (const memo of memos) {
    const memoAge = now - Date.parse(memo.timestamp);
    if (memoAge > staleMemoMs) {
      markMemoRead(memo.id, soulName);
      staleMemosCleaned++;
    }
  }
  if (staleMemosCleaned > 0) {
    operations.push(`Marked ${staleMemosCleaned} stale memos (>7 days unread) as read`);
  }

  // 2. Stale handoff detection
  const handoff = getUnconsolidatedHandoff(soulName);
  for (const report of handoff) {
    const reportAge = now - Date.parse(report.timestamp);
    if (reportAge > staleHandoffMs) {
      staleHandoffDetected++;
    }
  }
  if (staleHandoffDetected > 0) {
    operations.push(`Detected ${staleHandoffDetected} stale handoff reports (>30 days old) — consider consolidating`);
  }

  // 3. Orphan agent detection (agents that started but never wrote exit reports)
  // This would check the agent registry vs exit reports
  // Simplified: just check if handoff has very old entries with no exit report
  orphanAgentsDetected = handoff.filter((r) => {
    const reportAge = now - Date.parse(r.timestamp);
    return reportAge > staleHandoffMs * 2 && !r.freshnessScore;
  }).length;
  if (orphanAgentsDetected > 0) {
    operations.push(`Detected ${orphanAgentsDetected} potential orphan agents (started but never completed)`);
  }

  // 4. Compression anchor cleanup
  // Remove anchors for agents that have been archived
  // (Simplified: cleanup is handled by the memory store during consolidation)
  // This is a placeholder for the full implementation

  // 5. Check spirit freshness
  const spirit = loadSpirit(soulName);
  const spiritAge = now - Date.parse(spirit.lastUpdatedAt);
  if (spiritAge > staleHandoffMs) {
    operations.push(`Spirit is ${Math.floor(spiritAge / (24 * 60 * 60 * 1000))} days old — consider updating mandate`);
  }

  // 6. Domain memory refresh flagging
  // If 3+ new handoff reports since last consolidation, flag for consolidation
  if (handoff.length >= 3) {
    operations.push(`${handoff.length} unconsolidated handoff reports — consolidation recommended`);
  }

  if (operations.length === 0) {
    operations.push("Dream cycle complete. System is clean.");
  }

  return {
    timestamp: new Date().toISOString(),
    operations,
    staleMemosCleaned,
    staleHandoffDetected,
    orphanAgentsDetected,
    compressionAnchorsCleaned,
  };
}
