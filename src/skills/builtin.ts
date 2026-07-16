/**
 * Built-in first-party skills shipped with capix-code.
 *
 * Each entry omits `installedAt` (stamped on install by the runtime) and
 * `signature` (computed from the definition). The `trigger` field is a regex
 * tested (case-insensitive) against the task string by `SkillsRuntime.autoSelect`.
 */

import type { LocalSkill } from './runtime.js';
import { SITE_BUILDER_SKILL } from './site-builder.js';

export const BUILTIN_SKILLS: Omit<LocalSkill, 'installedAt' | 'signature'>[] = [
  {
    id: 'capix-orientation',
    name: 'Project Orientation',
    description: 'Analyze a repository and produce a compact architecture summary',
    version: '1.0.0',
    trigger: 'understand|orient|analyze.*project|architecture',
    systemPrompt:
      'You are analyzing a codebase. Read the entry points, list the key modules, identify the framework, and produce a 2-paragraph orientation summary.',
    permissions: ['read'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-tdd',
    name: 'Test-Driven Development',
    description: 'Write tests first, then implement to pass them',
    version: '1.0.0',
    trigger: 'test|spec|tdd|test.driven',
    systemPrompt:
      'Follow TDD: 1) Write a failing test 2) Write minimal code to pass 3) Refactor. Always run the test before and after implementation.',
    permissions: ['read', 'write', 'bash'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-refactor',
    name: 'Safe Refactoring',
    description: 'Refactor code while preserving behavior',
    version: '1.0.0',
    trigger: 'refactor|clean.*up|simplify|extract.*method',
    systemPrompt:
      'When refactoring: 1) Run existing tests to establish baseline 2) Make one change at a time 3) Run tests after each change 4) If tests fail, revert immediately. Never change behavior without a test.',
    permissions: ['read', 'write', 'bash'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-debug',
    name: 'Systematic Debugging',
    description: 'Debug issues systematically using evidence',
    version: '1.0.0',
    trigger: 'bug|debug|error|fail|broken|wrong',
    systemPrompt:
      "Debug systematically: 1) Read the error message precisely 2) Find the exact line that fails 3) Understand WHY it fails (don't guess) 4) Propose a fix 5) Verify the fix doesn't break other tests. Distinguish between observed fact, inference, and assumption.",
    permissions: ['read', 'write', 'bash'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-review',
    name: 'Code Review',
    description: 'Review code changes for quality and security',
    version: '1.0.0',
    trigger: 'review|check.*code|audit',
    systemPrompt:
      'Review code changes: 1) Check for correctness 2) Check for security issues 3) Check for performance 4) Check for readability 5) Suggest specific improvements with code snippets. Be specific, not generic.',
    permissions: ['read'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-deploy',
    name: 'Safe Deployment',
    description: 'Deploy code to Capix Cloud with proper checks',
    version: '1.0.0',
    trigger: 'deploy|ship|release|publish',
    systemPrompt:
      'When deploying: 1) Run all tests 2) Check typecheck 3) Run lint 4) If any fail, FIX them before deploying 5) Create a quote 6) Get approval 7) Deploy 8) Verify the deployment is healthy 9) Clean up any test resources.',
    permissions: ['read', 'write', 'bash'],
    enabled: true,
    pinned: false,
  },
  SITE_BUILDER_SKILL,
  {
    id: 'capix-infra-testing',
    name: 'Infrastructure Testing',
    description: 'Test VPS, database, nginx, SSL, and Docker deployments',
    version: '1.0.0',
    trigger: 'infra.*test|deployment.*test|vps.*test|server.*test|ssl.*check',
    systemPrompt: 'Verify: 1) VPS reachable via SSH 2) Docker container running 3) Nginx responds 4) SSL valid 5) Database accepts connections 6) App returns 200 on health endpoint. Report PASS/FAIL for each.',
    permissions: ['read', 'bash'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-mcp-ops',
    name: 'MCP Operations',
    description: 'Manage MCP server lifecycle, tool discovery, and health checks',
    version: '1.0.0',
    trigger: 'mcp.*status|mcp.*doctor|mcp.*tool|mcp.*health|mcp.*reconnect',
    systemPrompt: 'Check MCP server health, list available tools, verify tool inventory, test one authenticated tool call, and report the health state.',
    permissions: ['read', 'bash'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-memory',
    name: 'Memory Management',
    description: 'Store, retrieve, and manage project memory and decisions',
    version: '1.0.0',
    trigger: 'remember|forget|memory|recall|past.*decision',
    systemPrompt: 'Store significant decisions, retrieve relevant past context, supersede outdated memories, and anchor important memories on-chain. Use [memory] prefix for new entries.',
    permissions: ['read'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-governance',
    name: 'Governance and Covenant',
    description: 'Manage covenant rules, check permissions, and enforce governance',
    version: '1.0.0',
    trigger: 'covenant|governance|rule.*enforce|permission.*check|policy',
    systemPrompt: 'Manage covenant rules, check permissions before actions, enforce governance policies, and report violations. Rules are versioned and append-only.',
    permissions: ['read'],
    enabled: true,
    pinned: false,
  },
  {
    id: 'capix-release-verify',
    name: 'Release Verification',
    description: 'Verify release artifacts, checksums, and version alignment',
    version: '1.0.0',
    trigger: 'release.*verify|checksum|artifact.*verify|version.*align',
    systemPrompt: 'Verify: 1) Package version matches 2) SHA-256 checksums valid 3) SBOM present 4) Platform packages aligned 5) Provenance complete. Report PASS/FAIL.',
    permissions: ['read', 'bash'],
    enabled: true,
    pinned: false,
  },
];
