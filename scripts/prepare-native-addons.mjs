import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') process.exit(0);

const roots = (process.argv.slice(2).length ? process.argv.slice(2) : ['node_modules'])
  .map((value) => resolve(value));

function* nativeAddons(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* nativeAddons(path);
    else if (entry.isFile() && entry.name.endsWith('.node')) yield path;
  }
}

let count = 0;
for (const root of roots) {
  for (const addon of nativeAddons(root)) {
    const result = spawnSync('codesign', ['--force', '--sign', '-', addon], {
      stdio: 'ignore',
    });
    if (result.status !== 0) {
      console.error(`Could not prepare native macOS add-on: ${addon}`);
      process.exit(result.status || 1);
    }
    count += 1;
  }
}
console.log(`✓ prepared ${count} native macOS add-on${count === 1 ? '' : 's'}`);
