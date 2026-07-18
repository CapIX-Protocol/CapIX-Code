import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPIX_BANNER, CAPIX_STATUS, VERSION, renderBanner } from '../brand/banner.js';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** Brands that must never appear on customer-facing surfaces. */
const FORBIDDEN = /opencode|vast|hetzner|void|vscode/i;

describe('P0 branding — customer-facing identity', () => {
  it('banner version is the package version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('status/footer identity is "Capix Code" at the package version', () => {
    expect(CAPIX_STATUS.title).toBe('Capix Code');
    expect(CAPIX_STATUS.version).toBe(pkg.version);
    expect(CAPIX_STATUS.brand).toBe('Capix');
  });

  it('rendered banner shows Capix branding only', () => {
    const banner = renderBanner();
    expect(banner).toContain('Powered by Capix');
    // Strip ANSI escapes before brand scanning.
    const plain = banner.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toMatch(FORBIDDEN);
    expect(plain).not.toContain('1.18.4');
  });

  it('ASCII banner contains no predecessor brand', () => {
    expect(CAPIX_BANNER).not.toMatch(FORBIDDEN);
  });

  it('plugin and supervisor version constants track the package version', () => {
    const pluginSrc = readFileSync(resolve(root, 'src/plugin.ts'), 'utf8');
    expect(pluginSrc).toContain(`CAPIX_PLUGIN_VERSION = '${pkg.version}'`);

    // The MCP handshake identifies as capix-code at the package version —
    // no hardcoded drift (previously pinned to a stale literal).
    const supervisorSrc = readFileSync(resolve(root, 'src/mcp-supervisor.ts'), 'utf8');
    expect(supervisorSrc).toContain(
      "clientInfo: { name: 'capix-code', version: packageJson.version }"
    );
    expect(supervisorSrc).not.toMatch(/version: '\d+\.\d+\.\d+'/);
  });
});

describe('P0 version reporting — launcher/package sync', () => {
  it('launcher crate version matches package.json (what --version reports)', () => {
    const cargo = readFileSync(resolve(root, 'launcher/Cargo.toml'), 'utf8');
    const packageSection = cargo.slice(cargo.indexOf('[package]'));
    const version = packageSection.match(/^version = "([^"]+)"$/m)?.[1];
    expect(version).toBe(pkg.version);
  });

  it('launcher binary is named capix-code', () => {
    const cargo = readFileSync(resolve(root, 'launcher/Cargo.toml'), 'utf8');
    expect(cargo).toContain('name = "capix-code"');
  });

  it('npm package identity is capix-code', () => {
    expect(pkg.name).toBe('capix-code');
    expect(pkg.bin['capix-code']).toBeDefined();
  });
});
