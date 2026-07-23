#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
if ((process.env.CI || process.env.GITHUB_ACTIONS) && process.env.CAPIX_FORCE_POSTINSTALL_SMOKE !== '1') {
  process.exit(0);
}
const VERSION = require('../package.json').version;
const plat = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
const NAME = `capix-code-${VERSION}-${plat}-${arch}-unsigned`;
const RELEASE_BASE_URL = (process.env.CAPIX_RELEASE_BASE_URL || 'https://github.com/CapIX-Protocol/CapIX-Code/releases/download').replace(/\/$/, '');
const URL = `${RELEASE_BASE_URL}/v${VERSION}/${NAME}.${ext}`;
const CHECKSUM_URL = `${URL}.sha256`;
const ROOT = process.env.CAPIX_CODE_RUNTIME_DIR || path.join(os.homedir(), '.capix-code');
const TMP = path.join(os.tmpdir(), `capix-install-${VERSION}-${process.pid}`);
const archivePath = path.join(TMP, `${NAME}.${ext}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
console.log(`Capix Code v${VERSION} (${plat}-${arch})`);
execFileSync('curl', ['-fsSL', '-o', archivePath, URL], { stdio: 'inherit' });
const checksumPath = path.join(TMP, 'checksum.sha256');
execFileSync('curl', ['-fsSL', '-o', checksumPath, CHECKSUM_URL], { stdio: 'inherit' });
const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
if (expected !== actual) {
  console.error(`Checksum mismatch!`);
  process.exit(1);
}
if (process.platform === 'win32') {
  execFileSync('tar', ['-xf', archivePath, '-C', TMP], { stdio: 'inherit' });
} else {
  execFileSync('tar', ['-xzf', archivePath, '-C', TMP], { stdio: 'inherit' });
}
const src = path.join(TMP, 'customer');
if (!fs.existsSync(src)) {
  console.error('Missing customer/');
  process.exit(1);
}
// Remove the runtime-provider symlink before copying to avoid EISDIR conflicts.
// The tarball contains a symlink at runtime/node_modules/@capix/runtime-provider
// pointing to runtime/packages/runtime-provider; cpSync copies the symlink first,
// then the directory copy conflicts.
const badLink = path.join(src, 'runtime', 'node_modules', '@capix', 'runtime-provider');
if (fs.existsSync(badLink) && fs.lstatSync(badLink).isSymbolicLink()) {
  fs.rmSync(badLink, { force: true });
}
const backup = ROOT + '.bak';
const next = `${ROOT}.next-${process.pid}`;
fs.rmSync(next, { recursive: true, force: true });
fs.mkdirSync(next, { recursive: true });
for (const dir of ['bin', 'engine', 'runtime', 'config', 'mcp', 'commands']) {
  const s = path.join(src, dir);
  if (fs.existsSync(s)) fs.cpSync(s, path.join(next, dir), { recursive: true, dereference: true });
}
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const nextLauncher = path.join(next, 'bin', `capix-code${executableSuffix}`);
const nextEngine = path.join(next, 'engine', `capix-engine${executableSuffix}`);
if (!fs.existsSync(nextLauncher) || !fs.existsSync(nextEngine)) {
  console.error('The Capix Code release is missing its native launcher or engine.');
  fs.rmSync(next, { recursive: true, force: true });
  process.exit(1);
}
if (process.platform !== 'win32') {
  fs.chmodSync(nextLauncher, 0o755);
  fs.chmodSync(nextEngine, 0o755);
}
const mcpDir = path.join(next, 'mcp');
if (!fs.existsSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol'))) {
  console.error('The Capix Code release is missing its bundled MCP runtime.');
  fs.rmSync(next, { recursive: true, force: true });
  process.exit(1);
}
fs.rmSync(backup, { recursive: true, force: true });
if (fs.existsSync(ROOT)) fs.renameSync(ROOT, backup);
try {
  fs.renameSync(next, ROOT);
} catch (error) {
  if (fs.existsSync(backup) && !fs.existsSync(ROOT)) fs.renameSync(backup, ROOT);
  throw error;
}
const launcher = path.join(ROOT, 'bin', `capix-code${executableSuffix}`);
const engine = path.join(ROOT, 'engine', `capix-engine${executableSuffix}`);
const cfgDir = path.join(os.homedir(), '.config', 'capix-code');
fs.mkdirSync(cfgDir, { recursive: true });
const rt = path.join(ROOT, 'runtime');
const pu = `file://${rt}/packages/runtime-provider/src/index.ts`;
const configPath = path.join(cfgDir, 'capix-code.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        model: 'capix/auto',
        enabled_providers: ['capix'],
        plugin: [path.join(rt, 'src', 'native-bridge.ts'), path.join(rt, 'src', 'plugin.ts')],
        provider: {
          capix: {
            npm: pu,
            name: 'Capix',
            models: {
              auto: {
                name: 'Capix Auto',
                limit: { context: 128000, output: 64000 },
                api: { url: 'https://www.capix.network/api/v1', npm: pu },
              },
            },
          },
        },
      },
      null,
      2
    )
  );
}
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--force', '--sign', '-', launcher], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('codesign', ['--force', '--sign', '-', engine], { stdio: 'ignore' });
  } catch {}
}
fs.rmSync(TMP, { recursive: true, force: true });
if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
console.log(`Capix Code v${VERSION} installed. Run: capix-code login && capix-code`);
