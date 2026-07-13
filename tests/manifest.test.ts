import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const templatedManifest = join(repoRoot, 'manifest/release-manifest.json');
const validateScript = resolve(repoRoot, 'scripts/validate-manifest.mjs');
const buildScript = resolve(repoRoot, 'scripts/build-manifest.mjs');
const resolveScript = resolve(repoRoot, 'scripts/resolve-version.mjs');

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'capix-manifest-'));
  directories.push(d);
  return d;
}

const SOURCE_SHA = 'a'.repeat(40);
const GOOD_SHA = 'b'.repeat(64);

function runNode(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function fakeEntry(
  platform: string,
  opts: Partial<{ sha256: string; sizeBytes: number; artifact: string }> = {}
) {
  const artifact = opts.artifact ?? `capix-code-1.2.4-${platform}-unsigned.tar.gz`;
  return {
    schemaVersion: 1,
    product: 'capix-code',
    version: '1.2.4',
    platform,
    artifact,
    sha256: opts.sha256 ?? GOOD_SHA,
    sizeBytes: opts.sizeBytes ?? 1024,
    sourceSha: SOURCE_SHA,
    signed: false,
  };
}

function materializedManifest(plats = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
  const platforms: Record<string, unknown> = {};
  for (const p of plats) {
    platforms[p] = {
      url: `https://github.com/CapIX-Protocol/Capix-Code/releases/download/v1.2.4/capix-code-1.2.4-${p}-unsigned.tar.gz`,
      sha256: GOOD_SHA,
      signatureUrl: null,
      sizeBytes: 1024,
    };
  }
  return {
    id: 'rel_capix_code_1_2_4',
    schemaVersion: 1,
    stableVersion: 'v1.2.4',
    createdAt: '2026-07-13T00:00:00Z',
    createdBy: 'release-engineering',
    immutable: true,
    launcher: { sourceSha: SOURCE_SHA, version: '1.2.4' },
    opencode: { sourceSha: SOURCE_SHA, version: '1.17.18' },
    plugin: { sourceSha: SOURCE_SHA, version: '1.2.4' },
    provider: { sourceSha: SOURCE_SHA, version: '1.2.4' },
    acpVersion: '1',
    ipcVersion: '1',
    apiRange: { min: 'v1', max: 'v1' },
    platforms,
    sbomRef: 'https://github.com/CapIX-Protocol/Capix-Code/releases/download/v1.2.4/sbom.spdx.json',
    provenanceRef:
      'https://github.com/CapIX-Protocol/Capix-Code/releases/download/v1.2.4/provenance.json',
    signatureRef: null,
    thirdPartyNoticesRef:
      'https://github.com/CapIX-Protocol/Capix-Code/releases/download/v1.2.4/NOTICE',
    rollbackConstraints: ['retain-n-1'],
  };
}

describe('manifest: templated manifest cannot ship', () => {
  it('rejects the current checked-in templated manifest (fail-closed)', () => {
    const result = runNode(validateScript, [templatedManifest]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TEMPLATE');
    expect(result.stderr).toContain('stableVersion');
    expect(result.stderr).toContain('not publishable');
  });

  it('reports deep TEMPLATE placeholder paths', () => {
    const dir = tempDir();
    const file = join(dir, 'm.json');
    writeJson(file, {
      ...materializedManifest(),
      sbomRef: 'TEMPLATE',
      platforms: { 'darwin-arm64': { url: 'TEMPLATE' } },
    });
    const result = runNode(validateScript, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('$.sbomRef');
    expect(result.stderr).toContain('TEMPLATE');
  });
});

describe('manifest: materialized manifest is publishable', () => {
  it('accepts a fully materialized manifest', () => {
    const dir = tempDir();
    const file = join(dir, 'm.json');
    writeJson(file, materializedManifest());
    const result = runNode(validateScript, [file]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('publishable');
  });

  it('builds a real manifest from per-platform release.json entries', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
      writeJson(join(dir, `capix-code-1.2.4-${p}.release.json`), fakeEntry(p));
    }
    const out = join(dir, 'release-manifest.json');
    const result = runNode(buildScript, [
      '--entries',
      dir,
      '--base-url',
      'https://github.com/CapIX-Protocol/Capix-Code/releases/download',
      '--stable-version',
      'v1.2.4',
      '--source-sha',
      SOURCE_SHA,
      '--launcher-version',
      '1.2.4',
      '--opencode-version',
      '1.17.18',
      '--plugin-version',
      '1.2.4',
      '--provider-version',
      '1.2.4',
      '--out',
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const built = JSON.parse(readFileSync(out, 'utf8'));
    // The built manifest must itself pass validation.
    expect(runNode(validateScript, [out]).status).toBe(0);
    expect(built.stableVersion).toBe('v1.2.4');
    expect(Object.keys(built.platforms).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(built.platforms['win32-x64'].sha256).toBe(GOOD_SHA);
    expect(built.platforms['linux-x64'].sizeBytes).toBe(1024);
  });

  it('build-manifest fails closed when --require-all and a platform is missing', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'capix-code-1.2.4-darwin-arm64.release.json'), fakeEntry('darwin-arm64'));
    const result = runNode(buildScript, [
      '--entries',
      dir,
      '--base-url',
      'https://github.com/CapIX-Protocol/Capix-Code/releases/download',
      '--stable-version',
      'v1.2.4',
      '--source-sha',
      SOURCE_SHA,
      '--launcher-version',
      '1.2.4',
      '--opencode-version',
      '1.17.18',
      '--plugin-version',
      '1.2.4',
      '--provider-version',
      '1.2.4',
      '--require-all',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required platform');
  });

  it('build-manifest fails closed on a bad sha256 entry', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeJson(
      join(dir, 'capix-code-1.2.4-darwin-arm64.release.json'),
      fakeEntry('darwin-arm64', { sha256: 'nope' })
    );
    const result = runNode(buildScript, [
      '--entries',
      dir,
      '--base-url',
      'https://github.com/CapIX-Protocol/Capix-Code/releases/download',
      '--stable-version',
      'v1.2.4',
      '--source-sha',
      SOURCE_SHA,
      '--launcher-version',
      '1.2.4',
      '--opencode-version',
      '1.17.18',
      '--plugin-version',
      '1.2.4',
      '--provider-version',
      '1.2.4',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sha256');
  });
});

describe('resolve-version: latest resolves to an immutable tag', () => {
  it('accepts an explicit immutable tag', () => {
    const result = runNode(resolveScript, ['v1.2.4']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('v1.2.4');
  });

  it('rejects an explicit non-semver tag', () => {
    const result = runNode(resolveScript, ['main']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid version');
  });

  it('fails closed on latest without any resolution source', () => {
    const result = runNode(resolveScript, ['latest'], { CAPIX_STABLE_VERSION: '' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CAPIX_STABLE_VERSION');
  });

  it('resolves latest from the env pin (single source of truth)', () => {
    const result = runNode(resolveScript, ['latest'], { CAPIX_STABLE_VERSION: 'v1.2.4' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('v1.2.4');
  });

  it('rejects a malformed env pin', () => {
    const result = runNode(resolveScript, ['latest'], { CAPIX_STABLE_VERSION: 'main' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CAPIX_STABLE_VERSION');
  });

  it('resolves latest from a materialized manifest', () => {
    const dir = tempDir();
    const file = join(dir, 'm.json');
    writeJson(file, materializedManifest());
    const result = runNode(resolveScript, ['latest', '--manifest', file], {
      CAPIX_STABLE_VERSION: '',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('v1.2.4');
  });
});
