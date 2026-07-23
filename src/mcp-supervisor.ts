/**
 * MCP Process Supervisor — bounded restart with backoff.
 *
 * Monitors the MCP server process, verifies initialize handshake,
 * checks tools/list, and restarts on failure with exponential backoff.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import packageJson from '../package.json' with { type: 'json' };

export type McpHealthState =
  'starting' | 'authenticating' | 'connected' | 'reauthenticating' | 'degraded' | 'disconnected';

export interface McpHealth {
  state: McpHealthState;
  toolCount: number;
  lastCheckedAt: string;
  restartCount: number;
  error?: string;
}

const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000];
const EXPECTED_MIN_TOOLS = 40;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

export class McpSupervisor {
  private process: ChildProcess | null = null;
  private health: McpHealth = {
    state: 'disconnected',
    toolCount: 0,
    lastCheckedAt: '',
    restartCount: 0,
  };
  private timer: NodeJS.Timeout | null = null;
  private listeners: Set<(h: McpHealth) => void> = new Set();
  /** Bumped by stop(); stale backoff respawns check it before restarting. */
  private epoch = 0;

  start(mcpPath: string, env: Record<string, string>): void {
    this.health = {
      state: 'starting',
      toolCount: 0,
      lastCheckedAt: new Date().toISOString(),
      restartCount: 0,
    };
    this.spawnProcess(mcpPath, env);
    this.startHealthChecks();
  }

  private spawnProcess(mcpPath: string, env: Record<string, string>): void {
    this.health.state = 'starting';
    this.notify();

    try {
      const child = spawn('node', [mcpPath, 'server', '--stdio'], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.process = child;

      // spawn() reports a missing entry point / permission error
      // asynchronously via 'error' — without a listener Node raises it as an
      // uncaught exception and kills the host runtime. Degrade instead.
      child.on('error', (err) => {
        if (this.process !== child) return;
        this.health.state = 'disconnected';
        this.health.error = `Failed to start MCP server: ${err.message}`;
        this.process = null;
        this.notify();
      });

      child.on('exit', (code) => {
        // Ignore exits from superseded/stopped processes (stop() and
        // reconnect() kill the old child before replacing it).
        if (this.process !== child) return;
        if (code !== 0 && code !== null && this.health.restartCount < MAX_RESTARTS) {
          this.health.state = 'degraded';
          this.health.error = `Process exited with code ${code}`;
          this.notify();

          const backoff =
            RESTART_BACKOFF_MS[Math.min(this.health.restartCount, RESTART_BACKOFF_MS.length - 1)];
          this.health.restartCount++;
          this.notify();

          const epoch = this.epoch;
          setTimeout(() => {
            // A stop() during the backoff window cancels the pending restart.
            if (this.epoch !== epoch) return;
            this.spawnProcess(mcpPath, env);
          }, backoff).unref();
        } else if (code !== 0 && code !== null) {
          this.health.state = 'disconnected';
          this.health.error = `Process exited with code ${code} (max restarts exceeded)`;
          this.notify();
        }
      });

      // Send initialize handshake
      this.sendInitialize();
    } catch (err) {
      this.health.state = 'disconnected';
      this.health.error = String(err);
      this.notify();
    }
  }

  private sendInitialize(): void {
    if (!this.process?.stdin) return;
    const initRequest =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'capix-code', version: packageJson.version },
        },
      }) + '\n';
    this.process.stdin.write(initRequest);

    // Wait for response then send tools/list
    this.process.stdout?.once('data', (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString().split('\n')[0]);
        if (response.result) {
          this.health.state = 'authenticating';
          this.notify();
          // Send tools/list
          this.sendToolsList();
        }
      } catch {
        /* ignore */
      }
    });
  }

  private sendToolsList(): void {
    if (!this.process?.stdin) return;
    const listRequest =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n';
    this.process.stdin.write(listRequest);

    this.process.stdout?.once('data', (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString().split('\n')[0]);
        if (response.result?.tools) {
          this.health.toolCount = response.result.tools.length;
          this.health.state =
            this.health.toolCount >= EXPECTED_MIN_TOOLS ? 'connected' : 'degraded';
          this.health.lastCheckedAt = new Date().toISOString();
          this.notify();
        }
      } catch {
        /* ignore */
      }
    });
  }

  private startHealthChecks(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.process || this.process.killed) {
        if (this.health.state !== 'disconnected' && this.health.restartCount < MAX_RESTARTS) {
          this.health.state = 'degraded';
          this.health.error = 'Process not running';
          this.notify();
        }
        return;
      }
      // Could send a ping/listTools here to verify health
      this.health.lastCheckedAt = new Date().toISOString();
    }, HEALTH_CHECK_INTERVAL_MS);
    // The supervisor must never be what keeps the host process alive.
    this.timer.unref();
  }

  reconnect(mcpPath: string, env: Record<string, string>): void {
    // Cancel any delayed restart belonging to the pre-auth child before
    // replacing it with the newly credentialed process.
    this.epoch++;
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.health.restartCount = 0;
    this.spawnProcess(mcpPath, env);
  }

  getHealth(): McpHealth {
    return { ...this.health };
  }

  onHealthChange(listener: (h: McpHealth) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.getHealth());
    }
  }

  stop(): void {
    this.epoch++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.process = null;
    }
    this.health.state = 'disconnected';
    this.notify();
  }
}
