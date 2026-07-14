/**
 * Context retriever — figures out which files and symbols are relevant for a
 * given request, within a token budget.
 *
 * No ML embeddings (those live server-side with pgvector). The local retriever
 * uses plain-text pattern matching: exact word match, file path matching,
 * symbol name matching, and import-graph traversal.
 *
 * Refs:
 * - architecture §12.3 (agent brain: codebase context retrieval)
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, basename, dirname, sep } from 'node:path';
import type { CodebaseIndexer, SymbolNode, FileIndex, CodebaseIndex } from './indexer.js';

export interface RetrievedFile {
  path: string;
  content: string;
  reason: string; // "contains the function you asked about"
  score: number; // relevance score 0-1
  lines?: { start: number; end: number };
}

export interface RetrievedSymbol {
  name: string;
  type: string;
  filePath: string;
  line: number;
  reason: string;
}

export interface RetrievalSource {
  type: 'semantic' | 'exact' | 'import-graph' | 'symbol-graph' | 'recent-edit' | 'active-file';
  query: string;
  matched: string[];
}

export interface RetrievalResult {
  files: RetrievedFile[];
  symbols: RetrievedSymbol[];
  totalTokens: number;
  sources: RetrievalSource[];
}

interface RetrieveOptions {
  activeFile?: string;
  selection?: string;
  recentEdits?: string[];
  maxTokens?: number; // default 4000
}

const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const CANDIDATE_READ_LIMIT = 40; // max files whose content we read per retrieval
const IMPORT_EXPANSION_SEEDS = 8;
const IMPORT_EXPANSION_DECAY = 0.3;
const ACTIVE_FILE_BOOST = 2.0;
const RECENT_EDIT_BOOST = 1.5;
const RECENT_EDIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SLICE_WINDOW_LINES = 80; // ± lines around best matching region

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'that', 'this', 'from', 'into',
  'how', 'what', 'where', 'why', 'who', 'are', 'can', 'you', 'please', 'find',
  'show', 'get', 'list', 'use', 'using', 'about', 'have', 'has', 'was', 'were',
  'function', 'class', 'method', 'variable', 'file', 'code', 'my', 'our', 'is',
  'in', 'of', 'to', 'on', 'it', 'do', 'does', 'did', 'me', 'i', 'we',
]);

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract a set of query tokens. Keeps whole words, camelCase sub-parts, and
 * the joined identifier form so that "authorizeHold" matches both the literal
 * string and the symbol name, while "authorize hold" matches the same symbol.
 */
function extractTokens(text: string): string[] {
  const set = new Set<string>();
  if (!text) return [];
  // whole words (split on non-identifier)
  for (const w of text.toLowerCase().split(/[^a-z0-9_$]+/i)) {
    if (w.length >= 2 && !STOP_WORDS.has(w)) set.add(w);
  }
  // identifier sub-parts (camelCase / snake_case)
  for (const w of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const lower = w.toLowerCase();
    if (!STOP_WORDS.has(lower) && lower.length >= 2) set.add(lower);
    for (const part of w.split(/(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !STOP_WORDS.has(p)) set.add(p);
    }
    for (const part of w.split('_')) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !STOP_WORDS.has(p)) set.add(p);
    }
  }
  return [...set];
}

/** Does a candidate (lowercased) match any token exactly or by substring? */
function tokenMatchScore(tokens: string[], candidateLower: string): number {
  let score = 0;
  for (const t of tokens) {
    if (candidateLower === t) score += 1;
    else if (t.length >= 3 && candidateLower.includes(t)) score += 0.5;
    else if (t.length >= 4 && t.includes(candidateLower) && candidateLower.length >= 3) score += 0.3;
  }
  return score;
}

function nowMs(): number {
  return Date.now();
}

// ── ContextRetriever ────────────────────────────────────────────────────────

export class ContextRetriever {
  private readonly indexer: CodebaseIndexer;
  private orientationCache: { value: string; indexUpdatedAt: number } | null = null;

  constructor(indexer: CodebaseIndexer) {
    this.indexer = indexer;
  }

  /**
   * Retrieve context for a user request.
   *
   * Phases:
   *  1. Score every indexed file by path + symbol name (no disk reads).
   *  2. Read content of the top candidates and score by exact word match.
   *  3. Expand high-scoring files along the import graph (decayed boost).
   *  4. Apply active-file / recent-edit boosts.
   *  5. Sort, truncate to the token budget.
   */
  async retrieve(request: string, options?: RetrieveOptions): Promise<RetrievalResult> {
    const index = this.indexer.getIndex();
    if (!index) {
      return { files: [], symbols: [], totalTokens: 0, sources: [] };
    }

    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const tokens = extractTokens((request ?? '') + ' ' + (options?.selection ?? ''));

    if (tokens.length === 0) {
      return { files: [], symbols: [], totalTokens: 0, sources: [] };
    }

    const rootPath = index.rootPath;
    const activeFileAbs = options?.activeFile
      ? resolve(rootPath, options.activeFile)
      : undefined;
    const recentEditsAbs = new Set(
      (options?.recentEdits ?? []).map((p) => resolve(rootPath, p))
    );

    const sources: RetrievalSource[] = [];
    const exactMatched: string[] = [];
    const symbolMatchedFiles: string[] = [];
    const matchedSymbolNames: string[] = [];

    // ── Phase 1: cheap scoring (path + symbols) ──
    type Cand = {
      path: string;
      score: number;
      reasons: string[];
      contentRead: boolean;
      contentScore: number;
    };
    const candidates: Cand[] = [];
    for (const fi of index.files.values()) {
      let score = 0;
      const reasons: string[] = [];
      const relPath = relative(rootPath, fi.path).toLowerCase();

      const pScore = tokenMatchScore(tokens, relPath);
      if (pScore > 0) {
        score += pScore * 0.4;
        reasons.push('path match');
      }

      let symHit = false;
      for (const s of fi.symbols) {
        const sScore = tokenMatchScore(tokens, s.name.toLowerCase());
        if (sScore > 0) {
          score += sScore * 0.6;
          symHit = true;
          if (tokens.includes(s.name.toLowerCase()) && !matchedSymbolNames.includes(s.name)) {
            matchedSymbolNames.push(s.name);
          }
        }
      }
      if (symHit) reasons.push('defines matching symbol');

      const expHit = fi.exports.some((e) => tokenMatchScore(tokens, e.toLowerCase()) > 0);
      if (expHit) {
        score += 0.3;
        reasons.push('exports match');
      }

      if (score > 0 || (activeFileAbs && fi.path === activeFileAbs)) {
        candidates.push({
          path: fi.path,
          score,
          reasons,
          contentRead: false,
          contentScore: 0,
        });
        if (symHit && !symbolMatchedFiles.includes(fi.path)) symbolMatchedFiles.push(fi.path);
      }
    }

    // ── Phase 2: read content of top candidates, exact-text score ──
    candidates.sort((a, b) => b.score - a.score);
    const topForRead = candidates.slice(0, CANDIDATE_READ_LIMIT);
    for (const c of topForRead) {
      const content = this.readFileSafe(c.path);
      if (content == null) continue;
      c.contentRead = true;
      const lower = content.toLowerCase();
      let cScore = 0;
      for (const t of tokens) {
        if (lower.includes(t)) cScore += 1;
      }
      c.contentScore = cScore / Math.max(tokens.length, 1);
      if (c.contentScore > 0) {
        c.score += c.contentScore * 1.0;
        if (!c.reasons.includes('contains requested text')) c.reasons.push('contains requested text');
        exactMatched.push(c.path);
      }
    }

    // ── Phase 3: import-graph expansion ──
    const scoreMap = new Map<string, number>();
    for (const c of candidates) scoreMap.set(c.path, c.score);
    const reasonMap = new Map<string, string[]>();
    for (const c of candidates) reasonMap.set(c.path, c.reasons);

    const seeds = [...scoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, IMPORT_EXPANSION_SEEDS)
      .map((e) => e[0]);
    const importMatched: string[] = [];
    for (const seed of seeds) {
      const seedScore = scoreMap.get(seed) ?? 0;
      if (seedScore <= 0) continue;
      const neighbors = [
        ...this.indexer.getDependencies(seed),
        ...this.indexer.getDependents(seed),
      ];
      for (const n of neighbors) {
        const boost = seedScore * IMPORT_EXPANSION_DECAY;
        const prev = scoreMap.get(n) ?? 0;
        if (boost > prev) {
          scoreMap.set(n, boost);
          importMatched.push(n);
          const r = reasonMap.get(n) ?? [];
          r.push('import-graph neighbor of ' + basename(seed));
          reasonMap.set(n, r);
        }
      }
    }

    // ── Phase 4: boosts ──
    const now = nowMs();
    for (const [path, sc] of scoreMap) {
      let boosted = sc;
      if (activeFileAbs && path === activeFileAbs) {
        boosted *= ACTIVE_FILE_BOOST;
        const r = reasonMap.get(path) ?? [];
        if (!r.includes('active file')) r.push('active file');
        reasonMap.set(path, r);
      }
      const fi = index.files.get(path);
      const recentViaOpts = recentEditsAbs.has(path);
      const recentViaMtime = fi ? now - fi.lastModified < RECENT_EDIT_WINDOW_MS : false;
      if (recentViaOpts || recentViaMtime) {
        boosted *= RECENT_EDIT_BOOST;
        const r = reasonMap.get(path) ?? [];
        if (!r.includes('recently edited')) r.push('recently edited');
        reasonMap.set(path, r);
      }
      scoreMap.set(path, boosted);
    }

    // ── Build sources ──
    sources.push({
      type: 'exact',
      query: tokens.join(' '),
      matched: exactMatched,
    });
    if (symbolMatchedFiles.length > 0) {
      sources.push({ type: 'symbol-graph', query: matchedSymbolNames.join(' '), matched: symbolMatchedFiles });
    }
    if (importMatched.length > 0) {
      sources.push({ type: 'import-graph', query: seeds.join(' '), matched: [...new Set(importMatched)] });
    }
    if (activeFileAbs && scoreMap.has(activeFileAbs)) {
      sources.push({ type: 'active-file', query: activeFileAbs, matched: [activeFileAbs] });
    }

    // ── Phase 5: sort + truncate to token budget ──
    const ranked = [...scoreMap.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);

    const files: RetrievedFile[] = [];
    let usedTokens = 0;
    for (const [path, score] of ranked) {
      if (usedTokens >= maxTokens) break;
      const remaining = maxTokens - usedTokens;
      const file = this.buildRetrievedFile(path, score, reasonMap.get(path) ?? [], tokens, remaining, rootPath);
      if (!file) continue;
      files.push(file);
      usedTokens += estimateTokens(file.content);
    }

    // ── Symbols: definitions + references for matched symbol names ──
    const symbols = this.collectSymbols(matchedSymbolNames, tokens);

    return {
      files,
      symbols,
      totalTokens: usedTokens,
      sources,
    };
  }

  /** Answer a codebase question with synthesized text + evidence snippets. */
  async answerQuestion(question: string): Promise<{
    answer: string;
    evidence: Array<{ file: string; line: number; snippet: string }>;
  }> {
    const result = await this.retrieve(question, { maxTokens: 6000 });
    const lines: string[] = [`Question: ${question}`];

    if (result.symbols.length > 0) {
      lines.push('Symbols:');
      for (const s of result.symbols.slice(0, 8)) {
        lines.push(`  ${s.type} ${s.name} — ${s.filePath}:${s.line} (${s.reason})`);
      }
    }
    if (result.files.length > 0) {
      lines.push('Relevant files:');
      for (const f of result.files.slice(0, 6)) {
        lines.push(`  ${f.path}${f.lines ? `:${f.lines.start}` : ''} — ${f.reason}`);
      }
    }
    if (result.symbols.length === 0 && result.files.length === 0) {
      lines.push('No matching symbols or files found in the codebase index.');
    }
    const answer = lines.join('\n');

    const evidence: Array<{ file: string; line: number; snippet: string }> = [];
    const tokens = extractTokens(question);
    for (const f of result.files.slice(0, 5)) {
      const snip = this.snippetAroundBestLine(f.path, tokens);
      if (snip) evidence.push(snip);
    }
    for (const s of result.symbols.slice(0, 3)) {
      const snip = this.snippetAroundLine(s.filePath, s.line);
      if (snip) evidence.push(snip);
    }

    return { answer, evidence };
  }

  /** A compact 1-2 paragraph project orientation. */
  async getOrientation(): Promise<string> {
    const index = this.indexer.getIndex();
    if (!index) return 'Codebase has not been indexed yet.';
    if (this.orientationCache && this.orientationCache.indexUpdatedAt === index.updatedAt) {
      return this.orientationCache.value;
    }

    const value = this.buildOrientation(index);
    this.orientationCache = { value, indexUpdatedAt: index.updatedAt };
    return value;
  }

  /** Find files relevant to a topic. */
  async findRelevantFiles(
    topic: string,
    limit = 10
  ): Promise<Array<{ path: string; score: number; reason: string }>> {
    const result = await this.retrieve(topic, { maxTokens: 1 });
    return result.files
      .slice(0, limit)
      .map((f) => ({ path: f.path, score: f.score, reason: f.reason }));
  }

  // ── Internals ──

  private buildOrientation(index: CodebaseIndex): string {
    const root = index.rootPath;
    const byLang = new Map<string, number>();
    for (const fi of index.files.values()) {
      byLang.set(fi.language, (byLang.get(fi.language) ?? 0) + 1);
    }
    const langParts = [...byLang.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, n]) => `${n} ${l}`)
      .join(', ');

    const entryNames = [
      'index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.js',
      'server.ts', 'server.js', 'app.ts', 'app.tsx', 'src/index.ts',
      'src/main.ts', 'app/layout.tsx',
    ];
    const entries: string[] = [];
    for (const fi of index.files.values()) {
      const rel = relative(root, fi.path);
      if (entryNames.includes(rel) || entryNames.includes(basename(fi.path))) {
        entries.push(rel);
      }
    }

    const frameworks = this.detectFrameworks(root);
    const modules = this.listTopModules(root, index);

    const parts: string[] = [];
    const intro =
      `This is a ${frameworks.length > 0 ? frameworks.join(' / ') + ' ' : ''}project ` +
      `at ${root} with ${index.files.size} indexed files (${langParts || 'unknown languages'}).`;
    parts.push(intro);

    if (entries.length > 0) {
      parts.push(`Main entry points: ${entries.slice(0, 8).join(', ')}.`);
    }
    if (modules.length > 0) {
      parts.push(`Key modules: ${modules.slice(0, 12).join(', ')}.`);
    }
    const exports = this.topExports(index);
    if (exports.length > 0) {
      parts.push(`Notable exports: ${exports.slice(0, 16).join(', ')}.`);
    }
    const value = parts.join(' ');
    return value;
  }

  private detectFrameworks(root: string): string[] {
    const out: string[] = [];
    const pkg = this.readJsonSafe(resolve(root, 'package.json'));
    if (pkg) {
      const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps['next']) out.push('Next.js');
      if (deps['react']) out.push('React');
      if (deps['express']) out.push('Express');
      if (deps['fastify']) out.push('Fastify');
      if (deps['@nestjs/core']) out.push('NestJS');
      if (deps['hono']) out.push('Hono');
      if (deps['prisma']) out.push('Prisma');
      if (deps['drizzle-orm']) out.push('Drizzle');
      if (deps['telegram'] || deps['discord.js']) out.push('bot');
      if (deps['@opencode-ai/plugin']) out.push('OpenCode plugin');
    }
    if (this.fileExists(resolve(root, 'Cargo.toml'))) out.push('Rust');
    if (this.fileExists(resolve(root, 'pyproject.toml')) || this.fileExists(resolve(root, 'requirements.txt'))) {
      out.push('Python');
    }
    if (this.fileExists(resolve(root, 'go.mod'))) out.push('Go');
    return [...new Set(out)];
  }

  private listTopModules(root: string, index: CodebaseIndex): string[] {
    const set = new Set<string>();
    for (const fi of index.files.values()) {
      const rel = relative(root, fi.path);
      if (!rel || rel.startsWith('..')) continue;
      const first = rel.split(sep)[0];
      if (first && !['node_modules', 'dist', 'build', '.git'].includes(first)) set.add(first);
    }
    return [...set];
  }

  private topExports(index: CodebaseIndex): string[] {
    const out: string[] = [];
    for (const fi of index.files.values()) {
      for (const e of fi.exports) {
        if (e && e !== '*' && !out.includes(e)) out.push(e);
      }
    }
    return out;
  }

  private collectSymbols(names: string[], tokens: string[]): RetrievedSymbol[] {
    const out: RetrievedSymbol[] = [];
    for (const name of names) {
      const def = this.indexer.findDefinition(name);
      if (def) {
        out.push({
          name: def.name,
          type: def.type,
          filePath: def.filePath,
          line: def.line,
          reason: 'definition of ' + name,
        });
      }
      for (const ref of this.indexer.findReferences(name)) {
        if (def && ref.filePath === def.filePath && ref.line === def.line) continue;
        out.push({
          name: ref.name,
          type: ref.type,
          filePath: ref.filePath,
          line: ref.line,
          reason: 'reference to ' + name,
        });
      }
      void tokens;
    }
    // De-dup by filePath+line
    const seen = new Set<string>();
    const deduped: RetrievedSymbol[] = [];
    for (const s of out) {
      const key = s.filePath + ':' + s.line + ':' + s.name;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(s);
    }
    return deduped.slice(0, 30);
  }

  private buildRetrievedFile(
    absPath: string,
    score: number,
    reasons: string[],
    tokens: string[],
    remainingTokens: number,
    rootPath: string
  ): RetrievedFile | null {
    const content = this.readFileSafe(absPath);
    if (content == null) return null;
    const maxChars = remainingTokens * CHARS_PER_TOKEN;
    const rel = relative(rootPath, absPath) || absPath;

    if (content.length <= maxChars) {
      return {
        path: rel,
        content,
        reason: reasons.slice(0, 2).join('; ') || 'matched query',
        score: Math.min(score, 1),
      };
    }

    const slice = this.bestSlice(content, tokens, Math.max(maxChars, 400));
    return {
      path: rel,
      content: slice.content,
      reason: reasons.slice(0, 2).join('; ') || 'matched query',
      score: Math.min(score, 1),
      lines: { start: slice.startLine, end: slice.endLine },
    };
  }

  private bestSlice(
    content: string,
    tokens: string[],
    maxChars: number
  ): { content: string; startLine: number; endLine: number } {
    const lines = content.split('\n');
    let bestLine = 0;
    let bestScore = -1;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      let s = 0;
      for (const t of tokens) if (lower.includes(t)) s++;
      if (s > bestScore) {
        bestScore = s;
        bestLine = i;
      }
    }
    const window = Math.floor(SLICE_WINDOW_LINES / 2);
    let start = Math.max(0, bestLine - window);
    let end = Math.min(lines.length - 1, bestLine + window);
    // shrink to fit maxChars
    while (end > start && lines.slice(start, end + 1).join('\n').length > maxChars) {
      end--;
    }
    if (end <= start) end = Math.min(lines.length - 1, start + 1);
    return {
      content: lines.slice(start, end + 1).join('\n'),
      startLine: start + 1,
      endLine: end + 1,
    };
  }

  private snippetAroundBestLine(
    absPath: string,
    tokens: string[]
  ): { file: string; line: number; snippet: string } | null {
    const content = this.readFileSafe(absPath);
    if (content == null) return null;
    const lines = content.split('\n');
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      let s = 0;
      for (const t of tokens) if (lower.includes(t)) s++;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (bestScore < 0) return null;
    const start = Math.max(0, best - 3);
    const end = Math.min(lines.length - 1, best + 3);
    return {
      file: absPath,
      line: best + 1,
      snippet: lines.slice(start, end + 1).join('\n'),
    };
  }

  private snippetAroundLine(
    absPath: string,
    line: number
  ): { file: string; line: number; snippet: string } | null {
    const content = this.readFileSafe(absPath);
    if (content == null) return null;
    const lines = content.split('\n');
    const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
    const start = Math.max(0, idx - 3);
    const end = Math.min(lines.length - 1, idx + 3);
    return {
      file: absPath,
      line: idx + 1,
      snippet: lines.slice(start, end + 1).join('\n'),
    };
  }

  private readFileSafe(absPath: string): string | null {
    try {
      return readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
  }

  private readJsonSafe(absPath: string): Record<string, unknown> | null {
    const raw = this.readFileSafe(absPath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private fileExists(absPath: string): boolean {
    try {
      return statSync(absPath).isFile();
    } catch {
      return false;
    }
  }
}

/** Re-export index types for convenience. */
export type { CodebaseIndexer, SymbolNode, FileIndex, CodebaseIndex };
