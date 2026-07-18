/**
 * Unified theme — the Capix design tokens shared between the IDE assistant
 * webview and the capix-code TUI.
 *
 * The token values below mirror `ide/extensions/capix-llm/src/styles/assistant.css`
 * (and its shared export `src/unified-theme.css`) exactly: same deep neutral
 * surfaces, same cyan/teal signal color, same status semantics (cyan = active,
 * green = success, amber = attention, red = failure). The dark theme is the
 * default; `light` and `high-contrast` remap the same tokens, matching the
 * `body.vscode-light` / `body.vscode-high-contrast` blocks in the webview.
 *
 * Terminals have no alpha channel, so the CSS `*-soft` / `*-line` rgba
 * variants are intentionally omitted — TUI renderers use the solid signal
 * colors directly. Hex values are mapped to the nearest xterm-256 color via
 * `hexToAnsi256` at render time.
 */

export type ThemeName = 'dark' | 'light' | 'high-contrast';

export interface UnifiedTheme {
  name: ThemeName;
  /** Surface backgrounds, deepest first (matches --cpx-bg … --cpx-surface-3). */
  surfaces: {
    bg: string;
    surface: string;
    surface2: string;
    surface3: string;
  };
  borders: {
    border: string;
    borderStrong: string;
  };
  /** Body text; every pair meets WCAG AA on its surface in the webview. */
  text: {
    fg: string;
    fg2: string;
    muted: string;
  };
  /** Signal colors (matches --cpx-accent … --cpx-violet). */
  signals: {
    accent: string;
    accentStrong: string;
    onAccent: string;
    success: string;
    warning: string;
    danger: string;
    dangerFg: string;
    violet: string;
  };
  /** Syntax tokens (matches --cpx-tok-*). */
  syntax: {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    function: string;
    operator: string;
  };
  /**
   * Corner radii in px, kept for documentation parity with the webview;
   * TUI components use single-line box borders regardless.
   */
  shape: { radiusSmPx: number; radiusPx: number; radiusLgPx: number };
  /** Type scale in px (matches --cpx-size*); the terminal renders one size. */
  typography: { sizePx: number; sizeSmPx: number; sizeXsPx: number };
  /**
   * Spacing in terminal cells, derived from the webview's px rhythm
   * (12px horizontal padding → 1 cell, 8px gaps → 1 cell).
   */
  spacing: { padX: number; padY: number; gap: number; indent: number };
}

/** Default theme — identical to the `:root` block of assistant.css. */
export const darkTheme: UnifiedTheme = {
  name: 'dark',
  surfaces: { bg: '#0a0d10', surface: '#10151b', surface2: '#151c24', surface3: '#1b242f' },
  borders: { border: '#1e2833', borderStrong: '#2a3745' },
  text: { fg: '#e6edf2', fg2: '#9aa8b5', muted: '#6b7c8a' },
  signals: {
    accent: '#3dced6',
    accentStrong: '#5fe3ea',
    onAccent: '#062a2c',
    success: '#14f195',
    warning: '#ffae00',
    danger: '#ff6464',
    dangerFg: '#ffb3b3',
    violet: '#b48cff',
  },
  syntax: {
    keyword: '#7ee0e6',
    string: '#9ee8a6',
    comment: '#5c6b78',
    number: '#ffcf8a',
    function: '#c9b0ff',
    operator: '#8fa3b3',
  },
  shape: { radiusSmPx: 6, radiusPx: 10, radiusLgPx: 14 },
  typography: { sizePx: 12.5, sizeSmPx: 11, sizeXsPx: 10 },
  spacing: { padX: 1, padY: 0, gap: 1, indent: 2 },
};

/** Matches the `body.vscode-light` block of assistant.css. */
export const lightTheme: UnifiedTheme = {
  ...darkTheme,
  name: 'light',
  surfaces: { bg: '#f7f9fa', surface: '#ffffff', surface2: '#eef2f4', surface3: '#e2e9ed' },
  borders: { border: '#d5dfe5', borderStrong: '#b9c8d1' },
  text: { fg: '#1c2733', fg2: '#4a5b69', muted: '#71818e' },
  signals: {
    accent: '#0e9aa3',
    accentStrong: '#0b8a92',
    onAccent: '#ffffff',
    success: '#0a9d5f',
    warning: '#a86e00',
    danger: '#c93a3a',
    dangerFg: '#a82e2e',
    violet: '#7a5af5',
  },
  syntax: {
    keyword: '#0b7d85',
    string: '#1e7d32',
    comment: '#8a97a2',
    number: '#9a6200',
    function: '#6a4fd0',
    operator: '#54626e',
  },
};

/**
 * Matches the `body.vscode-high-contrast` block of assistant.css: same dark
 * palette, stronger borders, no soft signal fills (a no-op in the terminal).
 */
export const highContrastTheme: UnifiedTheme = {
  ...darkTheme,
  name: 'high-contrast',
  borders: { border: '#6fc3df', borderStrong: '#6fc3df' },
};

export const themes: Record<ThemeName, UnifiedTheme> = {
  dark: darkTheme,
  light: lightTheme,
  'high-contrast': highContrastTheme,
};

/** Resolve a theme by name; unknown or missing names fall back to dark. */
export function resolveTheme(name?: string | null): UnifiedTheme {
  if (name && name in themes) return themes[name as ThemeName];
  return darkTheme;
}

/**
 * Agent mode definitions shared with the IDE composer — same ids, labels and
 * colors as the `MODES` list in `assistantPanel.ts`.
 */
export const UNIFIED_MODES: ReadonlyArray<{ id: string; label: string; color: string }> = [
  { id: 'ask', label: 'Ask', color: '#3dced6' },
  { id: 'plan', label: 'Plan', color: '#8fd9de' },
  { id: 'build', label: 'Build', color: '#14f195' },
  { id: 'debug', label: 'Debug', color: '#ffae00' },
  { id: 'review', label: 'Review', color: '#b48cff' },
];

/** Parse `#rrggbb` into RGB channels. Throws on malformed input. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Invalid hex color: ${hex}`);
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/**
 * Map a `#rrggbb` color to the nearest xterm-256 palette index. Nearly-gray
 * colors go to the 24-step grayscale ramp (232–255), everything else to the
 * 6×6×6 color cube (16–231). Dependency-free so the TUI carries no color lib.
 */
export function hexToAnsi256(hex: string): number {
  const { r, g, b } = parseHex(hex);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 8) {
    const avg = (r + g + b) / 3;
    if (avg < 8) return 16;
    if (avg > 248) return 231;
    return 232 + Math.round(((avg - 8) / 240) * 23);
  }
  const toCube = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}
