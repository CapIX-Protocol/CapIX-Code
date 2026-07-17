#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('Skipping binary download in CI environment.');
  process.exit(0);
}

const VERSION = '1.6.3';
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
    for (const dir of ['bin', 'engine', 'runtime', 'config', 'mcp']) {
      const src = path.join(customerSrc, dir);
      const dst = path.join(installDir, dir);
      if (fs.existsSync(src)) {
        execSync(`rm -rf "${dst}" && cp -a "${src}" "${dst}"`, { stdio: 'inherit' });
      }
    }
    const binPath = path.join(installDir, 'bin', 'capix-code');
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }
  }

  // Install runtime dependencies (typescript is required by plugin.ts)
  const runtimeDir = path.join(installDir, 'runtime');
  if (fs.existsSync(path.join(runtimeDir, 'package.json'))) {
    console.log('Installing runtime dependencies...');
    execSync(`npm install --omit=dev --ignore-scripts`, { cwd: runtimeDir, stdio: 'inherit' });
  }

  // Install MCP dependencies if not already bundled
  const mcpDir = path.join(installDir, 'mcp');
  const mcpEntry = path.join(mcpDir, 'capix-mcp.js');
  if (!fs.existsSync(path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    console.log('Installing MCP dependencies...');
    execSync(`npm install capix-mcp@2.1.0`, { cwd: mcpDir, stdio: 'inherit' });
    // Create wrapper that shares credentials
    const mcpPkgPath = path.join(mcpDir, 'node_modules', 'capix-mcp', 'dist', 'index.js');
    if (!fs.existsSync(mcpEntry)) {
      fs.writeFileSync(mcpEntry,
        '#!/usr/bin/env node\n' +
        'const { readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");\n' +
        'const { join } = require("node:path");\n' +
        'const { homedir } = require("node:os");\n' +
        'const credPath = join(homedir(), ".capix-code", "credentials.json");\n' +
        'async function loadMcp() {\n' +
        '  require(join(homedir(), ".capix-code", "mcp", "node_modules", "capix-mcp", "dist", "index.js"));\n' +
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
    }
  }

  // Sign binaries on macOS to prevent Gatekeeper kills
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --force --sign - "${path.join(installDir, 'bin', 'capix-code')}"`, { stdio: 'ignore' });
      execSync(`codesign --force --sign - "${path.join(installDir, 'engine', 'capix-engine')}"`, { stdio: 'ignore' });
    } catch {}
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ Capix Code v${VERSION} installed to ${installDir}`);
  console.log('Run: capix-code login && capix-code');
} catch (err) {
  console.warn('⚠ Binary download failed. Download manually from:');
  console.warn('  https://github.com/CapIX-Protocol/Capix-Code/releases');
  process.exit(0);
}
