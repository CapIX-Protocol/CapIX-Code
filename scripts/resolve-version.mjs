/**
 * Resolve a requested version ("latest", empty, or an explicit tag) to an
 * immutable vMAJOR.MINOR.PATCH tag.
 *
 * "latest" is permitted ONLY by resolving it to a concrete immutable version
 * before any download — never by blindly trusting mutable content. Resolution
 * sources, in priority order:
 *
 *   1. CAPIX_STABLE_VERSION env (deterministic, offline, release-pinned)
 *   2. a materialized manifest's stableVersion (single source of truth)
 *   3. the GitHub releases API /releases/latest tag_name (--allow-network only)
 *
 * If none resolves, the script fails closed (exit 2) so the installer never
 * proceeds with an unbounded/mutable version.
 *
 * Usage:
 *   node scripts/resolve-version.mjs [latest|<tag>] [--manifest manifest/release-manifest.json] [--allow-network]
 *
 * Prints the resolved immutable tag to stdout.
 */
import { readFileSync } from 'node:fs';

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * Resolve a version request. Pure (no IO except the optional fetch passed in)
 * so it is unit-testable without a network.
 *
 * @param {string|null} request   "latest", "" or null
 * @param {object} ctx
 * @param {string|undefined} ctx.envStable  CAPIX_STABLE_VERSION value
 * @param {object|undefined} ctx.manifest   parsed manifest with stableVersion
 * @param {(() => Promise<string|null>)|undefined} ctx.fetchLatestTag  network resolver
 * @returns {{tag:string, source:string}}
 */
export function resolveVersion(request, ctx) {
  const requested = (request ?? '').trim();
  // An explicit immutable tag is always accepted as-is.
  if (requested && requested !== 'latest') {
    if (!SEMVER_TAG.test(requested)) {
      throw new Error(`invalid version '${requested}' (expected vMAJOR.MINOR.PATCH)`);
    }
    return { tag: requested, source: 'explicit' };
  }
  // latest / empty → resolve to an immutable tag.
  if (ctx.envStable) {
    if (!SEMVER_TAG.test(ctx.envStable)) {
      throw new Error(`CAPIX_STABLE_VERSION is not a vMAJOR.MINOR.PATCH tag: '${ctx.envStable}'`);
    }
    return { tag: ctx.envStable, source: 'env' };
  }
  if (
    ctx.manifest &&
    typeof ctx.manifest.stableVersion === 'string' &&
    SEMVER_TAG.test(ctx.manifest.stableVersion)
  ) {
    return { tag: ctx.manifest.stableVersion, source: 'manifest' };
  }
  // Network resolver is invoked lazily by the caller (kept out of the pure
  // path so tests never touch the network).
  return null; // signals "caller may try network, else fail closed"
}

/** Read a manifest file and return its parsed object, or null if unreadable. */
export function loadManifest(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** GitHub releases API resolver. Returns the latest tag_name or null. */
async function githubLatest(repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'capix-code-installer' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const tag = body?.tag_name;
    return typeof tag === 'string' && SEMVER_TAG.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const request = argv.find((a) => !a.startsWith('--')) ?? '';
  const manifestPath = argv[argv.indexOf('--manifest') + 1];
  const allowNetwork = argv.includes('--allow-network');
  const repo = process.env.CAPIX_RELEASE_REPO ?? 'CapIX-Protocol/Capix-Code';

  const ctx = {
    envStable: process.env.CAPIX_STABLE_VERSION?.trim() || undefined,
    manifest: loadManifest(manifestPath),
  };
  const resolved = resolveVersion(request, ctx);
  if (resolved) {
    process.stdout.write(resolved.tag);
    process.exit(0);
  }
  if (allowNetwork) {
    const tag = await githubLatest(repo);
    if (tag) {
      process.stdout.write(tag);
      process.exit(0);
    }
  }
  console.error(
    `ERROR: cannot resolve '${request || 'latest'}' to an immutable version. ` +
      `Set CAPIX_STABLE_VERSION (e.g. v1.2.3) or pass --manifest <path> [--allow-network].`
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ? `ERROR: ${err.message}` : String(err));
    process.exit(2);
  });
}
