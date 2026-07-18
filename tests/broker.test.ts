import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CredentialBroker } from '../src/broker';

describe('CredentialBroker PKCE', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).capixOAuth;
  });

  it('creates a complete S256 authorization request', async () => {
    const broker = new CredentialBroker();
    await broker.login();
    const url = new URL(await broker.authorizationUrl());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects a callback with mismatched state', async () => {
    const broker = new CredentialBroker();
    await broker.login();
    expect(() => broker.submitAuthorizationCallback({ code: 'code', state: 'wrong' })).toThrow(
      'OAuth state mismatch'
    );
  });

  it('hands the native bridge the exact ephemeral redirect URI', async () => {
    let callbackUrl = '';
    (globalThis as Record<string, unknown>).capixOAuth = {
      async awaitCallback(authorizeUrl: string, state: string) {
        callbackUrl = authorizeUrl;
        return { code: 'authorization-code', state };
      },
    };

    const broker = new CredentialBroker();
    await broker.login();

    const authorizeUrl = new URL(callbackUrl);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    );
    expect(await broker.authorizationUrl()).toBe(callbackUrl);
  });
});
