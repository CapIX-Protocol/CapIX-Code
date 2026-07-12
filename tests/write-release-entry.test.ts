import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function invoke(env: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-release-entry-'));
  directories.push(directory);
  const archive = join(directory, 'artifact.zip');
  writeFileSync(archive, 'artifact');
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/write-release-entry.mjs'), '1.2.2', 'win32', 'x64', archive],
    { env: { ...process.env, ...env }, encoding: 'utf8' }
  );
  return { directory, result };
}

describe('write-release-entry CI provenance', () => {
  it('uses validated GITHUB_SHA without requiring git on PATH', () => {
    const sha = 'a'.repeat(40);
    const { directory, result } = invoke({ CI: 'true', GITHUB_SHA: sha, PATH: '' });
    expect(result.status).toBe(0);
    const entry = JSON.parse(
      readFileSync(join(directory, 'capix-code-1.2.2-win32-x64.release.json'), 'utf8')
    );
    expect(entry.sourceSha).toBe(sha);
  });

  it('fails closed in CI when GITHUB_SHA is missing or malformed', () => {
    expect(invoke({ CI: 'true', GITHUB_SHA: '', PATH: '' }).result.stderr).toContain(
      'GITHUB_SHA is required'
    );
    expect(invoke({ CI: 'true', GITHUB_SHA: 'not-a-sha', PATH: '' }).result.stderr).toContain(
      '40-character hexadecimal'
    );
  });
});
