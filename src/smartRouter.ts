/**
 * Capix Smart Router with Covenant Memory
 *
 * Instead of fetching the model catalog + classifying from scratch every
 * time, this router maintains persistent memory across sessions:
 *
 * - SHORT-TERM memory: the live catalog (cached for 5 min), the last
 *   classification result per session (cached for 1 min), and the currently
 *   active private endpoint. This avoids redundant API calls within a session.
 *
 * - LONG-TERM memory (Covenant): learned model preferences, which models
 *   performed well for which task types, user corrections ("don't use
 *   model X, it's slow"), and patterns observed across sessions. This is
 *   persisted to ~/.config/capix-code/smart-router-memory.json and loaded
 *   on startup — so every time the router is spawned, it already knows
 *   what it learned before.
 *
 * The router evolves: if a user manually overrides its choice and picks
 * a different model, it remembers that correction and adjusts future
 * routing for similar tasks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { logger } from "./logger";

// ── Types ──────────────────────────────────────────────────────────────────

export type TaskType = "reasoning" | "coding";
export type RouteMode = "auto" | "private" | "loop";

export interface RouteResult {
  mode: RouteMode;
  model: string;
  taskType: TaskType;
  fromCache: boolean;
  privateEndpoint?: {
    baseUrl: string;
    apiKey: string;
    instanceId: number;
    modelLabel: string;
  };
}

interface LiveModel {
  id: string;
  model: string;
  pricePer1k: number;
  provider: string;
}

// ── Long-term memory (persisted to disk) ──────────────────────────────────

interface ModelRating {
  /** How well this model performed for this task type (user-adjusted). */
  score: number;
  /** Times it was selected. */
  selections: number;
  /** Times the user overrode it (picked a different model). */
  overrides: number;
  /** Last selected timestamp. */
  lastUsed?: string;
}

interface SmartRouterMemory {
  /** Learned ratings per model per task type. */
  ratings: Record<string, Record<TaskType, ModelRating>>;
  /** Models the user has blocked (don't route to these). */
  blockedModels: string[];
  /** Models the user has favored (always prefer these). */
  favoredModels: string[];
  /** User's preferred provider (if any). */
  preferredProvider?: string;
  /** Last known private endpoint (so we can reconnect on restart). */
  lastPrivateEndpoint?: { baseUrl: string; instanceId: number; modelLabel: string };
  /** Timestamp of last memory update. */
  updatedAt: string;
}

// ── Memory storage ────────────────────────────────────────────────────────

// TODO(security): Auth credentials (CAPIX_API_KEY) are currently passed as
// env vars or stored in the upstream opencode's plaintext JSON auth store.
// These should be migrated to the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service / libsecret) so secrets are
// never written to disk in plaintext. This requires changes to the upstream
// auth store internals and is tracked as a separate larger task.

function getConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "capix-code");
    case "win32":
      return join(homedir(), "AppData", "Roaming", "capix-code");
    default:
      return join(homedir(), ".config", "capix-code");
  }
}

const MEMORY_FILE = join(getConfigDir(), "smart-router-memory.json");

function loadMemory(): SmartRouterMemory {
  try {
    if (!existsSync(MEMORY_FILE)) return blankMemory();
    const raw = readFileSync(MEMORY_FILE, "utf-8");
    const m = JSON.parse(raw) as SmartRouterMemory;
    return m;
  } catch (err) {
    logger.error("loadMemory failed — using blank memory", { error: String(err) });
    return blankMemory();
  }
}

function saveMemory(mem: SmartRouterMemory): void {
  try {
    mkdirSync(dirname(MEMORY_FILE), { recursive: true });
    mem.updatedAt = new Date().toISOString();
    writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
  } catch (err) {
    logger.error("saveMemory failed — cannot persist router memory", { error: String(err) });
  }
}

function blankMemory(): SmartRouterMemory {
  return {
    ratings: {},
    blockedModels: [],
    favoredModels: [],
    updatedAt: new Date().toISOString(),
  };
}

// ── The router (stateful, born with memory) ────────────────────────────────

export class SmartRouter {
  private memory: SmartRouterMemory;
  private catalogCache: { models: LiveModel[]; at: number } | null = null;
  private classCache = new Map<string, { type: TaskType; at: number }>();
  private activePrivateEndpoint?: {
    baseUrl: string;
    apiKey: string;
    instanceId: number;
    modelLabel: string;
  };

  // Catalog cache TTL + classification cache TTL
  private static CATALOG_TTL_MS = 5 * 60 * 1000;
  private static CLASS_CACHE_TTL_MS = 60_000;

  // The classifier always goes to the Capix gateway — never the user's
  // self-hosted baseUrl. This ensures classification works even when the
  // user points CAPIX_BASE_URL at a private instance with no classifier model.
  private static CAPIX_GATEWAY = "https://capix.network/api/v1";

  /**
   * Born with memory — loads persisted state from disk on construction.
   * Every time the router is spawned, it already knows what it learned
   * in previous sessions.
   */
  constructor() {
    this.memory = loadMemory();
    // Reconnect to the last private endpoint if one was active.
    if (this.memory.lastPrivateEndpoint) {
      // The API key isn't persisted for security — the caller must re-supply it.
      // But we remember the endpoint URL + instance ID so we can check if it's still alive.
    }
  }

  // ── Catalog fetching ─────────────────────────────────────────────────────

  private async fetchCatalog(baseUrl: string, apiKey: string): Promise<LiveModel[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < SmartRouter.CATALOG_TTL_MS) {
      const cached = this.catalogCache.models;
      logger.info("Catalog served from cache", { source: baseUrl, count: cached.length });
      return cached;
    }

    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/api/cloud/trading-board`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json();
      const listings = (data?.listings || []) as Array<{
        model: string;
        provider: string;
        spotPrice: number;
        status: string;
      }>;

      const models: LiveModel[] = listings
        .filter((l) => l.status === "live")
        .map((l) => ({
          id: l.model,
          model: l.model,
          pricePer1k: l.spotPrice,
          provider: l.provider,
        }));

      this.catalogCache = { models, at: Date.now() };
      const durationMs = Date.now() - start;
      logger.info("Catalog fetched", { source: baseUrl, count: models.length, durationMs });
      return models;
    } catch (err) {
      const durationMs = Date.now() - start;
      const fallback = this.catalogCache?.models || [];
      logger.error("fetchCatalog failed — using cached/empty fallback", {
        source: baseUrl,
        durationMs,
        cachedCount: fallback.length,
        error: String(err),
      });
      return fallback;
    }
  }

  // ── Task classification ──────────────────────────────────────────────────

  private static CLASSIFIER_MODEL = "capix/supergemma-gemma3-4b";
  private static CLASSIFY_PROMPT = `You are a task classifier. Read the user's request and respond with exactly one word: "reasoning" or "coding".

- "reasoning" = planning, architecture, debugging, analysis, explaining concepts, answering questions, writing docs, reviewing code
- "coding" = writing new code, editing existing code, fixing bugs in code, refactoring, implementing features, generating files
- "reasoning" if ambiguous.

Only respond with one word. No punctuation.`;

  private async classify(
    message: string,
    sessionId: string | undefined,
    apiKey: string,
  ): Promise<TaskType> {
    if (sessionId) {
      const cached = this.classCache.get(sessionId);
      if (cached && Date.now() - cached.at < SmartRouter.CLASS_CACHE_TTL_MS) {
        logger.info("Classification served from cache", {
          sessionId,
          taskType: cached.type,
        });
        return cached.type;
      }
    }

    const start = Date.now();
    const promptPreview = message.slice(0, 100);
    try {
      const res = await fetch(`${SmartRouter.CAPIX_GATEWAY}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: SmartRouter.CLASSIFIER_MODEL,
          messages: [
            { role: "system", content: SmartRouter.CLASSIFY_PROMPT },
            { role: "user", content: message.slice(0, 500) },
          ],
          max_tokens: 5,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(3000),
      });

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.toLowerCase().trim() || "";
      const type: TaskType = text.includes("reason") ? "reasoning" : "coding";

      const durationMs = Date.now() - start;
      logger.info("Task classified", { taskType: type, promptPreview, durationMs });

      if (sessionId) this.classCache.set(sessionId, { type, at: Date.now() });
      return type;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.warn("classify failed — defaulting to coding", {
        promptPreview,
        durationMs,
        error: String(err),
      });
      return "coding";
    }
  }

  // ── Model selection (memory-informed) ────────────────────────────────────

  private static REASONING_KEYWORDS = [
    "r1", "reasoning", "thinking", "o1", "o3", "pro", "sonnet", "opus",
    "gemini-2.5", "gpt-4o", "claude", "deepseek-r1",
    "llama", "gemma", "supergemma",
  ];
  private static CODING_KEYWORDS = [
    "coder", "code", "coding", "deepseek-coder", "qwen2.5-coder",
    "codellama", "starcoder", "codegemma",
  ];

  /**
   * Pick the best model for a task type, informed by long-term memory.
   *
   * The selection considers:
   * 1. Keyword matching (does the model name suggest it's good at this task?)
   * 2. Price (cheaper is better, all else equal)
   * 3. **Learned ratings** (from memory — models the user has kept vs overridden)
   * 4. **Blocked models** (user explicitly said "don't use this one")
   * 5. **Favored models** (user explicitly preferred these)
   */
  pickBestModel(models: LiveModel[], taskType: TaskType): string | null {
    if (models.length === 0) {
      const fallback = taskType === "reasoning" ? "capix/supergemma-gemma3-27b" : "capix/supergemma-gemma3-4b";
      logger.info("Catalog empty — using fallback", { taskType, fallback });
      return fallback;
    }

    const keywords =
      taskType === "reasoning" ? SmartRouter.REASONING_KEYWORDS : SmartRouter.CODING_KEYWORDS;

    const scored = models
      .map((m) => {
        const lower = m.model.toLowerCase();

        // Skip blocked models.
        if (this.memory.blockedModels.includes(m.model)) return null;

        let score = 0;

        // Keyword matching.
        for (const kw of keywords) {
          if (lower.includes(kw)) score += 2;
        }

        // Learned ratings from memory.
        const rating = this.memory.ratings[m.model]?.[taskType];
        if (rating) {
          // High score = user kept this model's selection (= good choice).
          // High overrides = user rejected this model for this task (= bad choice).
          const netScore = rating.selections - rating.overrides * 2;
          score += netScore * 0.5;
        }

        // Favored models get a boost.
        if (this.memory.favoredModels.includes(m.model)) score += 3;

        // Preferred provider boost.
        if (this.memory.preferredProvider && m.provider === this.memory.preferredProvider)
          score += 1;

        // Price penalty.
        if (m.pricePer1k > 0.01) score -= 1;
        if (m.pricePer1k > 0.05) score -= 2;

        return { model: m.model, score, price: m.pricePer1k };
      })
      .filter(Boolean) as Array<{ model: string; score: number; price: number }>;

    if (scored.length === 0) {
      const fallback =
        taskType === "reasoning" ? "capix/supergemma-gemma3-27b" : "capix/supergemma-gemma3-4b";
      logger.info("All models blocked — using fallback", { taskType, fallback });
      return fallback;
    }

    // Sort: highest score first, then cheapest.
    scored.sort((a, b) => b.score - a.score || a.price - b.price);

    const best = scored[0].model;
    logger.info("Model selected", { model: best, taskType, score: scored[0].score });
    return best;
  }

  // ── Public routing API ───────────────────────────────────────────────────

  /**
   * Route in AUTO mode — dynamically picks the best model from the live
   * catalog, informed by long-term memory.
   */
  async routeAuto(
    message: string,
    sessionId: string | undefined,
    baseUrl: string,
    apiKey: string,
  ): Promise<RouteResult> {
    const start = Date.now();
    const [catalog, taskType] = await Promise.all([
      this.fetchCatalog(baseUrl, apiKey),
      this.classify(message, sessionId, apiKey),
    ]);

    const best = this.pickBestModel(catalog, taskType);
    const fallback =
      taskType === "reasoning" ? "capix/supergemma-gemma3-27b" : "capix/supergemma-gemma3-4b";

    // Record the selection in memory (for learning).
    if (best) {
      this.recordSelection(best, taskType);
    }

    const fromCache = Boolean(
      this.catalogCache && Date.now() - this.catalogCache.at < SmartRouter.CATALOG_TTL_MS,
    );
    const model = best || fallback;
    const durationMs = Date.now() - start;

    logger.info("Route decision", {
      mode: "auto",
      model,
      taskType,
      fromCache,
      catalogCount: catalog.length,
      durationMs,
    });

    return { mode: "auto", model, taskType, fromCache };
  }

  /**
   * Route in PRIVATE mode — use the deployed private LLM.
   * If none exists, signal that one needs to be deployed.
   */
  routePrivate(): RouteResult {
    const start = Date.now();
    if (this.activePrivateEndpoint) {
      const result: RouteResult = {
        mode: "private",
        model: this.activePrivateEndpoint.modelLabel,
        taskType: "coding",
        fromCache: true,
        privateEndpoint: this.activePrivateEndpoint,
      };
      logger.info("Route decision", {
        mode: "private",
        model: result.model,
        taskType: result.taskType,
        fromCache: true,
        durationMs: Date.now() - start,
      });
      return result;
    }
    logger.info("Route decision", {
      mode: "private",
      model: "__NEEDS_DEPLOY__",
      taskType: "coding",
      fromCache: false,
      durationMs: Date.now() - start,
    });
    return { mode: "private", model: "__NEEDS_DEPLOY__", taskType: "coding", fromCache: false };
  }

  /**
   * Route in LOOP mode — same as PRIVATE but the agent keeps building.
   */
  routeLoop(): RouteResult {
    const start = Date.now();
    const result = this.routePrivate();
    result.mode = "loop";
    logger.info("Route decision", {
      mode: "loop",
      model: result.model,
      taskType: result.taskType,
      fromCache: result.fromCache,
      durationMs: Date.now() - start,
    });
    return result;
  }

  // ── Private endpoint lifecycle ───────────────────────────────────────────

  /** Called when a private LLM is deployed — registers it as the active endpoint. */
  setPrivateEndpoint(endpoint: {
    baseUrl: string;
    apiKey: string;
    instanceId: number;
    modelLabel: string;
  }): void {
    this.activePrivateEndpoint = endpoint;
    this.memory.lastPrivateEndpoint = {
      baseUrl: endpoint.baseUrl,
      instanceId: endpoint.instanceId,
      modelLabel: endpoint.modelLabel,
    };
    saveMemory(this.memory);
  }

  /** Called when the private LLM is destroyed — clears the active endpoint. */
  clearPrivateEndpoint(): void {
    this.activePrivateEndpoint = undefined;
    this.memory.lastPrivateEndpoint = undefined;
    saveMemory(this.memory);
  }

  /** Check if a private endpoint is currently active. */
  hasPrivateEndpoint(): boolean {
    return Boolean(this.activePrivateEndpoint);
  }

  /** Get the active private endpoint (if any). */
  getPrivateEndpoint() {
    return this.activePrivateEndpoint;
  }

  // ── Learning (memory updates) ────────────────────────────────────────────

  /**
   * Record that a model was selected for a task type.
   * Called automatically after each routing decision.
   */
  private recordSelection(model: string, taskType: TaskType): void {
    if (!this.memory.ratings[model])
      this.memory.ratings[model] = {
        reasoning: { score: 0, selections: 0, overrides: 0 },
        coding: { score: 0, selections: 0, overrides: 0 },
      };
    this.memory.ratings[model][taskType].selections++;
    this.memory.ratings[model][taskType].lastUsed = new Date().toISOString();
    saveMemory(this.memory);
  }

  /**
   * Record a user override — the user picked a different model than the
   * router suggested. The router learns from this.
   *
   * @param rejectedModel — the model the router suggested
   * @param chosenModel — the model the user actually picked
   * @param taskType — the task type
   */
  recordOverride(rejectedModel: string, chosenModel: string, taskType: TaskType): void {
    // Penalize the rejected model.
    if (!this.memory.ratings[rejectedModel])
      this.memory.ratings[rejectedModel] = {
        reasoning: { score: 0, selections: 0, overrides: 0 },
        coding: { score: 0, selections: 0, overrides: 0 },
      };
    this.memory.ratings[rejectedModel][taskType].overrides++;

    // Boost the chosen model.
    if (!this.memory.ratings[chosenModel])
      this.memory.ratings[chosenModel] = {
        reasoning: { score: 0, selections: 0, overrides: 0 },
        coding: { score: 0, selections: 0, overrides: 0 },
      };
    this.memory.ratings[chosenModel][taskType].selections++;

    saveMemory(this.memory);
  }

  /**
   * Block a model — the user said "never use this model again."
   */
  blockModel(model: string): void {
    if (!this.memory.blockedModels.includes(model)) {
      this.memory.blockedModels.push(model);
      saveMemory(this.memory);
    }
  }

  /**
   * Favor a model — the user said "always prefer this model."
   */
  favorModel(model: string): void {
    if (!this.memory.favoredModels.includes(model)) {
      this.memory.favoredModels.push(model);
      saveMemory(this.memory);
    }
  }

  /**
   * Set the preferred provider (e.g. "Surplus Intelligence" or "OpenRouter").
   */
  setPreferredProvider(provider: string): void {
    this.memory.preferredProvider = provider;
    saveMemory(this.memory);
  }

  // ── Memory inspection (for the TUI / status display) ────────────────────

  getMemoryState(): Readonly<SmartRouterMemory> {
    return this.memory;
  }

  /**
   * Get a human-readable summary of what the router has learned.
   */
  getMemorySummary(): string {
    const m = this.memory;
    const topModels = Object.entries(m.ratings)
      .sort(([, a], [, b]) => {
        const aScore =
          a.coding.selections - a.coding.overrides * 2 + (a.reasoning.selections - a.reasoning.overrides * 2);
        const bScore =
          b.coding.selections - b.coding.overrides * 2 + (b.reasoning.selections - b.reasoning.overrides * 2);
        return bScore - aScore;
      })
      .slice(0, 5)
      .map(
        ([model, r]) =>
          `  ${model}: coding ${r.coding.selections}× (${r.coding.overrides} overrides), reasoning ${r.reasoning.selections}× (${r.reasoning.overrides} overrides)`,
      );

    const lines = [
      "Smart Router Memory:",
      `  Blocked: ${m.blockedModels.length > 0 ? m.blockedModels.join(", ") : "none"}`,
      `  Favored: ${m.favoredModels.length > 0 ? m.favoredModels.join(", ") : "none"}`,
      `  Preferred provider: ${m.preferredProvider || "none"}`,
      `  Private endpoint: ${m.lastPrivateEndpoint ? m.lastPrivateEndpoint.modelLabel : "none"}`,
      `  Top models:`,
      ...topModels,
    ];
    return lines.join("\n");
  }

  /**
   * Reset all memory (the user said "forget everything").
   */
  resetMemory(): void {
    this.memory = blankMemory();
    this.catalogCache = null;
    this.classCache.clear();
    this.activePrivateEndpoint = undefined;
    saveMemory(this.memory);
  }
}
