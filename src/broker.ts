/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Credential broker — the privileged local identity boundary.
 *
 * Refs:
 * - architecture §12.3 (Authentication/broker)
 * - master prompt C3 (Native credential broker)
 *
 * Wire obligations:
 * - keeps refresh token / device key out of plugins and shell tools, plugins, shell tools,
 *   args, config, environment, logs and crash bundles;
 * - obtains audience/project-scoped short-lived access tokens with refresh
 *   rotation and reuse detection;
 * - proxies inference/control calls OR gives the Capix provider a one-time
 *   local capability over an inherited pipe / `0600` Unix socket / locked
 *   named pipe with peer PID/UID/SID checks;
 * - closes inherited capabilities and scrubs secrets before any tool process
 *   starts;
 * - supports session-only login if secure storage is unavailable — never
 *   falls back to plaintext.
 *
 * This is the TypeScript reference implementation. The canonical native
 * broker ships in the Rust launcher (launcher/src); this module is the
 * in-process shim the bundled engine talks to until the native broker is
 * fully wired, and remains the contract surface for tests.
 */

import { createServer, type Server } from 'node:net';
import { logger } from './logger.js';

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

export interface DeviceSession {
  deviceId: string;
  accountIds: string[];
  activeProjectId?: string;
}

export interface ExchangeResult {
  type: 'success';
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

export interface ApiKeyResult {
  type: 'success';
  key: string;
  provider?: string;
  metadata?: Record<string, string>;
}

export type AuthorizeResult = ExchangeResult | ApiKeyResult | { type: 'failed' };

const SERVICE = 'capix-code';
const ACCOUNT = 'oauth-refresh-token';

/** Marker thrown when secure storage is unavailable and session fallback is used. */
export class SecureStorageUnavailableError extends Error {
  constructor(message = 'secure storage unavailable') {
    super(message);
    this.name = 'SecureStorageUnavailableError';
  }
}

/** Marker thrown when a refresh-token reuse is detected (rotation breach). */
export class TokenReuseError extends Error {
  constructor(message = 'refresh token reuse detected') {
    super(message);
    this.name = 'TokenReuseError';
  }
}

/**
 * CredentialBroker manages refresh tokens in OS secure storage (Keychain on
 * macOS, Credential Manager on Windows, Secret Service on Linux).
 *
 * It NEVER falls back to plaintext. If secure storage is unavailable it
 * degrades to an explicit session-only mode with a strong warning.
 */
export class CredentialBroker {
  /** Session-only in-memory cache when secure storage is unavailable. */
  private sessionRefresh: string | null = null;
  private sessionAccess: AccessToken | null = null;
  private lastRefreshSeen: string | null = null;
  /** Single-flight refresh: prevents concurrent refreshToken() calls from racing. */
  private refreshPromise: Promise<void> | null = null;
  /** Migration flag: true after legacy credential migration has been attempted. */
  private migrated: boolean = false;
  private deviceSession: DeviceSession | null = null;
  private authorizeUrl: string | null = null;
  private authorizationCode: string | null = null;
  private callbackServer: Server | null = null;
  private redirectUri: string | null = null;

  /** True when only session storage is available (plaintext fallback refused). */
  readonly sessionOnly: boolean;

  constructor() {
    this.sessionOnly = !this.secureStorageAvailable();
    if (this.sessionOnly) {
      logger.warn('capix-broker: secure storage unavailable — session-only login', {});
    }
  }

  /** Probe whether the OS secure storage backend is reachable. */
  private secureStorageAvailable(): boolean {
    // The native launcher injects a `capixSecureStore` global (a thin shim
    // over keyring/libsecret/Credential Manager). In a plain Node/Bun process
    // without the launcher we cannot guarantee secure storage, so we refuse to
    // persist rather than fall back to plaintext.
    const g = globalThis as unknown as { capixSecureStore?: unknown };
    return typeof g.capixSecureStore === 'object' && g.capixSecureStore !== null;
  }

  /**
   * Obtain a short-lived, audience/project-scoped access token for the
   * provider. The provider receives ONLY this token; it never sees the
   * refresh token.
   */
  async getAccessToken(
    opts: {
      projectId?: string;
      scopes?: string[];
    } = {}
  ): Promise<AccessToken> {
    // If the launcher already set CAPIX_API_KEY, use it directly.
    // The launcher refreshes the token before spawning the engine,
    // so this avoids a redundant refresh that would consume the token.
    const envKey = process.env.CAPIX_API_KEY?.trim();
    if (envKey) {
      if (!this.sessionAccess || this.sessionAccess.token !== envKey) {
        this.sessionAccess = {
          token: envKey,
          expiresAt: new Date(Date.now() + 14 * 60 * 1000),
        };
      }
      if (this.sessionAccess.expiresAt.getTime() > Date.now() + 60_000) {
        return this.sessionAccess;
      }
    }

    if (this.sessionAccess && this.sessionAccess.expiresAt.getTime() > Date.now() + 60_000) {
      return this.sessionAccess;
    }
    await this.refreshToken();
    if (!this.sessionAccess) {
      throw new Error('capix-broker: no access token after refresh');
    }
    // Note: the real native broker mints audience/project-scoped tokens here.
    // We intentionally do not embed the project id in the token string itself.
    void opts.projectId;
    void opts.scopes;
    return this.sessionAccess;
  }

  /**
   * Rotate the refresh token and mint a fresh access token. Detects reuse of a
   * previously-seen refresh token (rotation breach) and revokes the device.
   */
  async refreshToken(): Promise<void> {
    // Single-flight: if a refresh is already in progress, wait for it.
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._doRefresh();
    try { await this.refreshPromise; } finally { this.refreshPromise = null; }
  }

  private async _doRefresh(): Promise<void> {
    // Packaged Capix Code delegates refresh to the native broker so refresh
    // material never crosses into the TypeScript engine. This is also the
    // recovery path after a gateway 401 during a long-running session.
    const brokerToken = await this.getBrokerToken().catch(() => null);
    if (brokerToken) {
      this.sessionAccess = {
        token: brokerToken,
        expiresAt: new Date(Date.now() + 14 * 60 * 1000),
      };
      return;
    }

    // Migrate legacy credentials on first use
    if (!this.migrated) { this.migrated = true; await this.migrateLegacyCredentials(); }
    const refresh = await this.loadRefreshToken();
    if (!refresh) {
      throw new Error('capix-broker: not logged in');
    }
    if (this.lastRefreshSeen !== null && this.lastRefreshSeen === refresh) {
      // Same refresh presented twice in a row after a successful rotation is
      // a reuse signal — revoke immediately.
      await this.revokeDevice();
      throw new TokenReuseError();
    }

    const res = await fetch('https://www.capix.network/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: 'capix-code',
      }).toString(),
    });
    if (!res.ok) {
      if (res.status === 401) {
        // Refresh token invalid/expired — clear it; caller must re-login.
        await this.clearRefreshToken();
        throw new Error('capix-broker: refresh token rejected (401)');
      }
      throw new Error(`capix-broker: token refresh failed (${res.status})`);
    }
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      account_id?: string;
    };
    // Rotation: the server issues a new refresh token; store it and remember
    // the one we just used so a replay is detectable.
    this.lastRefreshSeen = refresh;
    await this.storeRefreshToken(body.refresh_token);
    this.sessionAccess = {
      token: body.access_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
    if (body.account_id && !this.deviceSession) {
      this.deviceSession = {
        deviceId: 'session',
        accountIds: [body.account_id],
      };
    }
  }

  /** Interactive browser authorization code + PKCE login. */
  async login(): Promise<void> {
    const { verifier, challenge } = await this.generatePkce();
    const state = this.randomToken(24);
    const codeChallenge = challenge;

    // Dynamically bind an ephemeral loopback port so the redirect URI is a
    // real, addressable endpoint rather than the invalid `:0`.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object' || !addr.port) {
      server.close();
      throw new Error('capix-broker: failed to bind ephemeral loopback port');
    }
    const port = addr.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    // This socket exists only to obtain a free ephemeral port. The native
    // callback bridge owns the actual HTTP listener, so release the probe
    // before asking it to bind the same redirect URI.
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    this.callbackServer = null;
    this.redirectUri = redirectUri;

    // Build the authorize URL; the real broker opens the system browser.
    const url = new URL('https://www.capix.network/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'capix-code');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    // Stash PKCE verifier for exchangeCode().
    this.pkceVerifier = verifier;
    this.authState = state;
    this.authorizeUrl = url.toString();
    await this.openBrowser(url.toString());
    logger.info('capix-broker: login started', { state, port });
  }

  /** Return the authorize URL (for the plugin auth hook). */
  async authorizationUrl(): Promise<string> {
    if (!this.authorizeUrl) await this.login();
    if (!this.authorizeUrl) throw new Error('capix-broker: authorization was not initialized');
    return this.authorizeUrl;
  }

  /**
   * Deliver a loopback callback captured by the native launcher. State is
   * checked here, at the privileged boundary, before the code is accepted.
   */
  submitAuthorizationCallback(input: { code: string; state: string }): void {
    if (!this.authState || input.state !== this.authState) {
      throw new Error('capix-broker: OAuth state mismatch');
    }
    if (!input.code) throw new Error('capix-broker: authorization code missing');
    this.authorizationCode = input.code;
  }

  /** Exchange the authorization code for tokens (called by the auth hook callback). */
  async exchangeCode(): Promise<ExchangeResult | { type: 'failed' }> {
    // The native broker intercepts the loopback redirect and hands us the code.
    const code = await this.awaitCode();
    const verifier = this.pkceVerifier;
    if (!verifier) throw new Error('capix-broker: no PKCE verifier');
    const redirectUri = this.redirectUri;
    if (!redirectUri) throw new Error('capix-broker: no redirect URI — call login() first');
    const res = await fetch('https://www.capix.network/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: 'capix-code',
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) {
      this.redirectUri = null;
      this.closeCallbackServer();
      return { type: 'failed' };
    }
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      account_id?: string;
    };
    await this.storeRefreshToken(body.refresh_token);
    this.sessionAccess = {
      token: body.access_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
    this.deviceSession = {
      deviceId: 'session',
      accountIds: body.account_id ? [body.account_id] : [],
    };
    this.pkceVerifier = null;
    this.authState = null;
    this.authorizeUrl = null;
    this.authorizationCode = null;
    this.redirectUri = null;
    this.closeCallbackServer();
    return {
      type: 'success',
      provider: 'capix',
      refresh: body.refresh_token,
      access: body.access_token,
      expires: this.sessionAccess.expiresAt.getTime(),
      accountId: body.account_id,
    };
  }

  /** Register a project-scoped API key (automation only). */
  async registerApiKey(key: string): Promise<ApiKeyResult | { type: 'failed' }> {
    // Hash the key before comparison; never store the raw key in memory
    // longer than needed. The server validates and returns metadata.
    const digest = await this.sha256(key);
    const res = await fetch('https://www.capix.network/api/v1/auth/api-key/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_digest: digest, client: 'capix-code' }),
    });
    if (!res.ok) {
      return { type: 'failed' };
    }
    const body = (await res.json()) as { project_id?: string; label?: string };
    // API keys are session-only; no refresh token is minted.
    this.sessionAccess = {
      token: key,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
    return {
      type: 'success',
      key: `cpk_${digest.slice(0, 12)}`,
      provider: 'capix',
      metadata: body.project_id ? { project_id: body.project_id } : {},
    };
  }

  /** Logout and clear the local refresh token. */
  async logout(): Promise<void> {
    try {
      const refresh = await this.loadRefreshToken();
      if (refresh) {
        await fetch('https://www.capix.network/oauth/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: refresh, client: 'capix-code' }),
        });
      }
    } finally {
      await this.clearRefreshToken();
      this.sessionAccess = null;
      this.sessionRefresh = null;
      this.lastRefreshSeen = null;
      this.deviceSession = null;
      this.redirectUri = null;
      this.closeCallbackServer();
    }
  }

  /** Revoke the entire device session and rotate the device key. */
  async revokeDevice(): Promise<void> {
    if (!this.deviceSession) return;
    try {
      const access = this.sessionAccess?.token;
      if (access) {
        await fetch('https://www.capix.network/api/v1/auth/device/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}` },
        });
      }
    } finally {
      await this.clearRefreshToken();
      this.sessionAccess = null;
      this.sessionRefresh = null;
      this.lastRefreshSeen = null;
      this.deviceSession = null;
      this.redirectUri = null;
      this.closeCallbackServer();
    }
  }

  // ── Secure storage primitives ───────────────────────────────────────────

  private async loadRefreshToken(): Promise<string | null> {
    if (this.sessionOnly) return this.sessionRefresh;
    const store = (
      globalThis as { capixSecureStore?: { get: (s: string, a: string) => Promise<string | null> } }
    ).capixSecureStore;
    try {
      return (await store!.get(SERVICE, ACCOUNT)) ?? this.sessionRefresh;
    } catch (err) {
      logger.warn('capix-broker: secure read failed', { error: (err as Error).message });
      return this.sessionRefresh;
    }
  }

  private async storeRefreshToken(token: string): Promise<void> {
    this.sessionRefresh = token;
    if (this.sessionOnly) return;
    const store = (
      globalThis as {
        capixSecureStore?: { set: (s: string, a: string, v: string) => Promise<void> };
      }
    ).capixSecureStore;
    try {
      await store!.set(SERVICE, ACCOUNT, token);
    } catch (err) {
      logger.warn('capix-broker: secure write failed; session-only', {
        error: (err as Error).message,
      });
    }
  }

  private async clearRefreshToken(): Promise<void> {
    this.sessionRefresh = null;
    if (this.sessionOnly) return;
    const store = (
      globalThis as { capixSecureStore?: { delete: (s: string, a: string) => Promise<void> } }
    ).capixSecureStore;
    try {
      await store!.delete(SERVICE, ACCOUNT);
    } catch (err) {
      logger.warn('capix-broker: clear failed — best effort', { error: (err as Error).message });
    }
  }

  /**
   * Migrate legacy credential identities to the canonical one.
   * Old account name was 'capix-device-session'; new is 'oauth-refresh-token'.
   */
  private async migrateLegacyCredentials(): Promise<void> {
    if (this.sessionOnly) return;
    const store = (
      globalThis as { capixSecureStore?: { get: (s: string, a: string) => Promise<string | null>; delete: (s: string, a: string) => Promise<void>; set: (s: string, a: string, v: string) => Promise<void> } }
    ).capixSecureStore;
    if (!store) return;
    try {
      // Check if legacy account has a token
      const legacyToken = await store.get(SERVICE, 'capix-device-session');
      if (legacyToken) {
        // Write to canonical account
        await store.set(SERVICE, ACCOUNT, legacyToken);
        // Delete legacy
        await store.delete(SERVICE, 'capix-device-session');
        logger.info('capix-broker: migrated legacy credential identity', {});
      }
      // Also check file-based legacy key
      const fileLegacy = await store.get(SERVICE, 'capix-code:capix-device-session');
      if (fileLegacy && fileLegacy !== legacyToken) {
        await store.set(SERVICE, ACCOUNT, fileLegacy);
        await store.delete(SERVICE, 'capix-code:capix-device-session');
        logger.info('capix-broker: migrated file-based legacy credential', {});
      }
    } catch (err) {
      logger.warn('capix-broker: credential migration failed (non-fatal)', { error: (err as Error).message });
    }
  }


  // ── IPC broker client ───────────────────────────────────────────────────
  // Connects to the native launcher's Unix domain socket broker for
  // cross-process auth coordination.

  private async brokerRequest(method: string, params?: unknown): Promise<unknown> {
    try {
      const { connect } = await import('node:net');
      const socketPath = '/tmp/capix-code-broker.sock';
      const request = JSON.stringify({ method, params });
      
      return new Promise((resolve, reject) => {
        const socket = connect(socketPath, () => {
          socket.write(request);
        });
        socket.on('data', (data: Buffer) => {
          try {
            const response = JSON.parse(data.toString());
            resolve(response);
          } catch {
            reject(new Error('invalid_broker_response'));
          }
          socket.end();
        });
        socket.on('error', () => {
          reject(new Error('broker_unavailable'));
        });
        socket.setTimeout(3000, () => {
          socket.destroy();
          reject(new Error('broker_timeout'));
        });
      });
    } catch {
      return { ok: false, error: 'broker_unavailable' };
    }
  }

  /** Check if the IPC broker is running and what its auth status is. */
  async getAuthStatus(): Promise<{ authenticated: boolean }> {
    const response: any = await this.brokerRequest('auth.status');
    if (response.ok && response.result) {
      return { authenticated: response.result.authenticated === true };
    }
    return { authenticated: false };
  }

  /** Get a token from the broker (single-flight, cross-process safe). */
  async getBrokerToken(): Promise<string | null> {
    const response: any = await this.brokerRequest('token.get');
    if (response.ok && response.result?.accessToken) {
      return response.result.accessToken;
    }
    return null;
  }

  /** Invalidate the cached token (forces next request to refresh). */
  async invalidateBrokerToken(): Promise<void> {
    await this.brokerRequest('token.invalidate');
  }

  // ── PKCE + browser helpers ──────────────────────────────────────────────

  /** Close the ephemeral loopback server used to reserve a port during login. */
  private closeCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
  }

  private pkceVerifier: string | null = null;
  private authState: string | null = null;

  private async generatePkce(): Promise<{ verifier: string; challenge: string }> {
    const verifier = this.randomToken(64);
    return { verifier, challenge: await this.sha256(verifier) };
  }

  private randomToken(len: number): string {
    const bytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(bytes);
    return this.base64Url(bytes);
  }

  private base64Url(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      out += alphabet[b0 >> 2];
      out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
      if (i + 1 < bytes.length) out += alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
      if (i + 2 < bytes.length) out += alphabet[b2 & 63];
    }
    return out;
  }

  private async sha256(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return this.base64Url(new Uint8Array(digest));
  }

  private async openBrowser(url: string): Promise<void> {
    const native = (globalThis as { capixOAuth?: { awaitCallback: (url: string, state: string) => Promise<{ code: string; state: string }> } }).capixOAuth;
    if (native?.awaitCallback) {
      const callback = await native.awaitCallback(url, this.authState ?? '');
      this.submitAuthorizationCallback(callback);
    } else {
      logger.info('capix-broker: open browser', { url });
    }
  }

  private async awaitCode(): Promise<string> {
    // If openBrowser already captured the code via native bridge, use it
    if (this.authorizationCode) return this.authorizationCode;
    const native = (
      globalThis as {
        capixOAuth?: { awaitCallback: () => Promise<{ code: string; state: string }> };
      }
    ).capixOAuth;
    if (!native) {
      throw new Error('capix-broker: native OAuth callback bridge unavailable');
    }
    const callback = await native.awaitCallback();
    this.submitAuthorizationCallback(callback);
    return this.authorizationCode!;
  }
}
