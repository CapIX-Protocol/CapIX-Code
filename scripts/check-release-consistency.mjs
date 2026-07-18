import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageVersion = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8')
).version;
const expected = process.argv[2] || packageVersion;
const runtimeVersion = JSON.parse(
  await readFile(resolve(root, 'config/runtime-package.json'), 'utf8')
).version;
const providerVersion = JSON.parse(
  await readFile(resolve(root, 'packages/runtime-provider/package.json'), 'utf8')
).version;
const cargo = await readFile(resolve(root, 'launcher/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const releaseVersion = JSON.parse(
  await readFile(resolve(root, 'release/version.json'), 'utf8')
).version;
const pluginSource = await readFile(resolve(root, 'src/plugin.ts'), 'utf8');
const pluginVersion = pluginSource.match(/CAPIX_PLUGIN_VERSION\s*=\s*'([^']+)'/)?.[1];
const launcherSource = await readFile(resolve(root, 'launcher/src/main.rs'), 'utf8');
const launcherFallback = launcherSource.match(/"capix-code-([0-9]+\.[0-9]+\.[0-9]+)"\.to_string\(\)/)?.[1];
const aiProviderSource = await readFile(resolve(root, 'src/ai-sdk-provider.ts'), 'utf8');
const aiClientVersion = aiProviderSource.match(/clientVersion:\s*'([^']+)'/)?.[1];
const aiPluginVersion = aiProviderSource.match(/pluginVersion:\s*'([^']+)'/)?.[1];

const versions = {
  packageVersion,
  runtimeVersion,
  providerVersion,
  cargoVersion,
  releaseVersion,
  pluginVersion,
  launcherFallback,
  aiClientVersion,
  aiPluginVersion,
};
const drift = Object.entries(versions).filter(([, value]) => value !== expected);
if (drift.length) {
  console.error(`Capix Code release version drift (expected ${expected}):`);
  for (const [name, value] of drift) console.error(`  ${name}: ${value}`);
  process.exit(1);
}
console.log(`✓ Capix Code release identity is consistent at ${expected}`);
