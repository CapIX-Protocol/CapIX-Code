import { describe, expect, it } from 'vitest';
import {
  validateBaseUrl,
  buildUrl,
  buildInferenceUrl,
  buildModelsUrl,
  buildPrivateInferenceUrl,
} from '../src/url-builder.js';

describe('URL contract: base URL validation', () => {
  it('accepts absolute https URLs', () => {
    expect(validateBaseUrl('https://www.capix.network/api/v1').ok).toBe(true);
    expect(validateBaseUrl('https://api.capix.network').ok).toBe(true);
    expect(validateBaseUrl('https://localhost:3000/api/v1').ok).toBe(true);
  });

  it('rejects relative URLs', () => {
    expect(validateBaseUrl('/chat/completions').ok).toBe(false);
    expect(validateBaseUrl('/api/v1').ok).toBe(false);
    expect(validateBaseUrl('.').ok).toBe(false);
  });

  it('rejects http (non-TLS) URLs', () => {
    expect(validateBaseUrl('http://www.capix.network/api/v1').ok).toBe(false);
    expect(validateBaseUrl('http://localhost:3000').ok).toBe(false);
  });

  it('rejects empty or malformed URLs', () => {
    expect(validateBaseUrl('').ok).toBe(false);
    expect(validateBaseUrl('not a url').ok).toBe(false);
    expect(validateBaseUrl('https://').ok).toBe(false);
  });
});

describe('URL contract: URL building', () => {
  it('builds an inference URL that is always absolute https', () => {
    const url = buildInferenceUrl('https://www.capix.network/api/v1');
    expect(url).toBe('https://www.capix.network/api/v1/inference/chat/completions');
    expect(url.startsWith('https://')).toBe(true);
    expect(url).not.toMatch(/^\/+/); // never relative
  });

  it('builds a models URL that is always absolute https', () => {
    const url = buildModelsUrl('https://www.capix.network/api/v1');
    expect(url).toBe('https://www.capix.network/api/v1/models');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildInferenceUrl('https://api.capix.network/')).toBe(
      'https://api.capix.network/inference/chat/completions'
    );
    expect(buildModelsUrl('https://api.capix.network///')).toBe('https://api.capix.network/models');
  });

  it('never produces double slashes at the join point', () => {
    const url = buildUrl('https://api.capix.network/', '/models');
    expect(url).toBe('https://api.capix.network/models');
    expect(url).not.toContain('//models');
  });

  it('builds a private inference URL with encoded saga ID', () => {
    const url = buildPrivateInferenceUrl('https://api.capix.network/api/v1', 'gpu_abc123');
    expect(url).toBe('https://api.capix.network/api/v1/inference/deployments/gpu_abc123');
  });

  it('encodes special characters in the saga ID', () => {
    const url = buildPrivateInferenceUrl('https://api.capix.network/api/v1', 'gpu_a/b c');
    expect(url).toBe('https://api.capix.network/api/v1/inference/deployments/gpu_a%2Fb%20c');
  });

  it('throws on relative base URLs (never silently builds a bad URL)', () => {
    expect(() => buildInferenceUrl('/chat/completions')).toThrow('URL violation');
    expect(() => buildModelsUrl('/api/v1')).toThrow('URL violation');
    expect(() => buildUrl('http://insecure', '/path')).toThrow('URL violation');
    expect(() => buildUrl('', '/path')).toThrow('URL violation');
  });

  it('handles every supported base URL shape', () => {
    const bases = [
      'https://www.capix.network/api/v1',
      'https://api.capix.network',
      'https://staging.capix.network/api/v1',
      'https://localhost:3000',
    ];
    for (const base of bases) {
      const inferUrl = buildInferenceUrl(base);
      const modelsUrl = buildModelsUrl(base);
      expect(inferUrl.startsWith('https://')).toBe(true);
      expect(modelsUrl.startsWith('https://')).toBe(true);
      expect(inferUrl).toContain('/chat/completions');
      expect(modelsUrl.endsWith('/models')).toBe(true);
    }
  });
});
