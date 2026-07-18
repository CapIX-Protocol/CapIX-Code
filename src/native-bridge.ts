 
/**
 * Native bridge preload — runs before the Capix plugin and sets up the
 * globalThis bridges that CredentialBroker and the provider require.
 *
 * This module is listed as the first plugin in the engine config so it
 * executes before `plugin.ts`. It sets up:
 *
 * `globalThis.capixOAuth` — a loopback HTTP callback bridge that
 *    opens the system browser and waits for the OAuth redirect.
 *
 * Security:
 * - Refresh tokens remain in the native OS credential store. The engine
 *   receives only a short-lived access token and refreshes through native IPC.
 * - The OAuth callback binds to 127.0.0.1 only.
 * - No credentials are logged.
 */

import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';

const OAUTH_TIMEOUT_MS = 300_000; // 5 minutes

interface CapixOAuthBridge {
  awaitCallback(authorizeUrl: string, state: string): Promise<{ code: string; state: string }>;
}


function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, (_err) => {
    // Browser open failures are non-fatal; user can copy URL manually
  });
}

if (!(globalThis as Record<string, unknown>).capixOAuth) {
  const bridge: CapixOAuthBridge = {
    async awaitCallback(
      authorizeUrl: string,
      state: string
    ): Promise<{ code: string; state: string }> {
      const authorization = new URL(authorizeUrl);
      const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '');
      if (
        redirect.protocol !== 'http:' ||
        redirect.hostname !== '127.0.0.1' ||
        redirect.pathname !== '/callback' ||
        !redirect.port
      ) {
        throw new Error('oauth_redirect_uri_invalid');
      }
      const callbackPort = Number.parseInt(redirect.port, 10);
      if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
        throw new Error('oauth_redirect_port_invalid');
      }

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

        server.listen(callbackPort, '127.0.0.1', () => {
          // Open the browser only after the exact redirect listener is ready;
          // otherwise a fast callback can race server startup.
          openBrowser(authorizeUrl);
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
