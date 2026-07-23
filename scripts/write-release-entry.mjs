import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [version, platform, arch, archive] = process.argv.slice(2);
if (!version || !platform || !arch || !archive) process.exit(2);

const shaPattern = /^[0-9a-f]{40}$/i;
// Workflow-dispatch GITHUB_SHA identifies the dispatch ref, which is not
// necessarily the immutable release tag. Release jobs set CAPIX_SOURCE_SHA
// only after proving HEAD^{commit} equals refs/tags/<tag>^{commit}.
const githubSha = (process.env.CAPIX_SOURCE_SHA || process.env.GITHUB_SHA)?.trim();
let sourceSha;
if (githubSha) {
  if (!shaPattern.test(githubSha)) throw new Error('GITHUB_SHA must be a 40-character hexadecimal commit SHA');
  sourceSha = githubSha.toLowerCase();
} else {
  if (process.env.CI) throw new Error('GITHUB_SHA is required when generating release metadata in CI');
  sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  }).trim();
  if (!shaPattern.test(sourceSha)) throw new Error('git rev-parse returned an invalid source SHA');
}
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
