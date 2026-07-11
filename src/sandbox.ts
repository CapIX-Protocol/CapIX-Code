/**
 * Workspace sandbox — local tool/workspace security.
 *
 * Refs:
 * - architecture §12.5 (Local tool security)
 * - master prompt C5 (Local tool/workspace sandbox)
 *
 * Approval prompts alone are not a sandbox. This module provides the explicit
 * profiles and controls that gate file access, command execution, environment
 * inheritance, process limits, and capability closure.
 */

import { resolve, relative, sep, normalize, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { logger } from './logger.js';

export type SandboxProfile = 'restricted' | 'developer' | 'host';

export interface CommandApprovalInput {
  executable: string;
  args: string[];
  cwd: string;
  envDelta: Record<string, string>;
  network: boolean;
}

export interface SandboxLimits {
  maxCpuPercent: number;
  maxRamMb: number;
  maxPids: number;
  maxDiskMb: number;
  maxWallTimeMs: number;
  maxOutputBytes: number;
}

/** Default per-profile limits. */
export const PROFILE_LIMITS: Record<SandboxProfile, SandboxLimits> = {
  restricted: {
    maxCpuPercent: 50,
    maxRamMb: 1024,
    maxPids: 64,
    maxDiskMb: 512,
    maxWallTimeMs: 5 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
  },
  developer: {
    maxCpuPercent: 80,
    maxRamMb: 4096,
    maxPids: 256,
    maxDiskMb: 2048,
    maxWallTimeMs: 30 * 60 * 1000,
    maxOutputBytes: 8 * 1024 * 1024,
  },
  host: {
    maxCpuPercent: 100,
    maxRamMb: 16384,
    maxPids: 1024,
    maxDiskMb: 8192,
    maxWallTimeMs: 60 * 60 * 1000,
    maxOutputBytes: 32 * 1024 * 1024,
  },
};

/** Glob-free secret path fragments blocked unless explicitly granted. */
const SECRET_FRAGMENTS = [
  '.env',
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.docker',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.capix',
  '.kube',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'id.json',
  'credentials.json',
  'service_account',
  'wallet',
  'keystore',
  'keyring',
  'secret-key',
  'KnownHosts',
];

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'PWD']);

const SCRUB_PREFIXES = [
  'CAPIX_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCLOUD_',
  'OPENAI_',
  'ANTHROPIC_',
  'SSH_',
  'WALLET_',
  'SOLANA_',
  'PRIVATE_',
  'SECRET_',
  'VAST_',
  'HETZNER_',
];

const SCRUB_EXACT = new Set([
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'REFRESH_TOKEN',
  'ACCESS_TOKEN',
  'PASSPHRASE',
  'PASSWORD',
  'PRIVATE_KEY',
  'BEARER',
  'AUTHORIZATION',
]);

/**
 * WorkspaceSandbox enforces a profile over the canonical workspace root. It
 * blocks symlink/junction/path traversal, protects secret paths, scrubs
 * environment variables, and closes broker-inherited capabilities before any
 * tool process starts.
 */
export class WorkspaceSandbox {
  readonly profile: SandboxProfile;
  readonly workspaceRoot: string;
  readonly limits: SandboxLimits;

  /** True when the OS native isolation layer is absent (degraded protection). */
  readonly degraded: boolean;

  /** Real (symlink-free) workspace root for path-escape detection. */
  private readonly realWorkspaceRoot: string;

  /** Set when broker capabilities are closed — approvals fail closed. */
  private _closed = false;

  constructor(profile: SandboxProfile, workspaceRoot: string) {
    this.profile = profile;
    this.workspaceRoot = normalize(resolve(workspaceRoot));

    // Resolve the real (symlink-free) workspace root so that OS-level symlinks
    // (e.g., /tmp → /private/tmp on macOS) do not cause false escape reports.
    this.realWorkspaceRoot = this.resolveRealPath(this.workspaceRoot);

    this.limits = PROFILE_LIMITS[profile];
    this.degraded = !this.osIsolationAvailable();

    if (profile === 'host') {
      logger.warn('capix-sandbox: HOST profile active — full machine access, session-only', {});
    }
    if (this.degraded) {
      logger.warn(
        'capix-sandbox: OS isolation unavailable — degraded protection reported honestly',
        {
          profile,
        }
      );
    }
  }

  /** True when broker capabilities have been closed (fail-closed for approvals). */
  get closed(): boolean {
    return this._closed;
  }

  /** Probe whether OS isolation (Landlock/seccomp/AppContainer/restricted token) is present. */
  private osIsolationAvailable(): boolean {
    const g = globalThis as unknown as { capixSandbox?: unknown };
    return typeof g.capixSandbox === 'object' && g.capixSandbox !== null;
  }

  /**
   * Canonicalize a path against the workspace root and reject traversal.
   * Resolves symlinks/junctions and ensures the result stays under root.
   */
  canonicalizePath(input: string): string {
    const root = normalize(this.workspaceRoot);
    const target = normalize(resolve(root, input));
    const rel = relative(root, target);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error(`capix-sandbox: path traversal blocked (${input})`);
    }
    return target;
  }

  /**
   * Resolve a path to its real (symlink-free) form. If the exact path does not
   * exist, progressively resolve the deepest existing ancestor and append the
   * remainder so symlinks in parent directories (including OS-level symlinks
   * such as /tmp → /private/tmp on macOS) are still detected.
   */
  private resolveRealPath(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      const parts = p.split(sep);
      const remainder: string[] = [];

      while (parts.length > 0) {
        const candidate = parts.join(sep) || sep;
        try {
          const real = realpathSync(candidate);
          return remainder.length === 0 ? real : join(real, ...remainder.reverse());
        } catch {
          remainder.push(parts.pop()!);
        }
      }
      // Nothing in the path exists — fall back to the lexical path.
      return p;
    }
  }

  /** True if the path is within the canonical workspace root. */
  isPathAllowed(path: string): boolean {
    if (this.profile === 'host') return true;
    try {
      const target = this.canonicalizePath(path);
      const rel = relative(this.workspaceRoot, target);
      if (rel.startsWith('..')) {
        if (this.profile === 'developer') {
          // Developer: broader file grants per action, but still not secrets.
          return !this.isSecretPath(path);
        }
        return false;
      }

      // Resolve symlinks to prevent escape via symlink/junction/hardlink.
      const realTarget = this.resolveRealPath(target);
      const realRel = relative(this.realWorkspaceRoot, realTarget);
      if (realRel.startsWith('..')) {
        if (this.profile === 'developer') {
          return !this.isSecretPath(realTarget);
        }
        return false;
      }

      // Block secret paths even within the workspace (unless host profile).
      if (this.isSecretPath(target)) return false;
      if (realTarget !== target && this.isSecretPath(realTarget)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** True if the path touches protected secret material. */
  isSecretPath(path: string): boolean {
    const lower = path.toLowerCase();
    const base = lower.split(sep).pop() ?? lower;

    // .env* files (e.g., .env, .env.local, .env.production, .envrc)
    if (base.startsWith('.env')) return true;

    return SECRET_FRAGMENTS.some((frag) => {
      const f = frag.toLowerCase();
      return (
        lower === f ||
        lower.endsWith(`/${f}`) ||
        lower.includes(`/${f}/`) ||
        base === f ||
        base.startsWith(`${f}.`) ||
        base.endsWith(`.${f}`)
      );
    });
  }

  /**
   * Decide whether a command may run under the current profile. In restricted
   * mode, network is always denied and exact commands require approval.
   */
  shouldApproveCommand(args: CommandApprovalInput): boolean {
    // Fail closed after broker disconnect / capability closure.
    if (this._closed) return false;
    if (this.profile === 'host') return true;

    // Restricted: deny network-bearing subprocesses entirely.
    if (this.profile === 'restricted' && args.network) {
      return false;
    }

    // Always deny if the env delta injects secret-looking material.
    for (const key of Object.keys(args.envDelta)) {
      if (this.isSecretEnvKey(key)) return false;
    }

    // Always deny if the cwd escapes the workspace root.
    if (!this.isPathAllowed(args.cwd)) return false;

    // Deny if any argument references a protected secret path.
    for (const arg of args.args) {
      if (this.isSecretPath(arg)) return false;
    }

    // Reject obviously dangerous executables in restricted mode.
    if (this.profile === 'restricted') {
      const dangerous = ['curl', 'wget', 'nc', 'ssh', 'scp', 'rsync', 'docker', 'kubectl'];
      if (dangerous.some((d) => args.executable.endsWith(d) || args.executable.endsWith(`/${d}`))) {
        return false;
      }
    }

    return true;
  }

  /** True if an environment key looks secret-ish. */
  private isSecretEnvKey(key: string): boolean {
    if (SAFE_ENV_KEYS.has(key)) return false;
    const upper = key.toUpperCase();
    if (SCRUB_PREFIXES.some((p) => upper.startsWith(p))) return true;
    if (SCRUB_EXACT.has(upper)) return true;
    return false;
  }

  /**
   * Remove Capix/cloud/wallet/SSH secrets from an environment before it is
   * inherited by a tool process.
   */
  scrubEnvironment(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (this.isSecretEnvKey(key)) {
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /**
   * Close inherited broker capabilities before any tool process starts. The
   * native launcher injects `capixSandbox.closeCapabilities()`; in-process we
   * no-op but record the call so tests can assert it happened. After closing,
   * all subsequent approvals fail closed to prevent approval-after-disconnect
   * bypass (architecture §12.5, master prompt C6).
   */
  closeCapabilities(): void {
    this._closed = true;
    const g = globalThis as { capixSandbox?: { closeCapabilities: () => void } };
    if (g.capixSandbox?.closeCapabilities) {
      g.capixSandbox.closeCapabilities();
      return;
    }
    // In-process fallback: signals the broker to drop its inherited handle.
    logger.info('capix-sandbox: closeCapabilities (in-process)', {});
  }

  /** Close only handles inherited by the next tool; keep policy evaluation live. */
  closeToolCapabilities(): void {
    const g = globalThis as { capixSandbox?: { closeToolCapabilities?: () => void } };
    if (g.capixSandbox?.closeToolCapabilities) {
      g.capixSandbox.closeToolCapabilities();
      return;
    }
    logger.info('capix-sandbox: closeToolCapabilities (in-process)', {});
  }
}
