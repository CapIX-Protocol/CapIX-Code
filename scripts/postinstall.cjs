#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
if (process.env.CI || process.env.GITHUB_ACTIONS) { process.exit(0); }
const VERSION = require('../package.json').version;
const plat = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
const NAME = `capix-code-${VERSION}-${plat}-${arch}-unsigned`;
const URL = `https://github.com/CapIX-Protocol/Capix-Code/releases/download/v${VERSION}/${NAME}.${ext}`;
const CHECKSUM_URL = `${URL}.sha256`;
const ROOT = path.join(os.homedir(), '.capix-code');
const TMP = path.join(os.tmpdir(), `capix-install-${VERSION}`);
const archivePath = path.join(TMP, `${NAME}.${ext}`);
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
console.log(`Capix Code v${VERSION} (${plat}-${arch})`);
execSync(`curl -fsSL -o "${archivePath}" "${URL}"`, { stdio: 'inherit' });
const checksumPath = path.join(TMP, 'checksum.sha256');
execSync(`curl -fsSL -o "${checksumPath}" "${CHECKSUM_URL}"`, { stdio: 'inherit' });
const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
if (expected !== actual) { console.error(`Checksum mismatch!`); process.exit(1); }
if (process.platform === 'win32') { execSync(`tar -xf "${archivePath}" -C "${TMP}"`, { stdio: 'inherit' }); }
else { execSync(`tar -xzf "${archivePath}" -C "${TMP}"`, { stdio: 'inherit' }); }
const src = path.join(TMP, 'customer');
if (!fs.existsSync(src)) { console.error('Missing customer/'); process.exit(1); }
const backup = ROOT + '.bak';
if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
if (fs.existsSync(ROOT)) fs.renameSync(ROOT, backup);
fs.mkdirSync(ROOT, { recursive: true });
for (const dir of ['bin', 'engine', 'runtime', 'config', 'mcp']) {
  const s = path.join(src, dir);
  if (fs.existsSync(s)) execSync(`cp -a "${s}" "${path.join(ROOT, dir)}"`, { stdio: 'inherit' });
}
fs.chmodSync(path.join(ROOT, 'bin', 'capix-code'), 0o755);
console.log('Installing runtime deps...');
execSync('npm install --omit=dev --ignore-scripts', { cwd: path.join(ROOT, 'runtime'), stdio: 'inherit' });
const mcpDir = path.join(ROOT, 'mcp');
if (!fs.existsSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol'))) {
  console.log('Installing MCP deps...');
  execSync('npm install capix-mcp@2.1.0', { cwd: mcpDir, stdio: 'inherit' });
  fs.writeFileSync(path.join(mcpDir, 'capix-mcp.js'), '#!/usr/bin/env node\nconst{join}=require("node:path");const{homedir}=require("node:os");require(join(homedir(),".capix-code","mcp","node_modules","capix-mcp","dist","index.js"));\n');
  fs.chmodSync(path.join(mcpDir, 'capix-mcp.js'), 0o755);
}
const cfgDir = path.join(os.homedir(), '.config', 'opencode');
fs.mkdirSync(cfgDir, { recursive: true });
const rt = path.join(ROOT, 'runtime');
const pu = `file://${rt}/packages/runtime-provider/src/index.ts`;
fs.writeFileSync(path.join(cfgDir, 'capix-code.json'), JSON.stringify({
  model: 'capix/auto', enabled_providers: ['capix'],
  plugin: [path.join(rt, 'src', 'native-bridge.ts'), path.join(rt, 'src', 'plugin.ts')],
  provider: { capix: { npm: pu, name: 'Capix', models: { auto: { name: 'Capix Auto', limit: { context: 128000, output: 64000 }, api: { url: 'https://www.capix.network/api/v1', npm: pu } } } } }
}, null, 2));
if (process.platform === 'darwin') {
  try { execSync(`codesign --force --sign - "${path.join(ROOT, 'bin', 'capix-code')}"`, { stdio: 'ignore' }); } catch {}
  try { execSync(`codesign --force --sign - "${path.join(ROOT, 'engine', 'capix-engine')}"`, { stdio: 'ignore' }); } catch {}
}
fs.rmSync(TMP, { recursive: true, force: true });
if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
console.log(`Capix Code v${VERSION} installed. Run: capix-code login && capix-code`);
