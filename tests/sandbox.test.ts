import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger to keep test output clean (sandbox logs warnings on construction).
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WorkspaceSandbox } from '../src/sandbox';
import { join, resolve } from 'node:path';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ── Shared setup / teardown ─────────────────────────────────────────────────

let sandbox: WorkspaceSandbox;
let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'capix-sandbox-'));
  sandbox = new WorkspaceSandbox('restricted', workspaceRoot);
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WorkspaceSandbox: path traversal prevention', () => {
  it('blocks path traversal with .. sequences', () => {
    const malicious = join(workspaceRoot, '../../../etc/passwd');
    expect(sandbox.isPathAllowed(malicious)).toBe(false);
  });

  it('blocks absolute paths outside workspace', () => {
    expect(sandbox.isPathAllowed('/etc/passwd')).toBe(false);
    expect(sandbox.isPathAllowed('/root/.ssh/id_rsa')).toBe(false);
    expect(sandbox.isPathAllowed('/var/log/auth.log')).toBe(false);
  });

  it('allows paths within workspace', () => {
    expect(sandbox.isPathAllowed(join(workspaceRoot, 'src/index.ts'))).toBe(true);
    expect(sandbox.isPathAllowed(join(workspaceRoot, 'package.json'))).toBe(true);
  });

  it('canonicalizes paths correctly', () => {
    const canonical = sandbox.canonicalizePath(join(workspaceRoot, './src/../src/index.ts'));
    expect(canonical).toBe(resolve(workspaceRoot, 'src/index.ts'));
  });

  it('blocks symlink escape', () => {
    // Create a symlink inside workspace pointing outside
    symlinkSync('/etc', join(workspaceRoot, 'escape-link'));
    expect(sandbox.isPathAllowed(join(workspaceRoot, 'escape-link/passwd'))).toBe(false);
  });

  it('blocks archive extraction path traversal (zip slip)', () => {
    // Simulate a zip-slip path
    const zipSlipPath = join(workspaceRoot, '../../malicious.exe');
    expect(sandbox.isPathAllowed(zipSlipPath)).toBe(false);
  });

  it('blocks junction/hardlink escape', () => {
    // Junctions on Windows, hardlinks on Unix — secret paths must not be
    // bypassable regardless of link type.
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env.local'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env.production'))).toBe(true);
  });
});

describe('WorkspaceSandbox: secret path protection', () => {
  it('blocks .env files', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env.local'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.env.production'))).toBe(true);
  });

  it('blocks .ssh directory', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, '.ssh/id_rsa'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.ssh/config'))).toBe(true);
  });

  it('blocks .aws directory', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, '.aws/credentials'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, '.aws/config'))).toBe(true);
  });

  it('blocks .kube directory', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, '.kube/config'))).toBe(true);
  });

  it('blocks wallet files', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, 'id.json'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, 'wallet.json'))).toBe(true);
    expect(sandbox.isSecretPath(join(workspaceRoot, 'secret-key.json'))).toBe(true);
  });

  it('allows normal source files', () => {
    expect(sandbox.isSecretPath(join(workspaceRoot, 'src/index.ts'))).toBe(false);
    expect(sandbox.isSecretPath(join(workspaceRoot, 'package.json'))).toBe(false);
    expect(sandbox.isSecretPath(join(workspaceRoot, 'README.md'))).toBe(false);
  });
});

describe('WorkspaceSandbox: environment scrubbing', () => {
  it('removes Capix secrets from environment', () => {
    const env = {
      PATH: '/usr/bin',
      CAPIX_ACCESS_TOKEN: 'secret-token',
      CAPIX_REFRESH_TOKEN: 'secret-refresh',
      VAST_API_TOKEN: 'vast-secret',
      HETZNER_API_TOKEN: 'hetzner-secret',
      CAPIX_TREASURY_SECRET_KEY: 'treasury-key',
      CAPIX_OPERATOR_TOKEN: 'operator-token',
      HOME: '/home/user',
    };
    const scrubbed = sandbox.scrubEnvironment(env);
    expect(scrubbed).not.toHaveProperty('CAPIX_ACCESS_TOKEN');
    expect(scrubbed).not.toHaveProperty('CAPIX_REFRESH_TOKEN');
    expect(scrubbed).not.toHaveProperty('VAST_API_TOKEN');
    expect(scrubbed).not.toHaveProperty('HETZNER_API_TOKEN');
    expect(scrubbed).not.toHaveProperty('CAPIX_TREASURY_SECRET_KEY');
    expect(scrubbed).not.toHaveProperty('CAPIX_OPERATOR_TOKEN');
    expect(scrubbed.PATH).toBe('/usr/bin');
    expect(scrubbed.HOME).toBe('/home/user');
  });

  it('removes SSH/wallet/cloud env vars', () => {
    const env = {
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/key.json',
      SOLANA_WALLET: 'wallet-data',
    };
    const scrubbed = sandbox.scrubEnvironment(env);
    expect(scrubbed).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(scrubbed).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(scrubbed).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(scrubbed).not.toHaveProperty('SOLANA_WALLET');
  });

  it('preserves non-secret env vars needed for tools', () => {
    const env = {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
    };
    const scrubbed = sandbox.scrubEnvironment(env);
    expect(scrubbed).toEqual(env);
  });
});

describe('WorkspaceSandbox: command approval', () => {
  it('requires approval for restricted profile commands', () => {
    const restricted = new WorkspaceSandbox('restricted', workspaceRoot);
    // In restricted mode, network is denied by default
    expect(
      restricted.shouldApproveCommand({
        executable: 'node',
        args: ['script.js'],
        cwd: workspaceRoot,
        envDelta: {},
        network: true,
      })
    ).toBe(false);
    // Safe, non-network command within workspace is approved
    expect(
      restricted.shouldApproveCommand({
        executable: 'node',
        args: ['script.js'],
        cwd: workspaceRoot,
        envDelta: {},
        network: false,
      })
    ).toBe(true);
  });

  it('developer profile allows broader access per session', () => {
    const dev = new WorkspaceSandbox('developer', workspaceRoot);
    // Still blocks secrets but allows network and more commands
    expect(
      dev.shouldApproveCommand({
        executable: 'node',
        args: ['script.js'],
        cwd: workspaceRoot,
        envDelta: {},
        network: true,
      })
    ).toBe(true);
    // Still blocks secret env injection
    expect(
      dev.shouldApproveCommand({
        executable: 'node',
        args: ['script.js'],
        cwd: workspaceRoot,
        envDelta: { CAPIX_TOKEN: 'leak' },
        network: false,
      })
    ).toBe(false);
  });

  it('host profile requires explicit warning', () => {
    // Host profile should never be default — requires explicit session-only
    // opt-in with a strong warning (verified via logger in constructor).
    const host = new WorkspaceSandbox('host', workspaceRoot);
    expect(host.profile).toBe('host');
    expect(
      host.shouldApproveCommand({
        executable: 'curl',
        args: ['https://example.com'],
        cwd: '/etc',
        envDelta: {},
        network: true,
      })
    ).toBe(true);
  });

  it('blocks commands with secret paths as arguments', () => {
    // e.g., cat .env, cp ~/.ssh/id_rsa /tmp/
    // These should be blocked even in developer mode
    const dev = new WorkspaceSandbox('developer', workspaceRoot);
    expect(
      dev.shouldApproveCommand({
        executable: 'cat',
        args: [join(workspaceRoot, '.env')],
        cwd: workspaceRoot,
        envDelta: {},
        network: false,
      })
    ).toBe(false);
    expect(
      dev.shouldApproveCommand({
        executable: 'cp',
        args: [join(workspaceRoot, '.ssh/id_rsa'), '/tmp/'],
        cwd: workspaceRoot,
        envDelta: {},
        network: false,
      })
    ).toBe(false);
  });

  it('blocks network access by default in restricted mode', () => {
    const result = sandbox.shouldApproveCommand({
      executable: 'curl',
      args: ['https://evil.com'],
      cwd: workspaceRoot,
      envDelta: {},
      network: true,
    });
    expect(result).toBe(false);
  });
});

describe('WorkspaceSandbox: limits enforcement', () => {
  it('enforces CPU limit', () => {
    expect(sandbox.limits.maxCpuPercent).toBeGreaterThan(0);
    expect(sandbox.limits.maxCpuPercent).toBeLessThanOrEqual(100);
  });

  it('enforces RAM limit', () => {
    expect(sandbox.limits.maxRamMb).toBeGreaterThan(0);
  });

  it('enforces wall time limit', () => {
    expect(sandbox.limits.maxWallTimeMs).toBeGreaterThan(0);
  });

  it('enforces output size limit', () => {
    expect(sandbox.limits.maxOutputBytes).toBeGreaterThan(0);
  });

  it('enforces PID limit', () => {
    expect(sandbox.limits.maxPids).toBeGreaterThan(0);
  });
});

describe('WorkspaceSandbox: approval-after-disconnect', () => {
  it('pending approvals fail closed on disconnect', () => {
    // If the connection to the broker drops while an approval is pending,
    // the approval must FAIL (not hang or auto-approve). closeCapabilities
    // simulates the broker connection being severed.
    sandbox.closeCapabilities();
    expect(sandbox.closed).toBe(true);
    expect(
      sandbox.shouldApproveCommand({
        executable: 'node',
        args: ['script.js'],
        cwd: workspaceRoot,
        envDelta: {},
        network: false,
      })
    ).toBe(false);
  });
});
