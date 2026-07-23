#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { chmodSync, cpSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const suffix = process.platform === 'win32' ? '.exe' : '';

// Look for the customer runtime in these locations:
// 1. npm global install: node_modules/capix-code/dist/customer
// 2. Local dev: dist/customer
// 3. Home directory: ~/.capix-code (from postinstall binary download)
const { homedir } = require('node:os');
const candidates = [
  process.env.CAPIX_CODE_RUNTIME_DIR,
  join(__dirname, '..', 'dist', 'customer'),
  join(homedir(), '.capix-code'),
].filter(Boolean);

let root = null;
for (const candidate of candidates) {
  const launcher = join(candidate, 'bin', `capix-code${suffix}`);
  if (existsSync(launcher)) {
    root = candidate;
    break;
  }
}

if (!root) {
  console.error('Capix Code installation is incomplete. Reinstall the package and try again.');
  console.error('If this persists, download the full binary from:');
  console.error('  https://github.com/CapIX-Protocol/Capix-Code/releases');
  process.exit(1);
}

const launcher = join(root, 'bin', `capix-code${suffix}`);
const engine = join(root, 'engine', `capix-engine${suffix}`);

if (!existsSync(launcher)) {
  console.error('Capix Code installation is incomplete. Reinstall the package and try again.');
  process.exit(1);
}

try {
  const runtimeProvider = join(root, 'runtime', 'node_modules', '@capix', 'runtime-provider');
  if (!existsSync(runtimeProvider) && existsSync(join(root, 'runtime', 'packages', 'runtime-provider'))) {
    mkdirSync(join(root, 'runtime', 'node_modules', '@capix'), { recursive: true });
    cpSync(join(root, 'runtime', 'packages', 'runtime-provider'), runtimeProvider, {
      recursive: true,
    });
  }
  chmodSync(launcher, 0o755);
  if (existsSync(engine)) chmodSync(engine, 0o755);
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
