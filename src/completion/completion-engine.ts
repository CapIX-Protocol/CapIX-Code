/**
 * Capix completion engine — debounced, cached, context-aware code completion.
 *
 * This module mirrors the patterns of `capix-provider.ts` and
 * `routing-client.ts`:
 *  - talks ONLY to the local CredentialBroker (via the provider/routing
 *    clients; never holds a token itself);
 *  - routes every request through the smart router — model selection is
 *    server-authoritative (`capix/auto` fallback), with the managed catalog
 *    (GET /models) used to prefer a code-capable model when available;
 *  - never classifies code, scores models itself beyond the catalog's own
 *    capability/price metadata, or retains router memory.
 *
 * What this module deliberately does NOT do:
 *  - spawn its own inference endpoint or embed a base URL;
 *  - cache beyond a short in-memory TTL (no cross-session persistence);
 *  - send secrets — context contains only file text, paths, and edit
 *    summaries the caller explicitly provides.
 */

import { createHash } from 'node:crypto';

import { logger } from '../logger.js';
import { stream, type CapixClientMeta } from '../capix-provider.js';
import { listManagedModels, type ManagedModel } from '../routing-client.js';

/** Server-authoritative router target; the gateway picks the model. */
export const FALLBACK_MODEL = 'capix/auto';

/** Catalog capabilities that mark a model as code-completion capable. */
const CODE_CAPABILITIES = new Set(['code', 'completion', 'fim', 'fill-in-the-middle', 'coding']);

/** Map a file extension onto the language name models recognize. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sql: 'sql',
};

// ── Context types ───────────────────────────────────────────────────────────

/** A related project file included as completion context (already bounded). */
export interface ProjectSnippet {
  path: string;
  content: string;
}

/** A recent edit, described as a short human/model-readable summary. */
export interface RecentEdit {
  path: string;
  summary: string;
}

/** Everything the engine needs to produce one completion. */
export interface CompletionContext {
  filePath: string;
  language: string;
  /** Code before the cursor (bounded to `prefixChars`). */
  prefix: string;
  /** Code after the cursor (bounded to `suffixChars`). */
  suffix: string;
  cursorLine: number;
  cursorColumn: number;
  projectSnippets: ProjectSnippet[];
  recentEdits: RecentEdit[];
}

/** Raw editor input the context builder consumes. */
export interface CompletionInput {
  filePath: string;
  content: string;
  /** Cursor position as a character offset into `content`. */
  cursorOffset: number;
  projectSnippets?: ProjectSnippet[];
  recentEdits?: RecentEdit[];
}

export interface CompletionResult {
  /** Suggested code, may span multiple lines. Inserted at the cursor. */
  text: string;
  /** Model the router served (or `capix/auto` when the router chose). */
  model: string;
  fromCache: boolean;
  receiptId?: string;
  usage?: { input: number; output: number };
}

export interface CompletionEngineOptions {
  /** Client/release metadata attached to every inference request. */
  meta: CapixClientMeta;
  /** Debounce window for `schedule` (ms). Default 300. */
  debounceMs?: number;
  /** Cache entry TTL (ms). Default 60_000. */
  cacheTtlMs?: number;
  /** Max cache entries (LRU). Default 100. */
  cacheMaxEntries?: number;
  /** Max chars of prefix sent as context. Default 4000. */
  prefixChars?: number;
  /** Max chars of suffix sent as context. Default 1000. */
  suffixChars?: number;
  /** Max output tokens per completion. Default 256. */
  maxTokens?: number;
  /** Max lines in a returned completion. Default 12. */
  maxLines?: number;
  /** How long a catalog model selection stays valid (ms). Default 300_000. */
  modelCacheTtlMs?: number;
  /** Explicit model override; skips smart-router selection. Tests/dev only. */
  model?: string;
}

// ── Context building ────────────────────────────────────────────────────────

/** Detect the language name from a file path's extension. */
export function detectLanguage(filePath: string): string {
  const name = filePath.split('/').pop() ?? '';
  if (name === 'Dockerfile') return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'text';
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'text';
}

/**
 * Build a bounded completion context from raw editor state. The prefix keeps
 * the tail of the document (closest code matters most); the suffix keeps the
 * head. Project snippets and recent edits pass through (callers bound them).
 */
export function buildCompletionContext(
  input: CompletionInput,
  opts: { prefixChars?: number; suffixChars?: number } = {}
): CompletionContext {
  const prefixChars = opts.prefixChars ?? 4000;
  const suffixChars = opts.suffixChars ?? 1000;
  const offset = Math.max(0, Math.min(input.cursorOffset, input.content.length));
  const prefixFull = input.content.slice(0, offset);
  const suffixFull = input.content.slice(offset);
  const prefix = prefixFull.length > prefixChars ? prefixFull.slice(-prefixChars) : prefixFull;
  const suffix = suffixFull.length > suffixChars ? suffixFull.slice(0, suffixChars) : suffixFull;
  const beforeCursor = prefixFull.split('\n');
  return {
    filePath: input.filePath,
    language: detectLanguage(input.filePath),
    prefix,
    suffix,
    cursorLine: beforeCursor.length,
    cursorColumn: beforeCursor[beforeCursor.length - 1]?.length ?? 0,
    projectSnippets: input.projectSnippets ?? [],
    recentEdits: input.recentEdits ?? [],
  };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a code completion engine embedded in an editor.',
  'Output ONLY the code that belongs at the <CURSOR> marker — nothing before it, nothing after it.',
  'Do not repeat code that already appears before <CURSOR>.',
  'Do not wrap the answer in markdown fences, explanations, or commentary.',
  'Match the surrounding style: indentation, naming, quoting, and idioms.',
  'The completion may span multiple lines when the context calls for it.',
  'If no sensible completion exists, output nothing.',
].join(' ');

/** Build chat messages for one completion request. */
export function buildCompletionMessages(
  context: CompletionContext
): Array<{ role: string; content: string }> {
  const sections: string[] = [];

  for (const edit of context.recentEdits.slice(-5)) {
    sections.push(`<recent-edit path="${edit.path}">\n${edit.summary}\n</recent-edit>`);
  }
  for (const snippet of context.projectSnippets.slice(0, 4)) {
    sections.push(`<related-file path="${snippet.path}">\n${snippet.content}\n</related-file>`);
  }
  sections.push(
    `<file path="${context.filePath}" language="${context.language}" cursor-line="${context.cursorLine}">\n` +
      `${context.prefix}<CURSOR>${context.suffix}\n</file>`
  );

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

// ── Post-processing ─────────────────────────────────────────────────────────

/** Compare two string-encoded integer minor-unit amounts. */
function compareMinor(a: string, b: string): number {
  const ai = BigInt(a || '0');
  const bi = BigInt(b || '0');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Clean raw model output into insertable text: strip markdown fences, drop a
 * prefix echo, bound the line count, and reject empty/garbage output.
 */
export function postProcessCompletion(
  raw: string,
  context: CompletionContext,
  maxLines: number
): string | null {
  let text = raw;

  // Strip a single markdown fence wrapper if the model ignored the system prompt.
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1] ?? '';

  // Drop an echoed prefix tail (models sometimes re-emit the line before the cursor).
  const tail = context.prefix.slice(-120);
  if (tail.trim().length > 0) {
    const matchLen = longestSuffixPrefixOverlap(tail, text);
    if (matchLen > 0) text = text.slice(matchLen);
  }

  // Bound multi-line completions; drop trailing blank lines.
  const lines = text.split('\n').slice(0, maxLines);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  text = lines.join('\n');

  if (text.trim().length === 0) return null;
  return text;
}

/** Length of the longest string that is both a suffix of `a` and a prefix of `b`. */
function longestSuffixPrefixOverlap(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let len = max; len >= 8; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}

// ── Engine ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  model: string;
  receiptId?: string;
  usage?: { input: number; output: number };
  expiresAt: number;
}

/**
 * Debounced, cached completion engine. One instance serves a session; the
 * inline-completion layer drives it via `schedule` on each keystroke.
 */
export class CompletionEngine {
  private readonly opts: Required<Omit<CompletionEngineOptions, 'model'>> & { model?: string };
  private readonly cache = new Map<string, CacheEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAbort: AbortController | null = null;
  private pendingResolve: ((result: CompletionResult | null) => void) | null = null;
  private requestSeq = 0;
  private cachedModel: { model: string; expiresAt: number } | null = null;

  constructor(options: CompletionEngineOptions) {
    this.opts = {
      meta: options.meta,
      debounceMs: options.debounceMs ?? 300,
      cacheTtlMs: options.cacheTtlMs ?? 60_000,
      cacheMaxEntries: options.cacheMaxEntries ?? 100,
      prefixChars: options.prefixChars ?? 4000,
      suffixChars: options.suffixChars ?? 1000,
      maxTokens: options.maxTokens ?? 256,
      maxLines: options.maxLines ?? 12,
      modelCacheTtlMs: options.modelCacheTtlMs ?? 300_000,
      model: options.model,
    };
  }

  /**
   * Debounced completion entry point. Successive calls supersede earlier ones
   * (the superseded promise resolves `null` and its request is aborted), so
   * only the last keystroke within the debounce window hits the network.
   */
  schedule(context: CompletionContext): Promise<CompletionResult | null> {
    this.requestSeq += 1;
    const seq = this.requestSeq;
    this.pendingAbort?.abort();
    // Superseded callers must not hang: resolve their promise with `null`.
    this.pendingResolve?.(null);
    const controller = new AbortController();
    this.pendingAbort = controller;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.debounceTimer = setTimeout(() => {
        void (async (): Promise<void> => {
          if (seq !== this.requestSeq) return resolve(null);
          try {
            const result = await this.complete(context, { signal: controller.signal });
            resolve(seq === this.requestSeq ? result : null);
          } catch (err) {
            if (!controller.signal.aborted) {
              logger.warn('completion-engine: request failed', { error: String(err) });
            }
            resolve(null);
          }
        })();
      }, this.opts.debounceMs);
    });
  }

  /** Cancel any pending debounced request (e.g. on Escape or blur). */
  cancelPending(): void {
    this.requestSeq += 1;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.pendingAbort?.abort();
    this.pendingAbort = null;
    this.pendingResolve?.(null);
    this.pendingResolve = null;
  }

  /**
   * Immediate completion (no debounce). Serves from the LRU cache when the
   * same context was completed within the TTL; otherwise runs a streaming
   * inference request through the smart router.
   */
  async complete(
    context: CompletionContext,
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<CompletionResult | null> {
    const key = this.cacheKey(context);
    const cached = this.cacheGet(key);
    if (cached) {
      return {
        text: cached.text,
        model: cached.model,
        fromCache: true,
        receiptId: cached.receiptId,
        usage: cached.usage,
      };
    }

    const model = await this.resolveModel(signal);
    const messages = buildCompletionMessages(context);
    let text = '';
    let receiptId: string | undefined;
    let usage: { input: number; output: number } | undefined;

    for await (const chunk of stream(
      { model, messages },
      {
        meta: this.opts.meta,
        signal,
        maxTokens: this.opts.maxTokens,
        temperature: 0.2,
      }
    )) {
      if (signal?.aborted) return null;
      if (chunk.type === 'text') text += chunk.delta;
      else if (chunk.type === 'usage') usage = { input: chunk.input, output: chunk.output };
      else if (chunk.type === 'finish') receiptId = chunk.receiptId;
      else if (chunk.type === 'error') throw new Error(`completion failed: ${chunk.message}`);
    }

    const cleaned = postProcessCompletion(text, context, this.opts.maxLines);
    if (!cleaned) return null;

    this.cacheSet(key, {
      text: cleaned,
      model,
      receiptId,
      usage,
      expiresAt: Date.now() + this.opts.cacheTtlMs,
    });
    return { text: cleaned, model, fromCache: false, receiptId, usage };
  }

  /**
   * Smart-router model selection. Asks the managed catalog (GET /models) for
   * a public, code-capable model and picks the cheapest by input price; the
   * gateway still does placement scoring. Falls back to `capix/auto` — fully
   * server-authoritative — when the catalog is unavailable or has no match.
   */
  private async resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.opts.model) return this.opts.model;
    if (this.cachedModel && this.cachedModel.expiresAt > Date.now()) {
      return this.cachedModel.model;
    }
    let model = FALLBACK_MODEL;
    try {
      const catalog = await listManagedModels({ signal });
      const selected = pickCompletionModel(catalog);
      if (selected) model = selected;
    } catch (err) {
      logger.warn('completion-engine: model catalog unavailable, using capix/auto', {
        error: String(err),
      });
    }
    this.cachedModel = { model, expiresAt: Date.now() + this.opts.modelCacheTtlMs };
    return model;
  }

  private cacheKey(context: CompletionContext): string {
    const hash = createHash('sha256');
    hash.update(context.language);
    hash.update('');
    hash.update(context.filePath);
    hash.update('');
    hash.update(context.prefix.slice(-this.opts.prefixChars));
    hash.update('<CURSOR>');
    hash.update(context.suffix.slice(0, this.opts.suffixChars));
    return hash.digest('hex');
  }

  private cacheGet(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    // LRU touch.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    while (this.cache.size > this.opts.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/**
 * Pick a completion model from the managed catalog: public models only,
 * code-capable preferred, cheapest input price wins. Returns `null` when the
 * catalog has no usable entry (caller falls back to `capix/auto`).
 */
export function pickCompletionModel(catalog: ManagedModel[]): string | null {
  const usable = catalog.filter((m) => m.visibility === 'public');
  if (usable.length === 0) return null;
  const codeCapable = usable.filter((m) =>
    m.capabilities.some((c) => CODE_CAPABILITIES.has(c.toLowerCase()))
  );
  const pool = codeCapable.length > 0 ? codeCapable : usable;
  const sorted = [...pool].sort((a, b) =>
    compareMinor(a.pricePerInputToken.amountMinor, b.pricePerInputToken.amountMinor)
  );
  return sorted[0]?.modelId ?? null;
}
