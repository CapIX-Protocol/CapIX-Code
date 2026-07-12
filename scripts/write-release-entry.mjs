import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [version, platform, arch, archive] = process.argv.slice(2);
if (!version || !platform || !arch || !archive) process.exit(2);

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8',
}).trim();
const entry = {
  schemaVersion: 1,
  product: 'capix-code',
  version,
  platform: `${platform}-${arch}`,
  artifact: basename(archive),
  sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  sizeBytes: statSync(archive).size,
  sourceSha,
  signed: false,
};

writeFileSync(
  join(dirname(archive), `capix-code-${version}-${platform}-${arch}.release.json`),
  `${JSON.stringify(entry, null, 2)}\n`
);
