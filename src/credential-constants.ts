/**
 * Shared credential identity for Capix Code.
 *
 * This is the SINGLE source of truth for the OS keychain service/account name.
 * Both the TypeScript CredentialBroker and the Rust launcher MUST use these
 * exact values. The Rust launcher reads them from its own constants which
 * must match.
 *
 * Identity history (for migration):
 * - Legacy Rust:    capix-code:oauth-refresh-token  (still active — this is canonical)
 * - Legacy TS:      capix-code:capix-device-session (migrated to canonical)
 * - Legacy file:    ~/.capix-code/credentials.json   (deprecated, removed on migration)
 * - Legacy IDE:     VS Code SecretStorage capix.sessionToken/capix.refreshToken (separate system)
 */

export const CREDENTIAL_SERVICE = 'capix-code';
export const CREDENTIAL_ACCOUNT = 'oauth-refresh-token';

/** Legacy account names that should be migrated to the canonical identity. */
export const LEGACY_ACCOUNTS = [
  'capix-device-session', // Old TS broker account name
];

/** The file-based credential store path (deprecated — removed after migration). */
export const LEGACY_CREDENTIALS_FILE = '~/.capix-code/credentials.json';

/** Native credential-broker endpoints. Both are local-machine transports. */
export const UNIX_BROKER_SOCKET_PATH = '/tmp/capix-code-broker.sock';
export const WINDOWS_BROKER_PIPE_PATH = '\\\\.\\pipe\\capix-code-broker';

/** Resolve the native transport without making callers duplicate platform logic. */
export function brokerEndpoint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? WINDOWS_BROKER_PIPE_PATH : UNIX_BROKER_SOCKET_PATH;
}

/** Backwards-compatible Unix name for callers that only run on POSIX. */
export const BROKER_SOCKET_PATH = UNIX_BROKER_SOCKET_PATH;

/** OAuth client ID (shared). */
export const OAUTH_CLIENT_ID = 'capix-code';

/** Token endpoint (shared). */
export const OAUTH_TOKEN_URL = 'https://www.capix.network/oauth/token';

/** Access token TTL (15 minutes, enforced server-side). */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Refresh token TTL (7 days, enforced server-side). */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export type AuthStatus = {
  authenticated: boolean;
  accountId?: string;
  sessionId?: string;
  expiresAt?: string;
  scopes?: string[];
};

export type TokenRequest = {
  audience?: string;
  scopes?: string[];
  projectId?: string;
};

export type TokenResponse = {
  accessToken: string;
  expiresAt: string;
  scopes: string[];
};

export type BrokerMethod =
  'auth.status' | 'auth.login' | 'auth.logout' | 'token.get' | 'token.invalidate';

export type BrokerRequest = {
  method: BrokerMethod;
  params?: TokenRequest;
};

export type BrokerResponse = {
  ok: boolean;
  result?: AuthStatus | TokenResponse;
  error?: string;
};
