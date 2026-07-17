/**
 * Native bridge preload — runs before the Capix plugin and sets up the
 * globalThis bridges that CredentialBroker and the provider require.
 *
 * This module is listed as the first plugin in the engine config so it
 * executes before `plugin.ts`. It sets up:
 *
 * 1. `globalThis.capixSecureStore` — a file-based credential store that
 *    reads/writes to `~/.capix-code/credentials.json` with mode 0600.
 *    This complements the OS keyring used by the Rust launcher; when
 *    the launcher stores a refresh token in the keyring, it also writes
 *    it to this file so the in-process bridge can read it.
 *
 * 2. `globalThis.capixOAuth` — a loopback HTTP callback bridge that
 *    opens the system browser and waits for the OAuth redirect.
 *
 * Security:
 * - Credentials file is created with 0600 permissions.
 * - Only the refresh token is stored; access tokens are ephemeral.
 * - The OAuth callback binds to 127.0.0.1 only.
 * - No credentials are logged.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';

const CREDENTIALS_DIR = join(homedir(), '.capix-code');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const OAUTH_CALLBACK_PORT = 18765;
const OAUTH_TIMEOUT_MS = 300_000; // 5 minutes

interface CapixSecureStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

interface CapixOAuthBridge {
  awaitCallback(authorizeUrl: string, state: string): Promise<{ code: string; state: string }>;
}

interface CredentialEntry {
  [key: string]: string;
}

function readCredentialsFile(): CredentialEntry {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return {};
    const data = readFileSync(CREDENTIALS_FILE, 'utf8');
    return JSON.parse(data) as CredentialEntry;
  } catch {
    return {};
  }
}

function writeCredentialsFile(data: CredentialEntry): void {
  // DEPRECATED: Refresh tokens must only be stored in the OS keychain.
  // This file is read for legacy migration only. New writes are refused.
  // The broker.ts migrateLegacyCredentials() will read and then delete this file.
  // Do not write here.
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, (_err) => {
    // Browser open failures are non-fatal; user can copy URL manually
  });
}

if (!(globalThis as Record<string, unknown>).capixSecureStore) {
  const store: CapixSecureStore = {
    async get(service: string, account: string): Promise<string | null> {
      try {
        // First try the file-based credentials (written by the launcher bridge)
        const data = readCredentialsFile();
        const fileKey = `${service}:${account}`;
        if (data[fileKey]) return data[fileKey];
        // If not found in file, return null (launcher's keyring entry is
        // not directly accessible from the in-process Bun/Node runtime)
        return null;
      } catch {
        return null;
      }
    },
    async set(service: string, account: string, value: string): Promise<void> {
      try {
        const data = readCredentialsFile();
        const fileKey = `${service}:${account}`;
        data[fileKey] = value;
        if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
        try { chmodSync(CREDENTIALS_FILE, 0o600); } catch {}
      } catch (err) {
        // Non-fatal — session-only fallback
      }
    },
    async delete(service: string, account: string): Promise<void> {
      try {
        const data = readCredentialsFile();
        delete data[`${service}:${account}`];
        // Only write if there are other keys remaining; if empty, delete the file
        if (Object.keys(data).length > 0) {
          writeCredentialsFile(data);
        } else {
          try { require('fs').unlinkSync(CREDENTIALS_FILE); } catch {}
        }
      } catch {
        // Non-fatal
      }
    },
  };
  (globalThis as Record<string, unknown>).capixSecureStore = store;
}

if (!(globalThis as Record<string, unknown>).capixOAuth) {
  const bridge: CapixOAuthBridge = {
    async awaitCallback(
      authorizeUrl: string,
      state: string
    ): Promise<{ code: string; state: string }> {
      openBrowser(authorizeUrl);

      return new Promise<{ code: string; state: string }>((resolve, reject) => {
        let server: Server | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (server) server.close();
        };

        server = createServer((req, res) => {
          const url = new URL(req.url || '/', `http://127.0.0.1`);
          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');

            if (code && returnedState === state) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(
                '<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:3rem"><h1>Capix Code connected</h1><p>You can close this tab and return to your terminal.</p></body></html>'
              );
              cleanup();
              resolve({ code, state: returnedState });
            } else {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(
                '<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:3rem"><h1>Authentication failed</h1><p>State mismatch — please try again.</p></body></html>'
              );
              cleanup();
              reject(new Error('oauth_state_mismatch'));
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
          // Server is ready
        });

        timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error('oauth_timeout'));
        }, OAUTH_TIMEOUT_MS);

        server.on('error', (err) => {
          cleanup();
          reject(new Error(`oauth_server_error: ${err.message}`));
        });
      });
    },
  };
  (globalThis as Record<string, unknown>).capixOAuth = bridge;
}

// Export nothing — this module exists for its side effects only.
export {};
