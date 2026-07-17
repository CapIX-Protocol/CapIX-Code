#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('Skipping binary download in CI environment.');
  process.exit(0);
}

const VERSION = '1.5.7';
const PLATFORM_MAP = { darwin: 'darwin', linux: 'linux', win32: 'win32' };
const ARCH_MAP = { arm64: 'arm64', x64: 'x64' };
const platform = PLATFORM_MAP[process.platform] || 'linux';
const arch = ARCH_MAP[process.arch] || 'x64';
const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
const NAME = `capix-code-${VERSION}-${platform}-${arch}-unsigned`;
const RELEASE = `https://github.com/CapIX-Protocol/Capix-Code/releases/download/v${VERSION}/${NAME}.${ext}`;

const installDir = path.join(os.homedir(), '.capix-code');
const tmpDir = path.join(os.tmpdir(), 'capix-code-install');

fs.mkdirSync(installDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

try {
  console.log(`Downloading capix-code v${VERSION} (${platform}-${arch})...`);
  const archivePath = path.join(tmpDir, `${NAME}.${ext}`);
  execSync(`curl -fsSL -o "${archivePath}" "${RELEASE}"`, { stdio: 'inherit' });

  if (process.platform === 'win32') {
    execSync(`tar -xf "${archivePath}" -C "${tmpDir}"`, { stdio: 'inherit' });
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: 'inherit' });
  }

  const customerSrc = path.join(tmpDir, 'customer');
  if (fs.existsSync(customerSrc)) {
    for (const dir of ['bin', 'engine', 'runtime', 'config']) {
      const src = path.join(customerSrc, dir);
      const dst = path.join(installDir, dir);
      if (fs.existsSync(src)) {
        execSync(`cp -a "${src}" "${dst}"`, { stdio: 'inherit' });
      }
    }
    const binPath = path.join(installDir, 'bin', 'capix-code');
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }
  }

  // Install MCP server from npm
  const mcpDir = path.join(installDir, 'mcp');
  const mcpEntry = path.join(mcpDir, 'capix-mcp.js');
  if (!fs.existsSync(mcpEntry)) {
    console.log('Installing capix-mcp server from npm...');
    fs.mkdirSync(mcpDir, { recursive: true });
    execSync(`npm install capix-mcp@2.1.0`, { cwd: mcpDir, stdio: 'inherit' });
    // Create entry point wrapper that shares credentials with capix-code
    const mcpPkgPath = path.join(mcpDir, 'node_modules', 'capix-mcp', 'dist', 'index.js');
    fs.writeFileSync(mcpEntry,
      '#!/usr/bin/env node\n' +
      'const { readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");\n' +
      'const { join } = require("node:path");\n' +
      'const { homedir } = require("node:os");\n' +
      'const credPath = join(homedir(), ".capix-code", "credentials.json");\n' +
      'async function loadMcp() {\n' +
      '  const mcpPath = join(homedir(), ".capix-code", "mcp", "node_modules", "capix-mcp", "dist", "index.js");\n' +
      `  require('${mcpPkgPath}');\n` +
      '}\n' +
      '(async () => {\n' +
      '  try {\n' +
      '    if (existsSync(credPath)) {\n' +
      '      const creds = JSON.parse(readFileSync(credPath, "utf8"));\n' +
      '      const rt = creds["capix-code:oauth-refresh-token"];\n' +
      '      if (rt) {\n' +
      '        const res = await fetch("https://www.capix.network/oauth/token", {\n' +
      '          method: "POST",\n' +
      '          headers: { "Content-Type": "application/x-www-form-urlencoded" },\n' +
      '          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: "capix-code" }).toString(),\n' +
      '        });\n' +
      '        const body = await res.json();\n' +
      '        if (body.access_token) {\n' +
      '          process.env.CAPIX_API_KEY = body.access_token;\n' +
      '          creds["capix-code:oauth-refresh-token"] = body.refresh_token;\n' +
      '          writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });\n' +
      '          chmodSync(credPath, 0o600);\n' +
      '        }\n' +
      '      }\n' +
      '    }\n' +
      '  } catch {}\n' +
      '  loadMcp();\n' +
      '})();\n'
    );
    fs.chmodSync(mcpEntry, 0o755);
    console.log('✓ capix-mcp installed with shared credentials');
  }

  // Always update the MCP wrapper (in case credentials path changed)
  const existingMcp = path.join(mcpDir, 'capix-mcp.js');
  if (fs.existsSync(existingMcp) && !fs.existsSync(path.join(mcpDir, 'node_modules', 'capix-mcp'))) {
    // Reinstall if node_modules is missing
    execSync(`npm install capix-mcp@2.1.0`, { cwd: mcpDir, stdio: 'inherit' });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ Capix Code v${VERSION} installed to ${installDir}`);
  console.log('Run: capix-code --version');
} catch (err) {
  console.warn('⚠ Binary download failed. Download manually from:');
  console.warn('  https://github.com/CapIX-Protocol/Capix-Code/releases');
  process.exit(0);
}
