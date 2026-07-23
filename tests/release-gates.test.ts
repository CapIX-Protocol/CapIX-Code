import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release identity gates', () => {
  it('keeps packaged MCP tool registration available before login', () => {
    const source = readFileSync(resolve('scripts/build.sh'), 'utf8');
    expect(source).toContain('if (!process.env.CAPIX_API_KEY)');
    expect(source).toContain('cpxk_broker_pending');
    expect(source).toContain('if (response.status !== 401) return response');
    expect(source).toContain('const token = await brokerToken()');
  });

  it('includes the product-coupled agent runtime in consistency enforcement', () => {
    const source = readFileSync(resolve('scripts/check-release-consistency.mjs'), 'utf8');
    expect(source).toContain('packages/agent-runtime/package.json');
    expect(source).toContain('agentRuntimeVersion');
    expect(source).toContain('agentRuntimeReportedVersion');

    const result = spawnSync('node', ['scripts/check-release-consistency.mjs', '2.4.17'], {
      cwd: resolve('.'),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts an annotated tag only when it peels to the checked-out commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'capix-release-source-'));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 'release-test@capix.network');
    git('config', 'user.name', 'Capix Release Test');
    writeFileSync(join(root, 'release.txt'), 'one\n');
    git('add', 'release.txt');
    git('commit', '-qm', 'release source');
    git('tag', '-a', 'v1.2.3', '-m', 'v1.2.3');

    const script = resolve('scripts/verify-release-source.sh');
    const pass = spawnSync('bash', [script, 'v1.2.3'], { cwd: root, encoding: 'utf8' });
    expect(pass.status, pass.stderr).toBe(0);

    writeFileSync(join(root, 'release.txt'), 'two\n');
    git('add', 'release.txt');
    git('commit', '-qm', 'post-tag change');
    const fail = spawnSync('bash', [script, 'v1.2.3'], { cwd: root, encoding: 'utf8' });
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain('does not match');
  });
});
