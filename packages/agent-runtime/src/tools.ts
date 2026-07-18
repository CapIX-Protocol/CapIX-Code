/**
 * @capix/agent-runtime — tool registry and built-in tools.
 *
 * Tools are the runtime's only way to cause side effects. Every tool
 * declares a risk class; the runtime checks the session's mode permission
 * profile before executing (see modes.ts). Hosts (the TUI plugin, CapixIDE)
 * register their own tools — codebase search, MCP tools, deploy verbs — on
 * top of the built-in file/shell tools provided here.
 *
 * Built-in tools are workspace-rooted: paths are resolved against the
 * session's workspace root and rejected if they escape it.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { ToolRiskClass } from './modes.js';

export interface ToolContext {
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Files the tool created or modified (relative to the workspace root). */
  filesChanged?: string[];
  /** Extra detail surfaced in the tool.output event metadata. */
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  riskClass: ToolRiskClass;
  /**
   * When true, the runtime asks for approval even in modes whose risk-class
   * policy is `allow` (used for side-effectful host tools like deploy).
   */
  alwaysRequiresApproval?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** Resolve `filePath` inside `workspaceRoot`; throw if it escapes. */
export function resolveWorkspacePath(workspaceRoot: string, filePath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolvePromise({
            output: `exit ${typeof code === 'number' ? code : 1}: ${stderr || error.message}`,
            isError: true,
          });
        } else {
          resolvePromise({ output: stdout + (stderr ? `\n${stderr}` : '') });
        }
      }
    );
  });
}

/** The built-in workspace tools every runtime starts with. */
export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      riskClass: 'read',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const content = await readFile(path, 'utf8');
        return { output: content };
      },
    },
    {
      name: 'write_file',
      description: 'Write (create or overwrite) a file in the workspace.',
      riskClass: 'write',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const content = String(args.content ?? '');
        await writeFile(path, content, 'utf8');
        return { output: `wrote ${path}`, filesChanged: [String(args.path ?? '')] };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a workspace file.',
      riskClass: 'write',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const before = await readFile(path, 'utf8');
        const oldString = String(args.old_string ?? '');
        const newString = String(args.new_string ?? '');
        if (!oldString || !before.includes(oldString)) {
          return { output: `old_string not found in ${args.path}`, isError: true };
        }
        await writeFile(path, before.replace(oldString, newString), 'utf8');
        return { output: `edited ${path}`, filesChanged: [String(args.path ?? '')] };
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command in the workspace.',
      riskClass: 'execute',
      async execute(args, ctx) {
        const command = String(args.command ?? '');
        if (!command.trim()) return { output: 'empty command', isError: true };
        const timeoutMs = Number(args.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS);
        return runShell(command, ctx.workspaceRoot, timeoutMs);
      },
    },
  ];
}
