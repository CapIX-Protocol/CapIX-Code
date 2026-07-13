/**
 * Release manifest validator.
 *
 * Guarantees that a production release-manifest.json cannot ship with
 * unmaterialized TEMPLATE placeholders, zero-size artifacts, non-HTTPS URLs,
 * or missing/invalid checksums. A manifest that fails any check is rejected
 * with a concrete, actionable error — it must never be silently published.
 *
 * Usage:
 *   node scripts/validate-manifest.mjs <manifest.json> [--strict]
 *
 * Exit 0 = valid, 1 = invalid (message on stderr).
 */
import { readFileSync } from 'node:fs';

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REQUIRED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

/** Deep scan: any string field equal to "TEMPLATE" is a release blocker. */
export function findTemplatePlaceholders(value, path = '$') {
  const hits = [];
  if (typeof value === 'string') {
    if (value === 'TEMPLATE') hits.push(path);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      hits.push(...findTemplatePlaceholders(value[i], `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      hits.push(...findTemplatePlaceholders(v, `${path}.${k}`));
  }
  return hits;
}

/**
 * Validate a parsed manifest object. Returns an array of error strings
 * (empty when valid). Pure function — safe to unit-test without IO.
 */
export function validateManifest(manifest, { strict = false } = {}) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be a JSON object'];
  }

  // 1. No unmaterialized TEMPLATE placeholders anywhere.
  const placeholders = findTemplatePlaceholders(manifest);
  for (const p of placeholders) errors.push(`${p} is an unmaterialized TEMPLATE placeholder`);

  // 2. Top-level identity.
  if (typeof manifest.id !== 'string' || !manifest.id)
    errors.push('$.id must be a non-empty string');
  if (manifest.immutable !== true)
    errors.push('$.immutable must be true for a publishable manifest');
  if (typeof manifest.createdAt !== 'string' || !ISO8601.test(manifest.createdAt)) {
    errors.push('$.createdAt must be an ISO-8601 timestamp');
  }
  if (typeof manifest.stableVersion !== 'string' || !SEMVER_TAG.test(manifest.stableVersion)) {
    errors.push(
      '$.stableVersion must be an immutable vMAJOR.MINOR.PATCH tag (single source of truth)'
    );
  }

  // 3. Component provenance (launcher/opencode/plugin/provider).
  for (const comp of ['launcher', 'opencode', 'plugin', 'provider']) {
    const node = manifest[comp];
    if (!node || typeof node !== 'object') {
      errors.push(`$.${comp} must be an object`);
      continue;
    }
    if (typeof node.sourceSha !== 'string' || !SHA1.test(node.sourceSha)) {
      errors.push(`$.${comp}.sourceSha must be a 40-character lowercase hex commit SHA`);
    }
    if (typeof node.version !== 'string' || !SEMVER.test(node.version)) {
      errors.push(`$.${comp}.version must be MAJOR.MINOR.PATCH`);
    }
  }

  // 4. Platforms — every required platform present with a real artifact.
  if (!manifest.platforms || typeof manifest.platforms !== 'object') {
    errors.push('$.platforms must be an object');
  } else {
    for (const plat of REQUIRED_PLATFORMS) {
      const entry = manifest.platforms[plat];
      if (!entry || typeof entry !== 'object') {
        errors.push(`$.platforms.${plat} is missing`);
        continue;
      }
      if (typeof entry.url !== 'string' || !/^https:\/\//.test(entry.url)) {
        errors.push(`$.platforms.${plat}.url must be an https URL`);
      }
      if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
        errors.push(`$.platforms.${plat}.sha256 must be a 64-character lowercase hex SHA-256`);
      }
      if (
        typeof entry.sizeBytes !== 'number' ||
        !Number.isFinite(entry.sizeBytes) ||
        entry.sizeBytes <= 0
      ) {
        errors.push(`$.platforms.${plat}.sizeBytes must be a positive number`);
      }
      // signatureUrl may be null for unsigned artifacts, but must not be TEMPLATE.
      if (
        entry.signatureUrl !== null &&
        (typeof entry.signatureUrl !== 'string' || !/^https:\/\//.test(entry.signatureUrl))
      ) {
        errors.push(`$.platforms.${plat}.signatureUrl must be an https URL or null`);
      }
    }
    // Reject unknown platforms that snuck in (keeps the manifest honest).
    for (const plat of Object.keys(manifest.platforms)) {
      if (!REQUIRED_PLATFORMS.includes(plat)) {
        errors.push(`$.platforms.${plat} is not a recognized platform`);
      }
    }
  }

  // 5. Supply-chain refs — must be present and materialized (or explicitly null
  //    with a documented reason, in non-strict mode).
  for (const ref of ['sbomRef', 'provenanceRef', 'thirdPartyNoticesRef']) {
    const v = manifest[ref];
    if (typeof v !== 'string' || !v) errors.push(`$.${ref} must be a non-empty reference`);
  }
  if (strict) {
    if (typeof manifest.signatureRef !== 'string' || !manifest.signatureRef) {
      errors.push('$.signatureRef must be present in strict mode (signed releases)');
    }
  }

  return errors;
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/validate-manifest.mjs <manifest.json> [--strict]');
    process.exit(2);
  }
  const strict = rest.includes('--strict');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`cannot read/parse manifest ${file}: ${err.message}`);
    process.exit(1);
  }
  const errors = validateManifest(parsed, { strict });
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(
      `manifest ${file} is not publishable (${errors.length} blocker${errors.length === 1 ? '' : 's'})`
    );
    process.exit(1);
  }
  console.log(`✓ manifest ${file} is publishable`);
  process.exit(0);
}

// Run as CLI only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
