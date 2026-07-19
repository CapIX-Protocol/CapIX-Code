/**
 * Capix inline completion — Copilot-style "ghost text" session for the CLI.
 *
 * Wraps `CompletionEngine` with the suggestion lifecycle a terminal UI needs:
 *  - `update()` on each keystroke schedules a debounced, context-aware
 *    completion (current file, project snippets, recent edits);
 *  - Tab accepts the whole suggestion, ctrl+right accepts one word,
 *    ctrl+enter accepts one line of a multi-line suggestion, Escape rejects;
 *  - suggestions may span multiple lines; `getGhostText()` exposes the
 *    render shape (first line inline after the cursor, the rest below);
 *  - state changes are pushed to subscribed listeners for redraw.
 *
 * What this module deliberately does NOT do:
 *  - render anything itself (the TUI owns the screen);
 *  - mutate the document (acceptance returns the text; the caller inserts it);
 *  - keep history across sessions.
 */

import { logger } from '../logger.js';
import {
  CompletionEngine,
  buildCompletionContext,
  type CompletionEngineOptions,
  type ProjectSnippet,
  type RecentEdit,
} from './completion-engine.js';

/** Snapshot of the editor the session completes against. */
export interface EditorSnapshot {
  filePath: string;
  content: string;
  /** Cursor position as a character offset into `content`. */
  cursorOffset: number;
  projectSnippets?: ProjectSnippet[];
}

export type InlineCompletionState = 'idle' | 'pending' | 'showing';

/** A live suggestion the user can accept or reject. */
export interface InlineSuggestion {
  text: string;
  /** `text` pre-split for multi-line rendering. */
  lines: string[];
  model: string;
  fromCache: boolean;
}

/** Result of an accept action: text to insert, plus what remains pending. */
export interface AcceptedCompletion {
  inserted: string;
  /** Remaining suggestion still shown (partial accepts); absent when done. */
  remaining?: string;
}

/** Render model for ghost text: inline tail plus lines below the cursor. */
export interface GhostText {
  inline: string;
  below: string[];
}

export type InlineCompletionListener = (
  state: InlineCompletionState,
  suggestion: InlineSuggestion | null
) => void;

/** Keys the session understands. The TUI maps raw input onto these. */
export type InlineCompletionKey = 'tab' | 'escape' | 'accept-word' | 'accept-line';

export type InlineCompletionKeyResult = 'accepted' | 'rejected' | 'ignored';

const MAX_RECENT_EDITS = 10;

export interface InlineCompletionSessionOptions extends CompletionEngineOptions {
  /** Engine instance to reuse (defaults to a new CompletionEngine). */
  engine?: CompletionEngine;
}

/**
 * One inline-completion session (per editor/document). Create a new session
 * per file; drive it with `update`, `handleKey`, and `onDidChange`.
 */
export class InlineCompletionSession {
  private readonly engine: CompletionEngine;
  private readonly listeners = new Set<InlineCompletionListener>();
  private readonly recentEdits: RecentEdit[] = [];
  private current: InlineSuggestion | null = null;
  private state: InlineCompletionState = 'idle';
  private lastSnapshot: EditorSnapshot | null = null;
  private updateSeq = 0;

  constructor(options: InlineCompletionSessionOptions) {
    this.engine = options.engine ?? new CompletionEngine(options);
  }

  getState(): InlineCompletionState {
    return this.state;
  }

  /** The suggestion currently shown, if any. */
  getCurrent(): InlineSuggestion | null {
    return this.current;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onDidChange(listener: InlineCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Record an edit the user (or agent) made; recent edits are fed back into
   * the completion context so suggestions follow the local change pattern.
   */
  recordEdit(path: string, summary: string): void {
    this.recentEdits.push({ path, summary });
    if (this.recentEdits.length > MAX_RECENT_EDITS) this.recentEdits.shift();
  }

  /**
   * Keystroke entry point. Schedules a debounced completion for the new
   * snapshot; a previously pending request is superseded and aborted.
   */
  async update(snapshot: EditorSnapshot): Promise<void> {
    this.lastSnapshot = snapshot;
    const seq = ++this.updateSeq;
    this.setCurrent(null, 'pending');

    const context = buildCompletionContext(
      {
        filePath: snapshot.filePath,
        content: snapshot.content,
        cursorOffset: snapshot.cursorOffset,
        projectSnippets: snapshot.projectSnippets,
        recentEdits: [...this.recentEdits],
      },
      {}
    );

    const result = await this.engine.schedule(context);
    if (seq !== this.updateSeq) return; // superseded by a newer update/reject
    if (!result) {
      this.setCurrent(null, 'idle');
      return;
    }
    this.setCurrent(
      {
        text: result.text,
        lines: result.text.split('\n'),
        model: result.model,
        fromCache: result.fromCache,
      },
      'showing'
    );
  }

  /**
   * Tab — accept the whole suggestion. Returns the text to insert at the
   * cursor, or `null` when nothing is showing.
   */
  accept(): AcceptedCompletion | null {
    if (!this.current) return null;
    const inserted = this.current.text;
    this.recordEdit(this.lastSnapshot?.filePath ?? '', `accepted completion: ${preview(inserted)}`);
    this.setCurrent(null, 'idle');
    return { inserted };
  }

  /** Accept only the first line of a multi-line suggestion. */
  acceptLine(): AcceptedCompletion | null {
    if (!this.current) return null;
    const [line, ...rest] = this.current.lines;
    const inserted = rest.length > 0 ? `${line ?? ''}\n` : (line ?? '');
    this.applyPartial(inserted, rest.join('\n'));
    return { inserted };
  }

  /** Accept the next word of the suggestion. */
  acceptWord(): AcceptedCompletion | null {
    if (!this.current) return null;
    const match = this.current.text.match(/^\s*\S+/);
    if (!match) return this.accept();
    const inserted = match[0];
    this.applyPartial(inserted, this.current.text.slice(inserted.length));
    return { inserted };
  }

  /** Escape — reject the showing suggestion and cancel anything pending. */
  reject(): void {
    this.updateSeq += 1;
    if (this.state === 'idle' && !this.current) return;
    if (this.current) {
      this.recordEdit(
        this.lastSnapshot?.filePath ?? '',
        `rejected completion: ${preview(this.current.text)}`
      );
    }
    this.engine.cancelPending();
    this.setCurrent(null, 'idle');
  }

  /**
   * Map a UI key onto the session. Returns what happened so the caller can
   * decide whether the keypress was consumed.
   */
  handleKey(key: InlineCompletionKey): InlineCompletionKeyResult {
    switch (key) {
      case 'tab':
        return this.accept() ? 'accepted' : 'ignored';
      case 'accept-line':
        return this.acceptLine() ? 'accepted' : 'ignored';
      case 'accept-word':
        return this.acceptWord() ? 'accepted' : 'ignored';
      case 'escape':
        if (this.state === 'idle' && !this.current) return 'ignored';
        this.reject();
        return 'rejected';
    }
  }

  /**
   * Ghost-text render model: the first line continues the current line after
   * the cursor; the remaining lines render below it. `null` when idle.
   */
  getGhostText(): GhostText | null {
    if (!this.current) return null;
    const [inline = '', ...below] = this.current.lines;
    return { inline, below };
  }

  /** Tear down: cancel pending work and detach listeners. */
  dispose(): void {
    this.engine.cancelPending();
    this.listeners.clear();
    this.current = null;
    this.state = 'idle';
  }

  private applyPartial(inserted: string, remaining: string): void {
    this.recordEdit(
      this.lastSnapshot?.filePath ?? '',
      `accepted partial completion: ${preview(inserted)}`
    );
    if (remaining.trim().length === 0) {
      this.setCurrent(null, 'idle');
      return;
    }
    this.setCurrent(
      {
        text: remaining,
        lines: remaining.split('\n'),
        model: this.current?.model ?? 'unknown',
        fromCache: false,
      },
      'showing'
    );
  }

  private setCurrent(suggestion: InlineSuggestion | null, state: InlineCompletionState): void {
    this.current = suggestion;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state, suggestion);
      } catch (err) {
        logger.warn('inline-completion: listener threw', { error: String(err) });
      }
    }
  }
}

/** Convenience factory matching the other Capix clients' shape. */
export function createInlineCompletionSession(
  options: InlineCompletionSessionOptions
): InlineCompletionSession {
  return new InlineCompletionSession(options);
}

/** One-line preview for recent-edit summaries (no multiline noise). */
function preview(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
