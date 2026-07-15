#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Skip in CI environments
if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('Skipping binary download in CI environment.');
  process.exit(0);
}

const PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const VERSION = '1.3.0';
const RELEASE = 'https://github.com/CapIX-Protocol/CapIX-Code/releases/download/v' + VERSION;

const installDir = path.join(os.homedir(), '.capix-code');
const binDir = path.join(installDir, 'bin');
const engineDir = path.join(installDir, 'engine');

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(engineDir, { recursive: true });

try {
  console.log('Downloading capix-code binary...');
  execSync('curl -fsSL ' + RELEASE + '/capix-code -o ' + binDir + '/capix-code', { stdio: 'inherit' });
  fs.chmodSync(path.join(binDir, 'capix-code'), 0o755);
  console.log('✓ Capix Code installed to ' + installDir);
  console.log('Run: capix-code --version');
} catch (err) {
  console.warn('⚠ Binary download failed. Download manually from:');
  console.warn('  https://github.com/CapIX-Protocol/CapIX-Code/releases');
  // Don't fail the install
  process.exit(0);
}
