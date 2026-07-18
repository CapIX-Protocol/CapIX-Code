import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const launcher = readFileSync(join(root, 'launcher', 'src', 'main.rs'), 'utf8');
const cargo = readFileSync(join(root, 'launcher', 'Cargo.toml'), 'utf8');
const artifactAssertion = readFileSync(join(root, 'scripts', 'assert-artifact.sh'), 'utf8');

describe('Windows native credential broker release gate', () => {
  it('ships a real local named-pipe server instead of a file-store fallback', () => {
    expect(launcher).toContain('const BROKER_PIPE_NAME: &str = r"\\\\.\\pipe\\capix-code-broker"');
    expect(launcher).toContain('CreateNamedPipeW(');
    expect(launcher).toContain('ConnectNamedPipe(');
    expect(launcher).toContain('ReadFile(');
    expect(launcher).toContain('WriteFile(');
    expect(launcher).not.toContain('Windows falls back to the file-based credential store');
  });

  it('rejects remote clients and applies a protected owner-only DACL', () => {
    expect(launcher).toContain('PIPE_REJECT_REMOTE_CLIENTS');
    expect(launcher).toContain('FILE_FLAG_FIRST_PIPE_INSTANCE');
    expect(launcher).toContain('D:P(A;;GA;;;OW)');
    expect(launcher).toContain('bInheritHandle: 0');
  });

  it('pins the required Windows APIs as target-only dependencies', () => {
    expect(cargo).toContain("[target.'cfg(windows)'.dependencies]");
    expect(cargo).toContain('"Win32_Security_Authorization"');
    expect(cargo).toContain('"Win32_System_Pipes"');
  });

  it('requires the shared endpoint constants in every customer artifact', () => {
    expect(launcher).toContain('root.join("runtime/src/credential-constants.ts")');
    expect(artifactAssertion).toContain('runtime/src/credential-constants.ts');
  });
});
