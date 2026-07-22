/**
 * Capix Intelligence Layer — Memory Store
 *
 * Ported from Covenant Framework's layered memory system.
 * Memory is stored in layered directories by freshness and trust:
 *
 *  - handoff/     : raw exit reports (recent, high detail)
 *  - inheritance/ : structured testaments (verified)
 *  - semantic/    : consolidated learnings (distilled)
 *  - parables/    : teaching stories (distilled lessons)
 *  - memos/       : structured inter-agent messages
 *
 * Retrieval uses weighted scoring:
 *  - compiled truth (2.0x): semantic memory, parables — pre-distilled
 *  - raw (1.0x): exit reports, handoff
 *  - stale (0.5x): >30 days old
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Where memory lives. */
function memoryBase(soulName: string = "default"): string {
  const base = process.env.CAPIX_MEMORY_DIR ?? join(homedir(), ".config", "capix-code", "memory", soulName);
  return base;
}

/** Ensure a memory directory exists. */
function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Get the full path for a memory layer. */
function layerPath(layer: string, soulName: string = "default"): string {
  return join(memoryBase(soulName), layer);
}

// ═══════════════════════════════════════════════════════════
// EXIT REPORTS (handoff/)
// ═══════════════════════════════════════════════════════════

export interface ExitReport {
  agentId: string;
  mandate: string;
  mandateCompleted: boolean;
  keyFindings: string[];
  whatWorked: string;
  whatFailed: string;
  recommendationsForNextAgent: string;
  tokensConsumed: string;
  shouldHaveBeenSplit: boolean;
  spiritContribution: string;
  gaps: Array<{ domain: string; description: string; impact: string; suggestedAction: string }>;
  decisions: Array<{ choice: string; reasoning: string; confidence: number }>;
  timestamp: string;
  freshnessScore?: { baseScore: number; lastReferencedAt: string };
}

/** Write an exit report to the handoff layer. */
export function writeExitReport(report: ExitReport, soulName: string = "default"): void {
  const dir = layerPath("handoff", soulName);
  ensureDir(dir);
  const filename = `${report.agentId}-exit_report.json`;
  const path = join(dir, filename);
  const fullReport: ExitReport = {
    ...report,
    freshnessScore: { baseScore: 0.5, lastReferencedAt: new Date().toISOString() },
  };
  writeFileSync(path, JSON.stringify(fullReport, null, 2), { mode: 0o600 });
}

/** Read all unconsolidated exit reports. */
export function getUnconsolidatedHandoff(soulName: string = "default"): ExitReport[] {
  const dir = layerPath("handoff", soulName);
  if (!existsSync(dir)) return [];
  const reports: ExitReport[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (data.agentId && data.mandate) reports.push(data as ExitReport);
    } catch {
      // Skip corrupted files
    }
  }
  return reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Mark a handoff file as consolidated by moving it to inheritance/. */
export function markConsolidated(agentId: string, soulName: string = "default"): void {
  const handoffDir = layerPath("handoff", soulName);
  const inheritDir = layerPath("inheritance", soulName);
  ensureDir(inheritDir);
  const source = join(handoffDir, `${agentId}-exit_report.json`);
  if (!existsSync(source)) return;
  // Read, update freshness, write to inheritance
  const data = JSON.parse(readFileSync(source, "utf8")) as ExitReport & { consolidated?: boolean };
  data.consolidated = true;
  if (data.freshnessScore) {
    data.freshnessScore.lastReferencedAt = new Date().toISOString();
  }
  writeFileSync(join(inheritDir, `${agentId}-exit_report.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ═══════════════════════════════════════════════════════════
// SEMANTIC MEMORY (consolidated learnings)
// ═══════════════════════════════════════════════════════════

/** Write a consolidated learning document. */
export function writeSemanticMemory(title: string, content: string, soulName: string = "default"): void {
  const dir = layerPath("semantic", soulName);
  ensureDir(dir);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `consolidated-${date}.md`;
  const path = join(dir, filename);
  const fullContent = `# ${title}\n\nDate: ${date}\n\n${content}\n`;
  writeFileSync(path, fullContent, { mode: 0o600 });
}

/** Read recent semantic memory files. */
export function getRecentSemanticMemory(count: number = 5, soulName: string = "default"): string[] {
  const dir = layerPath("semantic", soulName);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count);
  return files.map((f) => readFileSync(join(dir, f.name), "utf8"));
}

// ═══════════════════════════════════════════════════════════
// PARABLES (teaching stories)
// ═══════════════════════════════════════════════════════════

/** Write a parable (teaching story from a failure or success). */
export function writeParable(title: string, story: string, lesson: string, whenToRemember: string, soulName: string = "default"): void {
  const dir = layerPath("parables", soulName);
  ensureDir(dir);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const path = join(dir, `${slug}.md`);
  const content = `# Parable: ${title}\n\n${story}\n\n**The lesson:** ${lesson}\n\n**When to remember this:** ${whenToRemember}\n`;
  writeFileSync(path, content, { mode: 0o600 });
}

/** Read all parables. */
export function getParables(soulName: string = "default"): string[] {
  const dir = layerPath("parables", soulName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

// ═══════════════════════════════════════════════════════════
// STRUCTURED MEMOS (agent-to-agent lateral communication)
// ═══════════════════════════════════════════════════════════

export interface StructuredMemo {
  id: string;
  from: string;
  to: string;
  subject: string;
  priority: "low" | "normal" | "urgent";
  timestamp: string;
  read: boolean;
  content: {
    practical: string;
    edgeCases: string;
    closing: string;
  };
}

/** Write a structured memo. */
export function writeMemo(memo: Omit<StructuredMemo, "id" | "timestamp" | "read">, soulName: string = "default"): StructuredMemo {
  const dir = layerPath("memos", soulName);
  ensureDir(dir);
  const full: StructuredMemo = {
    ...memo,
    id: `memo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    read: false,
  };
  const path = join(dir, `${full.id}.json`);
  writeFileSync(path, JSON.stringify(full, null, 2), { mode: 0o600 });
  return full;
}

/** Read unread memos. */
export function getUnreadMemos(soulName: string = "default"): StructuredMemo[] {
  const dir = layerPath("memos", soulName);
  if (!existsSync(dir)) return [];
  const memos: StructuredMemo[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as StructuredMemo;
      if (!data.read) memos.push(data);
    } catch {
      // Skip corrupted
    }
  }
  return memos.sort((a, b) => {
    const priority = { urgent: 0, normal: 1, low: 2 };
    return priority[a.priority] - priority[b.priority];
  });
}

/** Mark a memo as read. */
export function markMemoRead(id: string, soulName: string = "default"): void {
  const dir = layerPath("memos", soulName);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8")) as StructuredMemo;
  data.read = true;
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ═══════════════════════════════════════════════════════════
// WEIGHTED MEMORY RETRIEVAL
// ═══════════════════════════════════════════════════════════

export type SearchMode = "fast" | "balanced" | "deep";

const MODE_DIRS: Record<SearchMode, string[]> = {
  fast: ["handoff"],
  balanced: ["handoff", "semantic"],
  deep: ["handoff", "semantic", "inheritance", "parables", "memos"],
};

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Compute weight for a file (compiled truth = 2.0, raw = 1.0, stale = 0.5). */
function computeWeight(filepath: string, content: string): number {
  const fname = filepath.split("/").pop() ?? "";
  const now = Date.now();

  // Compiled truth: semantic memory and parables get 2.0x
  if (fname.endsWith(".md") && (filepath.includes("semantic") || filepath.includes("parables"))) {
    return 2.0;
  }

  // Exit reports with high freshness get 2.0x
  if (fname.endsWith(".json") && filepath.includes("handoff")) {
    try {
      const data = JSON.parse(content);
      const base = data.freshnessScore?.baseScore ?? 0.5;
      if (base >= 0.5) return 2.0;
      if (base < 0.3) return 0.5;
    } catch {
      // Fall through
    }
  }

  // Check file age for staleness
  try {
    const stats = statSync(filepath);
    if (now - stats.mtimeMs > STALE_THRESHOLD_MS) return 0.5;
  } catch {
    // Fall through
  }

  return 1.0;
}

export interface MemoryHit {
  source: string;
  content: string;
  weight: number;
  score: number;
}

/** Search all memory layers with weighted scoring. */
export function searchMemory(query: string, mode: SearchMode = "balanced", soulName: string = "default"): MemoryHit[] {
  const base = memoryBase(soulName);
  if (!existsSync(base)) return [];

  const dirs = MODE_DIRS[mode];
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) return [];

  const hits: MemoryHit[] = [];

  for (const layer of dirs) {
    const dir = join(base, layer);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      if (!statSync(path).isFile()) continue;

      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      // Score by term frequency
      const lower = content.toLowerCase();
      let termScore = 0;
      for (const term of queryTerms) {
        const matches = (lower.match(new RegExp(term, "g")) ?? []).length;
        termScore += matches;
      }

      if (termScore === 0) continue;

      const weight = computeWeight(path, content);
      const score = termScore * weight;

      hits.push({
        source: `${layer}/${file}`,
        content: content.slice(0, 2000),
        weight,
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, mode === "fast" ? 3 : mode === "balanced" ? 5 : 10);
}

// ═══════════════════════════════════════════════════════════
// USER MODEL (longitudinal understanding of the developer)
// ═══════════════════════════════════════════════════════════

export interface UserModel {
  created: string;
  statedGoals: string[];
  observedPatterns: string[];
  recurringFrustrations: string[];
  impliedNeeds: string[];
  lastUpdated: string;
}

/** Load the user model. */
export function loadUserModel(soulName: string = "capix-code"): UserModel {
  const path = join(memoryBase(soulName), "user-model.json");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as UserModel;
    } catch {
      // Fall through
    }
  }
  return {
    created: new Date().toISOString(),
    statedGoals: [],
    observedPatterns: [],
    recurringFrustrations: [],
    impliedNeeds: [],
    lastUpdated: new Date().toISOString(),
  };
}

/** Save the user model. */
export function saveUserModel(model: UserModel, soulName: string = "capix-code"): void {
  const dir = memoryBase(soulName);
  ensureDir(dir);
  const path = join(dir, "user-model.json");
  model.lastUpdated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(model, null, 2), { mode: 0o600 });
}

/** Add an observed pattern to the user model. */
export function recordUserPattern(pattern: string, soulName: string = "capix-code"): void {
  const model = loadUserModel(soulName);
  if (!model.observedPatterns.includes(pattern)) {
    model.observedPatterns.push(pattern);
    saveUserModel(model, soulName);
  }
}

/** Record a user frustration. */
export function recordUserFrustration(frustration: string, soulName: string = "capix-code"): void {
  const model = loadUserModel(soulName);
  if (!model.recurringFrustrations.includes(frustration)) {
    model.recurringFrustrations.push(frustration);
    saveUserModel(model, soulName);
  }
}
