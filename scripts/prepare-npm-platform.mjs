import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [platform, arch, source = 'dist/customer', destination = 'npm-platform'] =
  process.argv.slice(2);
const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-x64',
]);
const id = `${platform}-${arch}`;

if (!supported.has(id)) {
  console.error(`Unsupported Capix Code npm platform: ${id}`);
  process.exit(2);
}

const root = resolve(new URL('..', import.meta.url).pathname);
const artifact = resolve(root, source);
const output = resolve(root, destination, id);
execFileSync(join(root, 'scripts', 'assert-artifact.sh'), [artifact], { stdio: 'inherit' });
execFileSync(join(root, 'scripts', 'assert-customer-brand.sh'), [artifact], { stdio: 'inherit' });
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(artifact, join(output, 'customer'), { recursive: true });
writeFileSync(
  join(output, 'package.json'),
  `${JSON.stringify(
    {
      name: `@capix-code/${id}`,
      version: '1.2.2',
      description: `Capix Code native runtime for ${id}`,
      license: 'Apache-2.0',
      os: [platform === 'windows' ? 'win32' : platform],
      cpu: [arch],
      files: ['customer/'],
    },
    null,
    2
  )}\n`
);
console.log(output);
