import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const script = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: (artifact: string, digest: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'capix-install-'));
  roots.push(root);
  const version = 'v1.2.3';
  const artifact = 'capix-code-darwin-arm64';
  const release = join(root, version);
  const install = join(root, 'bin');
  mkdirSync(release, { recursive: true });
  const bytes = '#!/bin/sh\necho capix-code-test\n';
  writeFileSync(join(release, artifact), bytes);
  chmodSync(join(release, artifact), 0o755);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(release, 'checksums.txt'), manifest(artifact, digest));
  return { root, version, artifact, install };
}

function run(f: ReturnType<typeof fixture>, version = f.version) {
  return spawnSync('bash', [script, version], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAPIX_RELEASE_BASE_URL: `file://${f.root}`,
      CAPIX_INSTALL_DIR: f.install,
      CAPIX_INSTALL_OS: 'darwin',
      CAPIX_INSTALL_ARCH: 'arm64',
    },
  });
}

describe('immutable Capix Code installer', () => {
  it('rejects latest versions before downloading', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n`);
    const result = run(f, 'latest');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('immutable release version');
  });

  it('installs only when the exact artifact checksum matches', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n`);
    const result = run(f);
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(readFileSync(join(f.install, 'capix-code'), 'utf8')).toContain('capix-code-test');
  });

  it('rejects a checksum for a similarly named artifact', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}-debug\n`);
    const result = run(f);
    expect(
      result.status,
      `stdout=${result.stdout}\nstderr=${result.stderr}\nerror=${result.error?.message ?? 'none'}`
    ).toBe(1);
    expect(result.stderr).toContain('exactly one SHA-256 entry');
  });

  it('rejects duplicate exact entries', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n${digest}  ${artifact}\n`);
    const result = run(f);
    expect(
      result.status,
      `stdout=${result.stdout}\nstderr=${result.stderr}\nerror=${result.error?.message ?? 'none'}`
    ).toBe(1);
  });

  it('rejects checksum mismatches', () => {
    const f = fixture((artifact) => `${'0'.repeat(64)}  ${artifact}\n`);
    const result = run(f);
    expect(
      result.status,
      `stdout=${result.stdout}\nstderr=${result.stderr}\nerror=${result.error?.message ?? 'none'}`
    ).toBe(1);
    expect(result.stderr).toContain('checksum verification failed');
  });
});
