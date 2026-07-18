#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.CI || process.env.GITHUB_ACTIONS) { process.exit(0); }

const VERSION = '1.6.3';
const plat = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
const NAME = `capix-code-${VERSION}-${plat}-${arch}-unsigned`;
const URL = `https://github.com/CapIX-Protocol/Capix-Code/releases/download/v${VERSION}/${NAME}.${ext}`;
const ROOT = path.join(os.homedir(), '.capix-code');
const TMP = path.join(os.tmpdir(), 'capix-code-install');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  console.log(`Downloading capix-code v${VERSION} (${plat}-${arch})...`);
  execSync(`curl -fsSL -o "${TMP}/${NAME}.${ext}" "${URL}"`, { stdio: 'inherit' });
  execSync(`tar -xzf "${TMP}/${NAME}.${ext}" -C "${TMP}"`, { stdio: 'inherit' });

  const src = path.join(TMP, 'customer');
  if (fs.existsSync(src)) {
    for (const dir of ['bin', 'engine', 'runtime', 'config', 'mcp']) {
      const s = path.join(src, dir);
      const d = path.join(ROOT, dir);
      if (fs.existsSync(s)) execSync(`rm -rf "${d}" && cp -a "${s}" "${d}"`, { stdio: 'inherit' });
    }
    fs.chmodSync(path.join(ROOT, 'bin', 'capix-code'), 0o755);
  }

  // Install runtime deps (typescript required by plugin.ts)
  console.log('Installing runtime dependencies...');
  execSync('npm install --omit=dev --ignore-scripts', { cwd: path.join(ROOT, 'runtime'), stdio: 'inherit' });

  // Install MCP deps if not bundled
  const mcpDir = path.join(ROOT, 'mcp');
  if (!fs.existsSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol'))) {
    console.log('Installing MCP dependencies...');
    execSync('npm install capix-mcp@2.1.0', { cwd: mcpDir, stdio: 'inherit' });
    // Write MCP wrapper that does NOT refresh token (uses CAPIX_API_KEY from env)
    fs.writeFileSync(path.join(mcpDir, 'capix-mcp.js'),
      '#!/usr/bin/env node\n' +
      'const { join } = require("node:path");\n' +
      'const { homedir } = require("node:os");\n' +
      'require(join(homedir(), ".capix-code", "mcp", "node_modules", "capix-mcp", "dist", "index.js"));\n'
    );
    fs.chmodSync(path.join(mcpDir, 'capix-mcp.js'), 0o755);
  }

  // Create config at the path the engine ACTUALLY reads
  // The core package uses ~/.config/opencode/ (not capix-code)
  const cfgDir = path.join(os.homedir(), '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  const rtDir = path.join(ROOT, 'runtime');
  const providerUrl = `file://${rtDir}/packages/runtime-provider/src/index.ts`;
  const apiBase = 'https://www.capix.network/api/v1';
  
  const config = {
    model: 'capix/auto',
    enabled_providers: ['capix'],
    plugin: [
      path.join(rtDir, 'src', 'native-bridge.ts'),
      path.join(rtDir, 'src', 'plugin.ts')
    ],
    provider: {
      capix: {
        npm: providerUrl,
        name: 'Capix',
        models: {
          auto: {
            name: 'Capix Auto (smart route)',
            limit: { context: 128000, output: 64000 },
            api: { url: apiBase, npm: providerUrl }
          }
        }
      }
    }
  };
  fs.writeFileSync(path.join(cfgDir, 'capix-code.json'), JSON.stringify(config, null, 2));

  // Sign on macOS
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --force --sign - "${path.join(ROOT, 'bin', 'capix-code')}"`, { stdio: 'ignore' });
      execSync(`codesign --force --sign - "${path.join(ROOT, 'engine', 'capix-engine')}"`, { stdio: 'ignore' });
    } catch {}
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`✓ Capix Code v${VERSION} installed`);
  console.log('Run: capix-code login && capix-code');
} catch (err) {
  console.warn('Install failed. Download manually from https://github.com/CapIX-Protocol/Capix-Code/releases');
  process.exit(0);
}
