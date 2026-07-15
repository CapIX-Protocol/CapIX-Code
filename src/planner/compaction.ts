/**
 * ContextCompactor — loss-aware session summarization.
 *
 * Refs:
 * - architecture (context compaction / loss-aware summary)
 * - intelligence-client HookEventType 'compact.run'
 *
 * Compaction converts a long conversation into a STRUCTURED data object —
 * not a free-form chat summary. The compacted payload preserves the
 * information downstream turns actually need:
 *  - key decisions the user made
 *  - files that were touched
 *  - errors encountered and how they were resolved
 *  - durable user preferences
 *  - active covenant rules
 *
 * That structured summary is what gets injected into subsequent turns as
 * context. When a `ModelInvoker` is wired, the model is asked to extract the
 * structured fields via a fixed text protocol; otherwise a heuristic extractor
 * derives them from message content.
 */

import { randomUUID } from 'node:crypto';

import type { ModelInvoker } from './planner.js';

export interface CompactedSession {
  sessionId: string;
  summary: string;
  keyDecisions: string[];
  filesTouched: string[];
  errorsEncountered: string[];
  userPreferences: string[];
  covenantsActive: string[];
  tokenBudget: number;
  originalTokenCount: number;
  compactedAt: string;
}

const COMPACTION_SYSTEM_PROMPT = `You are compacting a software-engineering conversation. Extract structured information using EXACTLY this text protocol. Do not add prose outside the protocol.

Output format:
DECISIONS: <comma-separated key decisions the user/engineer made, or "none">
FILES: <comma-separated file paths touched, or "none">
ERRORS: <comma-separated errors encountered and how resolved, or "none">
PREFERENCES: <comma-separated durable user preferences, or "none">
COVENANTS: <comma-separated active covenant/rules invariants, or "none">
SUMMARY: <one or two sentence factual summary of what was done and the current state>`;

export class ContextCompactor {
  private readonly modelInvoker: ModelInvoker | null;

  constructor(modelInvoker?: ModelInvoker) {
    this.modelInvoker = modelInvoker ?? null;
  }

  /**
   * Compact a long conversation into a structured summary.
   *
   * 1. identify key decisions ("use approach X")
   * 2. identify files that were touched
   * 3. identify errors and how they were resolved
   * 4. identify durable user preferences ("I prefer tabs")
   * 5. preserve active covenant rules
   * 6. summarize into ~1000 tokens
   * 7. the summary is structured, not free-form chat
   */
  async compact(
    messages: Array<{ role: string; content: string }>
  ): Promise<CompactedSession> {
    const originalTokenCount = estimateTokens(messages.map((m) => m.content).join('\n'));
    const sessionId = randomUUID();

    if (this.modelInvoker && messages.length > 0) {
      try {
        const transcript = messages
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n\n');
        const response = await this.modelInvoker(
          [COMPACTION_SYSTEM_PROMPT, '', '## Conversation', transcript, '', 'Extract now.'].join('\n')
        );
        const parsed = this.parseCompactionResponse(response, messages);
        return {
          sessionId,
          ...parsed,
          tokenBudget: estimateTokens(parsed.summary),
          originalTokenCount,
          compactedAt: new Date().toISOString(),
        };
      } catch {
        // fall through to heuristic extraction
      }
    }

    return this.heuristicCompact(messages, sessionId, originalTokenCount);
  }

  private parseCompactionResponse(
    response: string,
    messages: Array<{ role: string; content: string }>
  ): {
    summary: string;
    keyDecisions: string[];
    filesTouched: string[];
    errorsEncountered: string[];
    userPreferences: string[];
    covenantsActive: string[];
  } {
    const out = {
      summary: '',
      keyDecisions: [] as string[],
      filesTouched: [] as string[],
      errorsEncountered: [] as string[],
      userPreferences: [] as string[],
      covenantsActive: [] as string[],
    };

    const splitList = (raw: string): string[] =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== 'none');

    for (const rawLine of response.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^DECISIONS\s*:\s*(.*)$/i))) out.keyDecisions = splitList(m[1]!);
      else if ((m = line.match(/^FILES\s*:\s*(.*)$/i))) out.filesTouched = splitList(m[1]!);
      else if ((m = line.match(/^ERRORS\s*:\s*(.*)$/i))) out.errorsEncountered = splitList(m[1]!);
      else if ((m = line.match(/^PREFERENCES\s*:\s*(.*)$/i)))
        out.userPreferences = splitList(m[1]!);
      else if ((m = line.match(/^COVENANTS\s*:\s*(.*)$/i))) out.covenantsActive = splitList(m[1]!);
      else if ((m = line.match(/^SUMMARY\s*:\s*(.*)$/i))) out.summary = m[1]!.trim();
    }

    if (!out.summary) {
      out.summary = deriveFallbackSummary(messages);
    }
    return out;
  }

  private heuristicCompact(
    messages: Array<{ role: string; content: string }>,
    sessionId: string,
    originalTokenCount: number
  ): CompactedSession {
    const text = messages.map((m) => m.content).join('\n');

    const filesTouched = uniq(
      (text.match(/(?:src\/|lib\/|app\/|packages\/|tests\/)?[\w./-]+\.(?:ts|tsx|js|jsx|json|py|go|rs|md)/g) ?? [])
    );
    const decisions = uniq(extractSentences(text, /\b(?:use|let'?s|we should|going to|decided to|approach)\b/i));
    const errors = uniq(
      (text.match(/(?:error|failed|exception|traceback|cannot find|is not defined)[^\n.]*[.?:]?/gi) ?? [])
    );
    const preferences = uniq(extractSentences(text, /\b(?:prefer|always|never|i like|i hate|use tabs|use spaces)\b/i));
    const summary = deriveFallbackSummary(messages);

    return {
      sessionId,
      summary,
      keyDecisions: decisions.slice(0, 10),
      filesTouched: filesTouched.slice(0, 30),
      errorsEncountered: errors.slice(0, 10),
      userPreferences: preferences.slice(0, 10),
      covenantsActive: [],
      tokenBudget: estimateTokens(summary),
      originalTokenCount,
      compactedAt: new Date().toISOString(),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter((s) => s.length > 1)));
}

function extractSentences(text: string, keyword: RegExp): string[] {
  const sentences = text.split(/[.\n]/);
  return sentences
    .map((s) => s.trim())
    .filter((s) => keyword.test(s) && s.length > 4 && s.length < 200);
}

function deriveFallbackSummary(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const parts: string[] = [];
  if (lastUser) parts.push(`Last user request: ${truncate(lastUser.content, 200)}`);
  if (lastAssistant) parts.push(`Last action: ${truncate(lastAssistant.content, 200)}`);
  return parts.length ? parts.join(' ') : 'No summary available.';
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
