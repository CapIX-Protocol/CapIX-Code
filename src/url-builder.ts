/**
 * URL contract utilities for the Capix provider.
 *
 * Ensures the URL builder can never create malformed values such as a
 * relative "/chat/completions" URL. Every base URL MUST be an absolute
 * https URL; the path is appended safely without double slashes.
 */

/** Validate that a base URL is an absolute https URL. */
export function validateBaseUrl(url: string): { ok: boolean; error?: string } {
  if (!url || typeof url !== 'string') return { ok: false, error: 'base URL is empty' };
  if (!/^https:\/\//.test(url))
    return { ok: false, error: `base URL must be https, got: ${url.slice(0, 30)}` };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: `base URL is malformed: ${url.slice(0, 30)}` };
  }
  return { ok: true };
}

/**
 * Safely build a URL from a base and a path. Rejects relative base URLs,
 * strips trailing slashes from the base, and prevents double slashes at
 * the join point.
 */
export function buildUrl(base: string, path: string): string {
  const validation = validateBaseUrl(base);
  if (!validation.ok) {
    throw new Error(`Capix URL contract violation: ${validation.error}`);
  }
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Build the inference streaming URL from a base URL.
 * Never produces a relative "/chat/completions" URL.
 */
export function buildInferenceUrl(base: string): string {
  return buildUrl(base, '/inference/chat/completions');
}

/**
 * Build the models list URL from a base URL.
 */
export function buildModelsUrl(base: string): string {
  return buildUrl(base, '/models');
}

/**
 * Build a private inference URL for a specific deployment.
 */
export function buildPrivateInferenceUrl(base: string, sagaId: string): string {
  const encoded = encodeURIComponent(sagaId);
  return buildUrl(base, `/inference/deployments/${encoded}`);
}
