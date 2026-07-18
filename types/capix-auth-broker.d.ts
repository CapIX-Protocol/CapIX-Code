/**
 * Ambient declaration for the optional `@capix/auth-broker` peer dependency.
 *
 * The shared auth broker lives in the protocol workspace
 * (packages/auth-broker). It is NOT a hard dependency of capix-code: the
 * dynamic `import('@capix/auth-broker')` in src/broker.ts either resolves
 * (when installed) or throws (caught by the caller, which falls back to the
 * legacy in-file flow). This declaration lets TypeScript type-check the
 * dynamic import path without the package present in node_modules.
 *
 * The shapes mirror protocol/packages/auth-broker/src/*.ts exactly.
 */

declare module '@capix/auth-broker' {
  export type AuthState = 'authenticated' | 'unauthenticated' | 'refreshing' | 'error';

  export interface AccountInfo {
    accountId: string;
    walletAddress?: string;
    projectId?: string;
    expiresAt: number;
  }

  export interface TokenSet {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
  }

  export interface AuthConfig {
    baseUrl: string;
    clientId: string;
    scope?: string;
    audience?: string;
    callbackTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  }

  export type AuthEvent =
    | { type: 'login'; account: AccountInfo }
    | { type: 'refresh'; account: AccountInfo }
    | { type: 'logout' }
    | { type: 'refresh_failed'; reason: string }
    | { type: 'token_reuse_detected' };

  export interface DeviceCodeChallenge {
    url: string;
    userCode: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
  }

  export interface AccessTokenOptions {
    audience?: string;
    scopes?: string[];
  }

  export interface CredentialStore {
    get(service: string, account: string): Promise<string | null>;
    set(service: string, account: string, secret: string): Promise<void>;
    delete(service: string, account: string): Promise<void>;
  }

  export class AuthBrokerError extends Error {
    readonly capixCode: string;
    readonly status?: number;
  }
  export class NotAuthenticatedError extends AuthBrokerError {}
  export class TokenReuseError extends AuthBrokerError {}

  export class FileCredentialStore implements CredentialStore {
    constructor(filePath?: string);
    get(service: string, account: string): Promise<string | null>;
    getSync(service: string, account: string): string | null;
    set(service: string, account: string, secret: string): Promise<void>;
    delete(service: string, account: string): Promise<void>;
  }

  export class KeytarCredentialStore implements CredentialStore {
    constructor(service: string);
    get(service: string, account: string): Promise<string | null>;
    set(service: string, account: string, secret: string): Promise<void>;
    delete(service: string, account: string): Promise<void>;
  }

  export class PlatformCredentialStore implements CredentialStore {
    constructor(backend?: string);
    static isSupported(platform?: string): boolean;
    get(service: string, account: string): Promise<string | null>;
    set(service: string, account: string, secret: string): Promise<void>;
    delete(service: string, account: string): Promise<void>;
  }

  export function createDefaultCredentialStore(service: string): CredentialStore;

  export class AuthBroker {
    /** Loopback-captured authorization code (set by the callback server). */
    capturedCode: { code: string; state: string } | null;

    constructor(config: AuthConfig, credentialStore: CredentialStore);

    startLogin(): Promise<{ authorizeUrl: string; state: string }>;
    completeLogin(code: string, state: string): Promise<AccountInfo>;
    startDeviceCodeLogin(): Promise<DeviceCodeChallenge>;
    completeDeviceCodeLogin(challenge: DeviceCodeChallenge): Promise<AccountInfo>;
    getAccessToken(opts?: AccessTokenOptions): Promise<string>;
    getState(): AuthState;
    getAccount(): AccountInfo | null;
    logout(): Promise<void>;
    onEvent(handler: (event: AuthEvent) => void): void;
  }
}
