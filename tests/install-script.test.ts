import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const script = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const customerPackager = fileURLToPath(new URL('../scripts/package-customer.sh', import.meta.url));
const legacyPackager = fileURLToPath(new URL('../scripts/package.sh', import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: (artifact: string, digest: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'capix-install-'));
  roots.push(root);
  const version = 'v1.2.3';
  const artifact = 'capix-code-1.2.3-darwin-arm64-unsigned.tar.gz';
  const release = join(root, version);
  const install = join(root, 'bin');
  const runtime = join(root, 'runtime');
  mkdirSync(release, { recursive: true });
  const payload = join(root, 'payload', 'customer', 'bin');
  mkdirSync(payload, { recursive: true });
  const bytes = '#!/bin/sh\necho capix-code-test\n';
  writeFileSync(join(payload, 'capix-code'), bytes);
  chmodSync(join(payload, 'capix-code'), 0o755);
  const archived = spawnSync('tar', [
    '-czf',
    join(release, artifact),
    '-C',
    join(root, 'payload'),
    'customer',
  ]);
  if (archived.status !== 0) throw archived.error ?? new Error('fixture archive failed');
  const archiveBytes = readFileSync(join(release, artifact));
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  writeFileSync(join(release, `${artifact}.sha256`), manifest(artifact, digest));
  return { root, version, artifact, install, runtime };
}

function run(f: ReturnType<typeof fixture>, version = f.version, env?: Record<string, string>) {
  return spawnSync('bash', [script, version], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAPIX_RELEASE_BASE_URL: `file://${f.root}`,
      CAPIX_INSTALL_DIR: f.install,
      CAPIX_CODE_RUNTIME_DIR: f.runtime,
      CAPIX_INSTALL_OS: 'darwin',
      CAPIX_INSTALL_ARCH: 'arm64',
      ...env,
    },
  });
}

describe('immutable Capix Code installer', () => {
  it('publishes portable checksum sidecars without CI workspace paths', () => {
    const customerSource = readFileSync(customerPackager, 'utf8');
    const legacySource = readFileSync(legacyPackager, 'utf8');
    expect(customerSource).toContain('"$(basename "$ARCHIVE")"');
    expect(legacySource).toContain('"$ARTIFACT_NAME.tar.gz"');
    expect(customerSource).not.toMatch(/(?:sha256sum|shasum[^\n]+) "\$ARCHIVE" > "\$ARCHIVE\.sha256"/);
    expect(legacySource).not.toMatch(/shasum[^\n]+> "\$OUTPUT_DIR\/\$ARTIFACT_NAME\.tar\.gz\.sha256"/);
  });

  it('rejects latest when no immutable stable version is pinned', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n`);
    const result = run(f, 'latest');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CAPIX_STABLE_VERSION');
  });

  it('resolves latest to the pinned immutable version and installs', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n`);
    const result = run(f, 'latest', { CAPIX_STABLE_VERSION: f.version });
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain(`Resolved latest -> ${f.version}`);
    expect(readFileSync(join(f.install, 'capix-code'), 'utf8')).toContain('capix-code-test');
  });

  it('rejects a non-semver CAPIX_STABLE_VERSION', () => {
    const f = fixture((artifact, digest) => `${digest}  ${artifact}\n`);
    const result = run(f, 'latest', { CAPIX_STABLE_VERSION: 'main' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid version');
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
    expect(result.stderr).toContain('exactly one valid SHA-256 entry');
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
