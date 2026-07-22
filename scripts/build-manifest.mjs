/**
 * Build (materialize) manifest/release-manifest.json from real per-platform
 * release entries produced by write-release-entry.mjs.
 *
 * A publishable manifest is assembled ONLY from real artifact metadata — it
 * never copies through TEMPLATE placeholders. If a required platform entry is
 * missing or carries invalid metadata, the build fails closed.
 *
 * Usage:
 *   node scripts/build-manifest.mjs \
 *     --entries release-artifacts \
 *     --base-url https://github.com/CapIX-Protocol/Capix-Code/releases/download \
 *     --stable-version v1.2.4 \
 *     --source-sha <40-hex> \
 *     --launcher-version 1.2.4 --engine-version 1.17.18 \
 *     --plugin-version 1.2.4 --provider-version 1.2.4 \
 *     [--out manifest/release-manifest.json] [--require-all]
 *
 * The stable version is the single source of truth consumed by the installer's
 * `latest` resolver and by validate-manifest.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

function parseArgs(argv) {
  const args = {
    entries: 'release-artifacts',
    out: 'manifest/release-manifest.json',
    requireAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--entries':
        args.entries = argv[++i];
        break;
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--stable-version':
        args.stableVersion = argv[++i];
        break;
      case '--source-sha':
        args.sourceSha = argv[++i];
        break;
      case '--launcher-version':
        args.launcherVersion = argv[++i];
        break;
      case '--engine-version':
        args.engineVersion = argv[++i];
        break;
      case '--plugin-version':
        args.pluginVersion = argv[++i];
        break;
      case '--provider-version':
        args.providerVersion = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--require-all':
        args.requireAll = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function requireArg(args, name) {
  const v = args[name];
  if (!v)
    throw new Error(
      `${name} is required (pass --${name.replace(/([A-Z])/g, '-$1').toLowerCase()})`
    );
  return v;
}

/** Read every capix-code-*-{platform}-{arch}.release.json in the entries dir. */
export function readReleaseEntries(entriesDir) {
  const files = readdirSync(entriesDir).filter((f) => /\.release\.json$/i.test(f));
  const entries = new Map();
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(entriesDir, f), 'utf8'));
    } catch (err) {
      throw new Error(`cannot parse ${f}: ${err.message}`);
    }
    if (parsed.product !== 'capix-code') throw new Error(`${f}: product is not capix-code`);
    const platform = parsed.platform;
    if (!platform || !REQUIRED_PLATFORMS.includes(platform)) {
      throw new Error(`${f}: unrecognized platform "${platform}"`);
    }
    if (entries.has(platform))
      throw new Error(`duplicate release entry for platform ${platform} (${f})`);
    entries.set(platform, parsed);
  }
  return entries;
}

/**
 * Build the manifest object from a map of platform -> release entry.
 * Pure function — testable without touching the filesystem.
 */
export function buildManifestFromEntries(entries, opts) {
  const {
    baseUrl,
    stableVersion,
    sourceSha,
    launcherVersion,
    engineVersion,
    pluginVersion,
    providerVersion,
  } = opts;
  const errors = [];
  if (!SEMVER_TAG.test(stableVersion ?? ''))
    errors.push('--stable-version must be vMAJOR.MINOR.PATCH');
  if (!SHA1.test(sourceSha ?? ''))
    errors.push('--source-sha must be a 40-character lowercase hex commit SHA');
  for (const [name, v] of [
    ['launcher', launcherVersion],
    ['engine', engineVersion],
    ['plugin', pluginVersion],
    ['provider', providerVersion],
  ]) {
    if (!SEMVER.test(v ?? '')) errors.push(`--${name}-version must be MAJOR.MINOR.PATCH`);
  }
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) errors.push('--base-url must be an https URL');

  const present = [...entries.keys()];
  if (opts.requireAll) {
    for (const p of REQUIRED_PLATFORMS)
      if (!entries.has(p)) errors.push(`missing required platform entry: ${p}`);
  }
  if (errors.length) throw new Error(errors.join('; '));

  const platforms = {};
  for (const p of REQUIRED_PLATFORMS) {
    const e = entries.get(p);
    if (!e) continue; // when not --require-all, only publish what exists
    if (!SHA256.test(e.sha256 ?? ''))
      throw new Error(`${p}: release entry sha256 is not a valid 64-hex digest`);
    if (typeof e.sizeBytes !== 'number' || e.sizeBytes <= 0)
      throw new Error(`${p}: release entry sizeBytes must be positive`);
    const tag = stableVersion;
    platforms[p] = {
      url: `${baseUrl}/${tag}/${e.artifact}`,
      sha256: e.sha256,
      // Unsigned artifacts ship a null signatureUrl; strict signing is a
      // separate, later gate. Never TEMPLATE.
      signatureUrl: e.signed ? `${baseUrl}/${tag}/${e.artifact}.sig` : null,
      sizeBytes: e.sizeBytes,
    };
  }

  const createdAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();

  return {
    id: `rel_capix_code_${stableVersion.slice(1).replace(/\./g, '_')}`,
    schemaVersion: 1,
    stableVersion,
    createdAt,
    createdBy: 'release-engineering',
    immutable: true,
    launcher: { sourceSha, version: launcherVersion },
    engine: { sourceSha, version: engineVersion },
    plugin: { sourceSha, version: pluginVersion },
    provider: { sourceSha, version: providerVersion },
    acpVersion: '1',
    ipcVersion: '1',
    apiRange: { min: 'v1', max: 'v1' },
    platforms,
    sbomRef: `${baseUrl}/${stableVersion}/sbom.spdx.json`,
    provenanceRef: `${baseUrl}/${stableVersion}/provenance.json`,
    signatureRef: null,
    thirdPartyNoticesRef: `${baseUrl}/${stableVersion}/NOTICE`,
    rollbackConstraints: ['retain-n-1'],
    publishedPlatforms: present,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = readReleaseEntries(args.entries);
  const manifest = buildManifestFromEntries(entries, {
    baseUrl: requireArg(args, 'baseUrl'),
    stableVersion: requireArg(args, 'stableVersion'),
    sourceSha: requireArg(args, 'sourceSha'),
    launcherVersion: requireArg(args, 'launcherVersion'),
    engineVersion: requireArg(args, 'engineVersion'),
    pluginVersion: requireArg(args, 'pluginVersion'),
    providerVersion: requireArg(args, 'providerVersion'),
    requireAll: args.requireAll,
  });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `✓ wrote ${args.out} (stable=${manifest.stableVersion}, platforms=${Object.keys(manifest.platforms).join(',')})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
