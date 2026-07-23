import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseArtifacts = resolve(process.argv[2] || 'release-artifacts');
const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const archiveName = `capix-code-${packageVersion}-${platform}-${arch}-unsigned.${extension}`;
const archive = join(releaseArtifacts, archiveName);
const checksum = `${archive}.sha256`;

if (!existsSync(archive) || !existsSync(checksum)) {
  throw new Error(`native release artifact or checksum is missing: ${archiveName}`);
}

const root = mkdtempSync(join(tmpdir(), 'capix-npm-install-smoke-'));
try {
  const stagedRelease = join(root, 'releases', `v${packageVersion}`);
  const packDir = join(root, 'pack');
  const prefix = join(root, 'prefix');
  const runtime = join(root, 'runtime');
  mkdirSync(stagedRelease, { recursive: true });
  mkdirSync(packDir, { recursive: true });
  cpSync(archive, join(stagedRelease, basename(archive)));
  cpSync(checksum, join(stagedRelease, basename(checksum)));

  const npmCache = join(root, 'npm-cache');
  execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: resolve('.'),
    env: { ...process.env, npm_config_cache: npmCache },
    stdio: 'inherit',
  });
  const meta = readdirSync(packDir).find((name) => /^capix-code-.*\.tgz$/.test(name));
  if (!meta) throw new Error('npm meta package was not created');

  const env = {
    ...process.env,
    CAPIX_FORCE_POSTINSTALL_SMOKE: '1',
    CAPIX_RELEASE_BASE_URL: pathToFileURL(join(root, 'releases')).href,
    CAPIX_CODE_RUNTIME_DIR: runtime,
    npm_config_cache: npmCache,
  };
  execFileSync(
    'npm',
    ['install', '--ignore-scripts=false', '--prefix', prefix, join(packDir, meta)],
    {
      env,
      stdio: 'inherit',
    }
  );

  const shim = join(
    prefix,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'capix-code.cmd' : 'capix-code'
  );
  if (!existsSync(shim)) throw new Error('installed npm command shim is missing');
  const run = (args) => {
    if (process.platform === 'win32') {
      execFileSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" ${args.join(' ')}`], {
        env,
        stdio: 'inherit',
      });
    } else {
      execFileSync(shim, args, { env, stdio: 'inherit' });
    }
  };
  run(['--version']);
  run(['doctor']);
  console.log(`✓ npm postinstall smoke passed for ${platform}-${arch}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
