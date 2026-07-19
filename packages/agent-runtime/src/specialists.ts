/**
 * @capix/agent-runtime — specialist agent definitions.
 *
 * Specialists are role-scoped sub-agents the runtime can spawn as child
 * sessions. Each has a mandate (system prompt), a tool allowlist, hard
 * turn/time/spend bounds, and a file scope that drives the permission
 * profile of its child session. Spend bounds are integer USD minor units.
 *
 * This module is self-contained so both the TUI plugin and CapixIDE can
 * share one definition of the specialist roster.
 */

import type { AgentMode } from './modes.js';

export interface SpecialistAgent {
  role: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTurns: number;
  maxElapsedMs: number;
  /** Hard spend limit in integer USD minor units. */
  maxSpendUsdMinor: bigint;
  fileScope: 'read-only' | 'read-write' | 'read-write-execute';
  /** The mode the specialist's child session runs in. */
  mode: AgentMode;
  icon: string;
  /** The model this specialist uses. Different specialists use different models
   * optimized for their task. Format: "capix/auto" (smart routing), "capix/auto-fast"
   * (cheapest), "capix/auto-balanced" (default), "capix/auto-best" (highest quality),
   * or a specific model id like "capix/llama-3.3-70b". */
  model: string;
}

export const SPECIALIST_AGENTS: Record<string, SpecialistAgent> = {
  explore: {
    role: 'explore',
    name: 'Explore Agent',
    description: 'Reads and understands codebase structure, produces orientation summaries',
    systemPrompt:
      'You are an exploration agent. Read files, understand architecture, and produce concise summaries. You CANNOT edit files. Output: 1) Key files 2) Architecture summary 3) Entry points 4) Dependencies',
    allowedTools: [
      'capix_search_codebase',
      'capix_find_references',
      'capix_get_orientation',
      'read_file',
    ],
    maxTurns: 6,
    maxElapsedMs: 60_000,
    maxSpendUsdMinor: BigInt(200),
    fileScope: 'read-only',
    mode: 'ask',
    icon: '🔍',
    model: 'capix/auto-fast',  // Fast, cheap model for codebase exploration
  },
  implement: {
    role: 'implement',
    name: 'Implement Agent',
    description: 'Writes code, creates files, and applies patches',
    systemPrompt:
      'You are an implementation agent. Read the requirements, implement the code, run tests, and report what you changed. Show diffs. Match existing code style.',
    allowedTools: [
      'read_file',
      'edit_file',
      'write_file',
      'bash',
      'capix_search_codebase',
      'capix_find_references',
    ],
    maxTurns: 12,
    maxElapsedMs: 180_000,
    maxSpendUsdMinor: BigInt(500),
    fileScope: 'read-write-execute',
    mode: 'build',
    icon: '⚡',
    model: 'capix/auto-best',  // Strong coding model for implementation
  },
  test: {
    role: 'test',
    name: 'Test Agent',
    description: 'Writes and runs tests, reports coverage',
    systemPrompt:
      'You are a testing agent. Read the implementation, write test cases, run them, and report results. Always run tests before and after changes. Report: 1) Tests written 2) Pass/fail results 3) Coverage gaps',
    allowedTools: ['read_file', 'write_file', 'edit_file', 'bash', 'capix_search_codebase'],
    maxTurns: 10,
    maxElapsedMs: 120_000,
    maxSpendUsdMinor: BigInt(300),
    fileScope: 'read-write-execute',
    mode: 'build',
    icon: '🧪',
    model: 'capix/auto-balanced',  // Balanced model for test generation
  },
  review: {
    role: 'review',
    name: 'Code Review Agent',
    description: 'Reviews code changes for correctness, security, and quality',
    systemPrompt:
      'You are a code review agent. Read the diff, identify bugs, security issues, performance problems, and style violations. Be specific with file:line references. You CANNOT edit files.',
    allowedTools: [
      'read_file',
      'capix_search_codebase',
      'capix_find_references',
      'capix_get_orientation',
    ],
    maxTurns: 8,
    maxElapsedMs: 90_000,
    maxSpendUsdMinor: BigInt(300),
    fileScope: 'read-only',
    mode: 'review',
    icon: '👀',
    model: 'capix/auto-best',  // Strong reasoning model for code review
  },
  security: {
    role: 'security',
    name: 'Security Agent',
    description: 'Finds vulnerabilities, leaked secrets, and unsafe patterns',
    systemPrompt:
      'You are a security agent. Scan for: 1) Injection vulnerabilities 2) Hardcoded secrets 3) Unsafe deserialization 4) Path traversal 5) SSRF 6) Missing auth checks. You CANNOT edit files.',
    allowedTools: ['read_file', 'capix_search_codebase', 'capix_find_references', 'bash'],
    maxTurns: 8,
    maxElapsedMs: 90_000,
    maxSpendUsdMinor: BigInt(300),
    fileScope: 'read-only',
    mode: 'review',
    icon: '🛡️',
    model: 'capix/auto-best',  // Strong reasoning model for security analysis
  },
  deploy: {
    role: 'deploy',
    name: 'Deploy Agent',
    description: 'Deploys to Capix Cloud with VPS, Docker, nginx, SSL',
    systemPrompt:
      'You are a deployment agent. You can provision a Capix VPS ($7/mo), install Docker/Node/Python/nginx, set up databases, configure reverse proxy, provision SSL, and deploy the app. Always verify the deployment is healthy.',
    allowedTools: [
      'read_file',
      'write_file',
      'edit_file',
      'bash',
      'capix_deploy',
      'capix_start',
      'capix_stop',
      'capix_delete',
    ],
    maxTurns: 15,
    maxElapsedMs: 600_000,
    maxSpendUsdMinor: BigInt(700),
    fileScope: 'read-write-execute',
    mode: 'build',
    icon: '🚀',
    model: 'capix/auto-balanced',  // Balanced model for deployment tasks
  },
};

export function getSpecialist(role: string): SpecialistAgent | null {
  return SPECIALIST_AGENTS[role] ?? null;
}

export function listSpecialists(): SpecialistAgent[] {
  return Object.values(SPECIALIST_AGENTS);
}

export function isSpecialistRole(role: string): boolean {
  return role in SPECIALIST_AGENTS;
}
