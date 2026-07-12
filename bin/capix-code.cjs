#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { chmodSync, cpSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const platform = process.platform === 'win32' ? 'windows' : process.platform;
const packageName = `@capix-code/${platform}-${process.arch}`;
let root;

try {
  root = join(dirname(require.resolve(`${packageName}/package.json`)), 'customer');
} catch {
  const developmentRoot = join(__dirname, '..', 'dist', 'customer');
  if (existsSync(developmentRoot)) root = developmentRoot;
}

if (!root) {
  console.error(`Capix Code does not have a runtime for ${process.platform}-${process.arch}.`);
  console.error(`Reinstall capix-code and ensure ${packageName} is available.`);
  process.exit(1);
}

const suffix = process.platform === 'win32' ? '.exe' : '';
const launcher = join(root, 'bin', `capix-code${suffix}`);

if (!existsSync(launcher)) {
  console.error('Capix Code installation is incomplete. Reinstall the package and try again.');
  process.exit(1);
}

try {
  const runtimeProvider = join(root, 'runtime', 'node_modules', '@capix', 'runtime-provider');
  if (!existsSync(runtimeProvider)) {
    mkdirSync(join(root, 'runtime', 'node_modules', '@capix'), { recursive: true });
    cpSync(join(root, 'runtime', 'packages', 'runtime-provider'), runtimeProvider, {
      recursive: true,
    });
  }
  chmodSync(launcher, 0o755);
  chmodSync(join(root, 'engine', `capix-engine${suffix}`), 0o755);
} catch (error) {
  console.error(`Capix Code could not prepare its native runtime: ${error.message}`);
  process.exit(1);
}

const result = spawnSync(launcher, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Capix Code could not start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
