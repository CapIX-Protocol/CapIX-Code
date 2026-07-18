/**
 * Unified TUI components — ANSI string renderers that mirror the IDE
 * assistant panel (`ide/extensions/capix-llm/src/assistantPanel.ts`) so the
 * terminal and the webview read as one product:
 *
 *  - `renderStatusBar`   ← IDE header (brand, connection dot, indicators)
 *  - `renderSessionList` ← IDE session history rows
 *  - `renderToolCard`    ← IDE tool timeline cards (`.cpx-tool`)
 *  - `renderComposer`    ← IDE composer (`.cpx-composer`)
 *
 * Every renderer is a pure function returning an array of ANSI-styled lines;
 * colors flow from `UnifiedTheme` (the same tokens as `assistant.css`), never
 * hardcoded. Status semantics match the webview: cyan = active, green =
 * success, amber = attention, red = failure.
 */

import { formatMoney, type Money } from '../routing-client.js';
import {
  UNIFIED_MODES,
  hexToAnsi256,
  resolveTheme,
  type UnifiedTheme,
} from './unified-theme.js';

// ── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

// Built via fromCharCode so no literal control character appears in source.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Strip ANSI SGR sequences — used for width math and in tests. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Visible cell width of a possibly-styled line (ignores wide glyphs). */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Paint text with a theme hex color, mapped to the xterm-256 palette. */
export function paint(text: string, hex: string, opts?: { bold?: boolean }): string {
  const code = `${opts?.bold ? '1;' : ''}38;5;${hexToAnsi256(hex)}`;
  return `${ESC}${code}m${text}${RESET}`;
}

/** Truncate to `max` visible cells, appending `…` when clipped. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`;
}

// ── Status bar (IDE assistant header) ───────────────────────────────────────

export type ConnectionState = 'online' | 'working' | 'offline';

export interface StatusBarData {
  /** Project/workspace name; `null` renders `—` like the IDE indicator. */
  project?: string | null;
  /** Active agent mode id or label (ask/plan/build/debug/review). */
  mode: string;
  /** Active model target, e.g. `capix/auto`. */
  model: string;
  /** Engine connection state — drives the `.cpx-conn` dot color. */
  connection: ConnectionState;
  /** Current git branch, shown when present (mirrors the IDE git indicator). */
  git?: string | null;
  /** Active file name, shown when present. */
  file?: string | null;
  /** Max visible width per line; labels truncate to fit. Default 80. */
  width?: number;
}

/**
 * Two lines matching the IDE assistant header: brand + connection dot, then
 * the indicator row (project · mode · model [· git] [· file]). Mode is tinted
 * accent and model violet, exactly like `.cpx-indicator--mode` / `--model`.
 */
export function renderStatusBar(data: StatusBarData, theme?: UnifiedTheme): string[] {
  const t = theme ?? resolveTheme();
  const width = data.width ?? 80;

  const connColor =
    data.connection === 'online'
      ? t.signals.success
      : data.connection === 'working'
        ? t.signals.accent
        : t.signals.warning;

  const header = [
    paint('▛', t.signals.accent),
    paint('Capix', t.text.fg, { bold: true }),
    paint('●', connColor),
  ].join(' ');

  const indicators = [
    paint(truncate(data.project ?? '—', 24), t.text.fg2),
    `${paint('●', t.signals.accent)} ${paint(data.mode, t.signals.accent)}`,
    paint(data.model, t.signals.violet),
  ];
  if (data.git) indicators.push(paint(truncate(data.git, 20), t.text.fg2));
  if (data.file) indicators.push(paint(truncate(data.file, 24), t.text.fg2));
  const indicatorLine = indicators.join(paint(' · ', t.borders.borderStrong));

  return [truncateStyled(header, width), truncateStyled(indicatorLine, width)];
}

// ── Session list (IDE session history) ──────────────────────────────────────

export interface SessionSummary {
  id: string;
  title: string;
  /** ISO timestamp of last activity. */
  updatedAt: string;
  model?: string;
  messageCount?: number;
}

export interface SessionListOptions {
  /** Id of the active session — its row gets the accent `▸` marker. */
  activeId?: string | null;
  /** Max visible width per row. Default 80. */
  width?: number;
  /** Reference time for relative stamps (defaults to `Date.now()`). */
  now?: number;
}

/**
 * One row per session: `▸ title … 5m ago`, with the active row tinted accent
 * and the rest in secondary text — the terminal analogue of the IDE session
 * history list.
 */
export function renderSessionList(
  sessions: readonly SessionSummary[],
  opts?: SessionListOptions,
  theme?: UnifiedTheme
): string[] {
  const t = theme ?? resolveTheme();
  const width = opts?.width ?? 80;
  const now = opts?.now ?? Date.now();

  return sessions.map((session) => {
    const active = opts?.activeId != null && session.id === opts.activeId;
    const stamp = relativeTime(session.updatedAt, now);
    const count = session.messageCount != null ? ` (${session.messageCount})` : '';
    const titleWidth = Math.max(1, width - stamp.length - count.length - 4);
    const title = truncate(session.title || 'Untitled session', titleWidth);
    const marker = active ? paint('▸', t.signals.accent) : ' ';
    const titlePainted = active
      ? paint(title, t.signals.accent, { bold: true })
      : paint(title, t.text.fg);
    return `${marker} ${titlePainted}${paint(count, t.text.muted)} ${paint(stamp, t.text.muted)}`;
  });
}

/** Compact relative timestamp (`just now`, `5m ago`, `3h ago`, `2d ago`). */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Tool cards (IDE tool timeline) ──────────────────────────────────────────

export type ToolCallState = 'pending' | 'running' | 'success' | 'error';

export interface ToolCall {
  /** Tool name, rendered mono-style in accent like `.cpx-tool__name`. */
  name: string;
  /** Human summary, truncated like `.cpx-tool__label`. */
  label?: string;
  state: ToolCallState;
  /** Output shown in the collapsible body when `expanded` is set. */
  output?: string;
  expanded?: boolean;
}

export interface ToolCardOptions {
  /** Frame index for the running spinner (braille cycle). Default 0. */
  spinnerFrame?: number;
  /** Max visible width per line. Default 80. */
  width?: number;
  /** Max output lines in the expanded body. Default 8. */
  maxOutputLines?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A tool timeline card matching `.cpx-tool`: a header row with status glyph,
 * accent tool name, truncated label and state badge, plus an optional output
 * body (fg2, capped at `maxOutputLines`) when the call is expanded.
 */
export function renderToolCard(
  tool: ToolCall,
  opts?: ToolCardOptions,
  theme?: UnifiedTheme
): string[] {
  const t = theme ?? resolveTheme();
  const width = opts?.width ?? 80;
  const maxOutputLines = opts?.maxOutputLines ?? 8;

  const { glyph, color, badge } = toolStateVisual(tool.state, opts?.spinnerFrame ?? 0, t);

  const badgeText = paint(` ${badge} `, color);
  const name = paint(tool.name, t.signals.accent);
  const labelBudget = Math.max(0, width - tool.name.length - badge.length - 8);
  const label = tool.label ? ` ${paint(truncate(tool.label, labelBudget), t.text.fg2)}` : '';
  const header = `${paint(glyph, color)} ${name}${label} ${badgeText}`;

  const lines = [truncateStyled(header, width)];
  if (tool.expanded && tool.output) {
    lines.push(paint(`┄${'┄'.repeat(Math.max(0, width - 1))}`, t.borders.border));
    const outputLines = tool.output.split('\n');
    const shown = outputLines.slice(0, maxOutputLines);
    for (const line of shown) {
      lines.push(truncateStyled(paint(line, t.text.fg2), width));
    }
    const remaining = outputLines.length - shown.length;
    if (remaining > 0) {
      lines.push(paint(`… ${remaining} more line${remaining === 1 ? '' : 's'}`, t.text.muted));
    }
  }
  return lines;
}

function toolStateVisual(
  state: ToolCallState,
  spinnerFrame: number,
  t: UnifiedTheme
): { glyph: string; color: string; badge: string } {
  switch (state) {
    case 'running':
      return {
        glyph: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length],
        color: t.signals.accent,
        badge: 'running',
      };
    case 'success':
      return { glyph: '✓', color: t.signals.success, badge: 'done' };
    case 'error':
      return { glyph: '✗', color: t.signals.danger, badge: 'failed' };
    default:
      return { glyph: '○', color: t.text.muted, badge: 'pending' };
  }
}

// ── Composer (IDE composer) ─────────────────────────────────────────────────

export interface ComposerState {
  /** Active mode id (must exist in `modes`). */
  mode: string;
  /** Mode pills; defaults to the shared `UNIFIED_MODES`. */
  modes?: ReadonlyArray<{ id: string; label: string; color: string }>;
  /** Current input text; the placeholder shows when empty. */
  input?: string;
  placeholder?: string;
  /** Attachment chip labels (`.cpx-chip`). */
  attachments?: readonly string[];
  /** Model label shown in the composer bar (`.cpx-composer__model`). */
  model?: string;
  /** Session cost, rendered in the meta line like `.cpx-cost`. */
  cost?: Money | null;
  /** Busy state swaps the send glyph for the stop affordance. */
  busy?: boolean;
  /** Box width in visible cells. Default 60. */
  width?: number;
}

/**
 * The composer block matching `.cpx-composer`: mode pill row, attachment
 * chips, a bordered input box with the model + send affordance in its bar,
 * and a meta line with cost and key hints.
 */
export function renderComposer(state: ComposerState, theme?: UnifiedTheme): string[] {
  const t = theme ?? resolveTheme();
  const width = Math.max(20, state.width ?? 60);
  const modes = state.modes ?? UNIFIED_MODES;

  const lines: string[] = [];

  // Mode row — active pill tinted accent like `.cpx-mode--active`.
  const pills = modes.map((m) => {
    const dot = paint('●', m.color);
    return m.id === state.mode
      ? `${dot} ${paint(m.label, t.signals.accent, { bold: true })}`
      : `${dot} ${paint(m.label, t.text.muted)}`;
  });
  lines.push(pills.join(paint('  ', t.borders.border)));

  // Attachment chips.
  if (state.attachments && state.attachments.length > 0) {
    const chips = state.attachments.map((label) =>
      paint(` ${truncate(label, 24)} × `, t.signals.accent)
    );
    lines.push(chips.join(' '));
  }

  // Input box.
  const inner = width - 2;
  const input = state.input ?? '';
  const shown = input || state.placeholder || 'Ask, plan, build…';
  const shownPainted = input ? paint(truncate(shown, inner - 1), t.text.fg) : paint(truncate(shown, inner - 1), t.text.muted);
  const borderColor = t.borders.border;
  lines.push(paint(`╭${'─'.repeat(inner)}╮`, borderColor));
  lines.push(`${paint('│', borderColor)} ${shownPainted}${' '.repeat(Math.max(0, inner - 1 - visibleWidth(shownPainted)))}${paint('│', borderColor)}`);

  // Composer bar — model left-aligned hint, send/stop on the right.
  const model = state.model ?? 'auto';
  const send = state.busy ? paint(' ■ Stop ', t.signals.danger) : paint(' ↑ ', t.signals.accent, { bold: true });
  const modelLabel = paint(truncate(model, Math.max(0, inner - 8)), t.text.muted);
  const barGap = Math.max(1, inner - visibleWidth(modelLabel) - visibleWidth(send) - 1);
  lines.push(
    `${paint('│', borderColor)} ${modelLabel}${' '.repeat(barGap)}${send}${paint('│', borderColor)}`
  );
  lines.push(paint(`╰${'─'.repeat(inner)}╯`, borderColor));

  // Meta line — cost (mono, muted) + key hints like `.cpx-composer__meta`.
  const cost = state.cost ? formatMoney(state.cost) : '';
  const hint = '⏎ send · ⇧⏎ newline';
  const metaGap = Math.max(1, width - cost.length - hint.length - 1);
  lines.push(`${paint(cost, t.text.muted)}${' '.repeat(cost ? metaGap : width - hint.length)}${paint(hint, t.text.muted)}`);

  return lines;
}

// ── Internal ────────────────────────────────────────────────────────────────

/** Truncate a styled line to `max` visible cells, preserving ANSI codes. */
function truncateStyled(line: string, max: number): string {
  if (visibleWidth(line) <= max) return line;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < line.length && visible < max) {
    if (line[i] === '\u001b') {
      const end = line.indexOf('m', i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}${RESET}`;
}
