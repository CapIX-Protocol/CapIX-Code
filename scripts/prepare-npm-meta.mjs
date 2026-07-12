import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const launcher = join(root, 'bin', 'capix-code.cjs');

if (!existsSync(launcher)) {
  console.error('Capix Code npm launcher is missing.');
  process.exit(1);
}

chmodSync(launcher, 0o755);
