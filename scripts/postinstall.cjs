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

const VERSION = '1.4.2';
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
    // Copy bin/ and engine/ and runtime/ to ~/.capix-code
    for (const dir of ['bin', 'engine', 'runtime']) {
      const src = path.join(customerSrc, dir);
      const dst = path.join(installDir, dir);
      if (fs.existsSync(src)) {
        execSync(`cp -a "${src}" "${dst}"`, { stdio: 'inherit' });
      }
    }
    // Ensure bin is executable
    const binPath = path.join(installDir, 'bin', 'capix-code');
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`✓ Capix Code v${VERSION} installed to ${installDir}`);
  console.log('Run: capix-code --version');
} catch (err) {
  console.warn('⚠ Binary download failed. Download manually from:');
  console.warn('  https://github.com/CapIX-Protocol/Capix-Code/releases');
  process.exit(0);
}
