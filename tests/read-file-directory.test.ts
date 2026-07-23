import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinTools } from '../packages/agent-runtime/src/tools';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('read_file directory handling', () => {
  it('returns a bounded directory listing instead of leaking EISDIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capix-read-directory-'));
    workspaces.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{"name":"capix-test"}');

    const tool = createBuiltinTools().find((candidate) => candidate.name === 'read_file')!;
    const result = await tool.execute(
      { path: '.' },
      { sessionId: 'session', turnId: 'turn', workspaceRoot: root },
    );

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('. is a directory');
    expect(result.output).toContain('file\tpackage.json');
    expect(result.output).toContain('directory\tsrc');
    expect(result.metadata).toMatchObject({ kind: 'directory', count: 2 });
  });
});
