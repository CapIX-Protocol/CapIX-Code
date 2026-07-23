import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('final npm customer install smoke', () => {
  it.runIf(process.platform !== 'win32')(
    'runs postinstall in CI when the release gate explicitly forces it',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'capix-npm-smoke-fixture-'));
      roots.push(root);
      const artifacts = join(root, 'artifacts');
      const customer = join(root, 'payload', 'customer');
      const bin = join(customer, 'bin', 'capix-code');
      const engine = join(customer, 'engine', 'capix-engine');
      mkdirSync(join(customer, 'mcp', 'node_modules', '@modelcontextprotocol'), {
        recursive: true,
      });
      mkdirSync(join(customer, 'bin'), { recursive: true });
      mkdirSync(join(customer, 'engine'), { recursive: true });
      mkdirSync(artifacts, { recursive: true });
      const executable = '#!/bin/sh\necho "Capix Code 2.4.12"\nexit 0\n';
      writeFileSync(bin, executable);
      writeFileSync(engine, executable);
      chmodSync(bin, 0o755);
      chmodSync(engine, 0o755);

      const platform = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const name = `capix-code-2.4.12-${platform}-${arch}-unsigned.tar.gz`;
      const archive = join(artifacts, name);
      const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'customer']);
      expect(packed.status, packed.stderr?.toString()).toBe(0);
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
      writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);

      const result = spawnSync('node', [resolve('scripts/smoke-npm-install.mjs'), artifacts], {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true' },
        timeout: 60_000,
      });
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('npm postinstall smoke passed');
    },
    90_000
  );
});
