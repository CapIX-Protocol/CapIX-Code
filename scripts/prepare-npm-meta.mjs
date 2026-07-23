import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'capix-code.cjs');

if (!existsSync(launcher)) {
  console.error('Capix Code npm launcher is missing.');
  process.exit(1);
}

chmodSync(launcher, 0o755);
