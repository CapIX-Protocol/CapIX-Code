import { describe, expect, it } from 'vitest';
import {
  UNIFIED_MODES,
  darkTheme,
  hexToAnsi256,
  highContrastTheme,
  lightTheme,
  paint,
  parseHex,
  relativeTime,
  renderComposer,
  renderSessionList,
  renderStatusBar,
  renderToolCard,
  resolveTheme,
  stripAnsi,
  truncate,
  visibleWidth,
} from '../src/tui/index.js';

describe('unified theme — tokens mirror assistant.css', () => {
  it('dark theme carries the webview :root values', () => {
    expect(darkTheme.surfaces.bg).toBe('#0a0d10');
    expect(darkTheme.signals.accent).toBe('#3dced6');
    expect(darkTheme.signals.success).toBe('#14f195');
    expect(darkTheme.signals.warning).toBe('#ffae00');
    expect(darkTheme.signals.danger).toBe('#ff6464');
    expect(darkTheme.text.fg).toBe('#e6edf2');
    expect(darkTheme.syntax.keyword).toBe('#7ee0e6');
  });

  it('light theme matches the body.vscode-light remap', () => {
    expect(lightTheme.surfaces.bg).toBe('#f7f9fa');
    expect(lightTheme.signals.accent).toBe('#0e9aa3');
    expect(lightTheme.signals.success).toBe('#0a9d5f');
    expect(lightTheme.text.fg).toBe('#1c2733');
  });

  it('high-contrast keeps the dark palette with stronger borders', () => {
    expect(highContrastTheme.borders.border).toBe('#6fc3df');
    expect(highContrastTheme.signals.accent).toBe(darkTheme.signals.accent);
  });

  it('resolveTheme falls back to dark for unknown names', () => {
    expect(resolveTheme('light').name).toBe('light');
    expect(resolveTheme('high-contrast').name).toBe('high-contrast');
    expect(resolveTheme('nope').name).toBe('dark');
    expect(resolveTheme().name).toBe('dark');
  });

  it('mode list matches the IDE composer MODES', () => {
    expect(UNIFIED_MODES.map((m) => m.id)).toEqual(['ask', 'plan', 'build', 'debug', 'review']);
    expect(UNIFIED_MODES.map((m) => m.color)).toEqual([
      '#3dced6',
      '#8fd9de',
      '#14f195',
      '#ffae00',
      '#b48cff',
    ]);
  });
});

describe('unified theme — hex to xterm-256 mapping', () => {
  it('parses hex colors with and without the leading #', () => {
    expect(parseHex('#3dced6')).toEqual({ r: 61, g: 206, b: 214 });
    expect(parseHex('ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(() => parseHex('#12345')).toThrow();
  });

  it('maps pure colors into the 6x6x6 cube', () => {
    expect(hexToAnsi256('#ff0000')).toBe(196);
    expect(hexToAnsi256('#00ff00')).toBe(46);
    expect(hexToAnsi256('#0000ff')).toBe(21);
  });

  it('maps near-grays to the grayscale ramp and the extremes to 16/231', () => {
    expect(hexToAnsi256('#000000')).toBe(16);
    expect(hexToAnsi256('#ffffff')).toBe(231);
    expect(hexToAnsi256('#808080')).toBe(244);
  });

  it('maps the brand accent deterministically', () => {
    expect(hexToAnsi256(darkTheme.signals.accent)).toBe(80);
  });
});

describe('ansi helpers', () => {
  it('paint wraps text in an SGR sequence that stripAnsi removes', () => {
    const styled = paint('hello', '#ff0000');
    expect(styled).toBe('\u001b[38;5;196mhello\u001b[0m');
    expect(stripAnsi(styled)).toBe('hello');
    expect(visibleWidth(styled)).toBe(5);
  });

  it('truncate clips to the visible budget with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(truncate('abcdef', 1)).toBe('…');
    expect(truncate('abcdef', 0)).toBe('');
  });
});

describe('status bar (IDE assistant header)', () => {
  it('renders the brand line and the indicator row', () => {
    const [header, indicators] = renderStatusBar({
      project: 'capix',
      mode: 'build',
      model: 'capix/auto',
      connection: 'online',
    });
    expect(stripAnsi(header)).toBe('▛ Capix ●');
    expect(stripAnsi(indicators)).toBe('capix · ● build · capix/auto');
  });

  it('colors the connection dot by engine state', () => {
    const online = renderStatusBar({ mode: 'ask', model: 'auto', connection: 'online' })[0];
    const offline = renderStatusBar({ mode: 'ask', model: 'auto', connection: 'offline' })[0];
    // success #14f195 → 49, warning #ffae00 → 214
    expect(online).toContain('38;5;49m');
    expect(offline).toContain('38;5;214m');
  });

  it('shows optional git and file indicators and honors width', () => {
    const wide = renderStatusBar(
      {
        project: 'capix',
        mode: 'plan',
        model: 'capix/auto',
        connection: 'working',
        git: 'main',
        file: 'components.ts',
        width: 60,
      },
      lightTheme
    );
    expect(stripAnsi(wide[1])).toContain('main');
    expect(stripAnsi(wide[1])).toContain('components.ts');

    const narrow = renderStatusBar({
      project: 'capix',
      mode: 'plan',
      model: 'capix/auto',
      connection: 'working',
      git: 'main',
      file: 'components.ts',
      width: 40,
    });
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe('session list (IDE session history)', () => {
  const now = Date.parse('2026-07-18T12:00:00Z');
  const sessions = [
    { id: 'a', title: 'Fix routing retries', updatedAt: '2026-07-18T11:55:00Z', messageCount: 12 },
    { id: 'b', title: 'Refactor deploy wizard', updatedAt: '2026-07-18T09:00:00Z' },
  ];

  it('marks the active session and shows relative stamps', () => {
    const rows = renderSessionList(sessions, { activeId: 'a', now });
    expect(stripAnsi(rows[0])).toBe('▸ Fix routing retries (12) 5m ago');
    expect(stripAnsi(rows[1])).toBe('  Refactor deploy wizard 3h ago');
    // Active row is tinted accent (#3dced6 → 80).
    expect(rows[0]).toContain('38;5;80m');
  });

  it('truncates long titles to the row width', () => {
    const rows = renderSessionList(
      [{ id: 'x', title: 'a very long session title that will not fit', updatedAt: '2026-07-18T11:00:00Z' }],
      { now, width: 30 }
    );
    expect(visibleWidth(rows[0])).toBeLessThanOrEqual(30);
    expect(stripAnsi(rows[0])).toContain('…');
  });

  it('relativeTime covers the compact buckets', () => {
    expect(relativeTime('2026-07-18T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-07-18T11:40:00Z', now)).toBe('20m ago');
    expect(relativeTime('2026-07-18T05:00:00Z', now)).toBe('7h ago');
    expect(relativeTime('2026-07-15T12:00:00Z', now)).toBe('3d ago');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('tool cards (IDE tool timeline)', () => {
  it('renders a running card with the braille spinner and accent name', () => {
    const [header] = renderToolCard(
      { name: 'capix_deploy', label: 'deploying api to us-east', state: 'running' },
      { spinnerFrame: 0 }
    );
    expect(stripAnsi(header)).toBe('⠋ capix_deploy deploying api to us-east  running ');
  });

  it('renders success and error states with status semantics', () => {
    const ok = renderToolCard({ name: 'read_file', state: 'success' })[0];
    const bad = renderToolCard({ name: 'run_tests', state: 'error' })[0];
    expect(stripAnsi(ok)).toContain('✓ read_file  done ');
    expect(stripAnsi(bad)).toContain('✗ run_tests  failed ');
    // success #14f195 → 49, danger #ff6464 → 210
    expect(ok).toContain('38;5;49m');
    expect(bad).toContain('38;5;210m');
  });

  it('shows the output body only when expanded, capped with an overflow note', () => {
    const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const collapsed = renderToolCard({ name: 'run_tests', state: 'success', output });
    expect(collapsed).toHaveLength(1);

    const expanded = renderToolCard(
      { name: 'run_tests', state: 'success', output, expanded: true },
      { maxOutputLines: 8 }
    );
    expect(stripAnsi(expanded[2])).toBe('line 1');
    expect(stripAnsi(expanded[9])).toBe('line 8');
    expect(stripAnsi(expanded[10])).toBe('… 4 more lines');
  });
});

describe('composer (IDE composer)', () => {
  it('renders the mode pill row with the active mode highlighted', () => {
    const lines = renderComposer({ mode: 'build' });
    const modes = stripAnsi(lines[0]);
    for (const label of ['Ask', 'Plan', 'Build', 'Debug', 'Review']) {
      expect(modes).toContain(label);
    }
    // Active pill is bold accent: SGR starts with 1;38;5;80.
    expect(lines[0]).toContain('1;38;5;80mBuild');
  });

  it('renders attachment chips above the input box', () => {
    const lines = renderComposer({ mode: 'ask', attachments: ['src/app.ts', 'README.md'] });
    expect(stripAnsi(lines[1])).toContain(' src/app.ts × ');
    expect(stripAnsi(lines[1])).toContain(' README.md × ');
  });

  it('draws the bordered box with placeholder, model and send affordance', () => {
    const lines = renderComposer({ mode: 'ask', model: 'capix/auto', width: 50 });
    const plain = lines.map(stripAnsi);
    expect(plain[1]).toBe('╭' + '─'.repeat(48) + '╮');
    expect(plain[2]).toContain('Ask, plan, build…');
    expect(plain[3]).toContain('capix/auto');
    expect(plain[3]).toContain('↑');
    expect(plain[4]).toBe('╰' + '─'.repeat(48) + '╯');
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
  });

  it('shows the session cost and swaps to the stop affordance when busy', () => {
    const busy = renderComposer({
      mode: 'build',
      busy: true,
      cost: { amountMinor: '129900', currency: 'USD', scale: 2 },
    });
    const meta = stripAnsi(busy[busy.length - 1]);
    expect(meta).toContain('USD 1299.00');
    expect(meta).toContain('⏎ send · ⇧⏎ newline');
    expect(stripAnsi(busy[3])).toContain('■ Stop');
  });

  it('respects the light theme palette', () => {
    const lines = renderComposer({ mode: 'ask' }, lightTheme);
    // light accent #0e9aa3 → 37
    expect(lines[0]).toContain('38;5;37m');
  });
});
