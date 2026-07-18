export function validateBaseUrl(url: string): { ok: boolean; error?: string } {
  if (!url || typeof url !== 'string') return { ok: false, error: 'base URL is empty' };
  if (!/^https:\/\//.test(url)) return { ok: false, error: `base URL must be https` };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  return { ok: true };
}
export function buildUrl(base: string, path: string): string {
  const v = validateBaseUrl(base);
  if (!v.ok) throw new Error(`URL violation: ${v.error}`);
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
}
export function buildInferenceUrl(base: string): string {
  return buildUrl(base, '/inference/chat/completions');
}
export function buildModelsUrl(base: string): string {
  return buildUrl(base, '/models');
}
export function buildPrivateInferenceUrl(base: string, sagaId: string): string {
  return buildUrl(base, `/inference/deployments/${encodeURIComponent(sagaId)}`);
}
