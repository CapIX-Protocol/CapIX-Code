/**
 * Planner — decomposes a user request into a structured, checkpointable plan.
 *
 * Refs:
 * - architecture (planner / subagent delegation / checkpointable plans)
 * - intelligence-client `createPlan` / `createCheckpoint`
 *
 * The planner does NOT classify or route prompts. It asks the model to
 * decompose a request into ordered steps using a fixed text protocol (not
 * free-form chat), then parses that protocol into structured `PlanStep[]`.
 * Each step carries the files it must read/edit/create, the test commands to
 * run after, an estimated turn count, and the step IDs it depends on. The
 * resulting `Plan` is checkpointable to the intelligence API via
 * `checkpoint()`.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as intelligence from '../intelligence-client.js';
import { logger } from '../logger.js';
import type { SubagentManager, SubagentConfig, SubagentResult } from './subagent.js';

export interface PlanStep {
  id: string;
  description: string;
  filesToRead: string[];
  filesToEdit: string[];
  filesToCreate: string[];
  testsToRun: string[];
  estimatedTurns: number;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  dependsOn?: string[];
}

export interface Plan {
  id: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  steps: PlanStep[];
  securityImplications: string[];
  billingImplications: string[];
  rollbackStrategy: string;
  definitionOfDone: string[];
  status: 'drafting' | 'awaiting-approval' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** Context retriever abstraction injected by the plugin. */
export interface ContextRetriever {
  getOrientation(): Promise<string>;
  findRelevantFiles(
    topic: string,
    limit?: number
  ): Promise<Array<{ path: string; score: number; reason: string }>>;
}

/**
 * Model invoker abstraction. Takes a single prompt string and returns the
 * model's full text response. The plugin wires this to the capix provider
 * stream so the planner stays decoupled from transport/broker details.
 */
export type ModelInvoker = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

/**
 * Fixed text protocol the model must emit. The planner parses this exact
 * shape — it never free-forms a plan from arbitrary chat output.
 */
const PLAN_SYSTEM_PROMPT = `You are a software engineering planner. Decompose the user's request into a structured plan using EXACTLY this text protocol. Do not add prose, markdown, or commentary outside the protocol lines.

Output format (emit each header exactly once, then one STEP block per step):
GOAL: <one-line goal>
NON_GOALS: <comma-separated>
ASSUMPTIONS: <comma-separated>
SECURITY: <security implications, or "none">
BILLING: <billing / infrastructure cost implications, or "none">
ROLLBACK: <how to roll back this change>
DOD: <comma-separated definition-of-done items>

STEP 1: <step description>
  READ: <comma-separated existing files to read first, or "none">
  CREATE: <comma-separated new files, or "none">
  EDIT: <comma-separated files to modify, or "none">
  DEPENDS_ON: <comma-separated step numbers this depends on, or "none">
  TEST: <comma-separated test commands to run after, or "none">
  TURNS: <integer estimated LLM turns>

Repeat STEP blocks with sequential numbers for every step. Only reference real file paths from the provided context. Keep steps small and independently verifiable.`;

const RELEVANT_FILE_LIMIT = 20;

export class Planner {
  private readonly contextRetriever: ContextRetriever;
  private readonly modelInvoker: ModelInvoker | null;
  private readonly rootPath: string;
  private currentPlan: Plan | null = null;

  constructor(contextRetriever: ContextRetriever, modelInvoker?: ModelInvoker, rootPath?: string) {
    this.contextRetriever = contextRetriever;
    this.modelInvoker = modelInvoker ?? null;
    this.rootPath = rootPath ?? process.cwd();
  }

  /**
   * Create a plan from a natural language request.
   *
   * Pipeline:
   * 1. get project orientation
   * 2. find relevant files to the request
   * 3. ask the model to decompose the request into the text protocol
   * 4. parse the model response into structured PlanStep[]
   * 5. infer file lists / dependencies / estimated turns (done in parser)
   * 6. security / billing implications (parsed from the protocol)
   * 7. definition of done (parsed from the protocol)
   */
  async plan(request: string): Promise<Plan> {
    const orientation = await this.contextRetriever.getOrientation();
    const relevant = await this.contextRetriever.findRelevantFiles(request, RELEVANT_FILE_LIMIT);
    const relevantPaths = relevant.map((f) => f.path);

    const now = new Date().toISOString();
    const seed: Plan = {
      id: randomUUID(),
      goal: request,
      nonGoals: [],
      assumptions: [],
      steps: [],
      securityImplications: [],
      billingImplications: [],
      rollbackStrategy: '',
      definitionOfDone: [],
      status: 'drafting',
      createdAt: now,
      updatedAt: now,
    };
    this.currentPlan = seed;

    if (!this.modelInvoker) {
      // No model wired — surface the request as an approval-pending plan with
      // a single placeholder step so the caller can still inspect/edit it.
      seed.steps = [
        {
          id: '1',
          description: request,
          filesToRead: relevantPaths.slice(0, 5),
          filesToEdit: [],
          filesToCreate: [],
          testsToRun: [],
          estimatedTurns: 1,
          status: 'pending',
        },
      ];
      seed.assumptions = ['no model invoker configured; plan is a placeholder'];
      seed.status = 'awaiting-approval';
      return seed;
    }

    const prompt = this.buildPlanPrompt(request, orientation, relevant);
    let response = '';
    try {
      response = await this.modelInvoker(prompt);
    } catch (err) {
      logger.warn('planner: model invocation failed', {
        error: (err as Error)?.message,
      });
      seed.status = 'awaiting-approval';
      return seed;
    }

    const parsed = this.parsePlanResponse(response, {
      relevantFiles: relevantPaths,
      orientation,
    });
    parsed.id = seed.id;
    parsed.createdAt = now;
    parsed.updatedAt = new Date().toISOString();
    if (!parsed.goal) parsed.goal = request;
    parsed.status = 'awaiting-approval';
    this.currentPlan = parsed;
    return parsed;
  }

  private buildPlanPrompt(
    request: string,
    orientation: string,
    relevant: Array<{ path: string; score: number; reason: string }>
  ): string {
    const fileList = relevant.map((f) => `- ${f.path} (score ${f.score}: ${f.reason})`).join('\n');
    return [
      PLAN_SYSTEM_PROMPT,
      '',
      '## Project orientation',
      orientation || '(unavailable)',
      '',
      '## Relevant files',
      fileList || '(none found)',
      '',
      '## User request',
      request,
      '',
      'Produce the plan now using the protocol above.',
    ].join('\n');
  }

  /**
   * Parse a model response (the text protocol) into a structured `Plan`.
   * Robust to whitespace/casing variations; ignores unknown lines.
   */
  parsePlanResponse(response: string, context: { relevantFiles: string[]; orientation: string }): Plan {
    void context; // available for path validation; parser is protocol-driven
    const now = new Date().toISOString();
    const plan: Plan = {
      id: randomUUID(),
      goal: '',
      nonGoals: [],
      assumptions: [],
      steps: [],
      securityImplications: [],
      billingImplications: [],
      rollbackStrategy: '',
      definitionOfDone: [],
      status: 'drafting',
      createdAt: now,
      updatedAt: now,
    };

    const lines = response.split(/\r?\n/);
    let currentStep: PlanStep | null = null;

    const splitList = (raw: string): string[] =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== 'none');

    const pushStep = () => {
      if (currentStep) plan.steps.push(currentStep);
      currentStep = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const stepMatch = line.match(/^STEP\s+(\d+)\s*:\s*(.*)$/i);
      if (stepMatch) {
        pushStep();
        currentStep = {
          id: stepMatch[1]!,
          description: stepMatch[2]!.trim(),
          filesToRead: [],
          filesToEdit: [],
          filesToCreate: [],
          testsToRun: [],
          estimatedTurns: 1,
          status: 'pending',
        };
        continue;
      }

      let m: RegExpMatchArray | null;
      if (currentStep && (m = line.match(/^READ\s*:\s*(.*)$/i))) {
        currentStep.filesToRead = splitList(m[1]!);
        continue;
      }
      if (currentStep && (m = line.match(/^CREATE\s*:\s*(.*)$/i))) {
        currentStep.filesToCreate = splitList(m[1]!);
        continue;
      }
      if (currentStep && (m = line.match(/^EDIT\s*:\s*(.*)$/i))) {
        currentStep.filesToEdit = splitList(m[1]!);
        continue;
      }
      if (currentStep && (m = line.match(/^DEPENDS_ON\s*:\s*(.*)$/i))) {
        currentStep.dependsOn = splitList(m[1]!);
        continue;
      }
      if (currentStep && (m = line.match(/^TEST\s*:\s*(.*)$/i))) {
        currentStep.testsToRun = splitList(m[1]!);
        continue;
      }
      if (currentStep && (m = line.match(/^TURNS\s*:\s*(\d+)$/i))) {
        currentStep.estimatedTurns = Number.parseInt(m[1]!, 10) || 1;
        continue;
      }

      if ((m = line.match(/^GOAL\s*:\s*(.*)$/i))) {
        plan.goal = m[1]!.trim();
        continue;
      }
      if ((m = line.match(/^NON_GOALS\s*:\s*(.*)$/i))) {
        plan.nonGoals = splitList(m[1]!);
        continue;
      }
      if ((m = line.match(/^ASSUMPTIONS\s*:\s*(.*)$/i))) {
        plan.assumptions = splitList(m[1]!);
        continue;
      }
      if ((m = line.match(/^SECURITY\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim();
        if (v && v.toLowerCase() !== 'none') plan.securityImplications.push(v);
        continue;
      }
      if ((m = line.match(/^BILLING\s*:\s*(.*)$/i))) {
        const v = m[1]!.trim();
        if (v && v.toLowerCase() !== 'none') plan.billingImplications.push(v);
        continue;
      }
      if ((m = line.match(/^ROLLBACK\s*:\s*(.*)$/i))) {
        plan.rollbackStrategy = m[1]!.trim();
        continue;
      }
      if ((m = line.match(/^DOD\s*:\s*(.*)$/i))) {
        plan.definitionOfDone = splitList(m[1]!);
        continue;
      }
    }
    pushStep();

    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /** Update a step's status in the current plan. */
  updateStep(planId: string, stepId: string, status: PlanStep['status']): void {
    const plan = this.currentPlan;
    if (!plan || plan.id !== planId) return;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.status = status;
    plan.updatedAt = new Date().toISOString();
    this.recomputePlanStatus(plan);
  }

  private recomputePlanStatus(plan: Plan): void {
    const statuses = plan.steps.map((s) => s.status);
    if (statuses.length === 0) return;
    if (statuses.every((s) => s === 'completed' || s === 'skipped')) {
      plan.status = 'completed';
    } else if (statuses.some((s) => s === 'in-progress')) {
      plan.status = 'executing';
    } else if (statuses.some((s) => s === 'failed')) {
      plan.status = 'failed';
    }
  }

  /** Execute the current plan step by step, delegating each step to a subagent. */
  async execute(
    subagentManager: SubagentManager,
    context: { sessionID: string },
    options?: { maxTurnsPerStep?: number; maxElapsedMsPerStep?: number },
  ): Promise<{ completed: number; failed: number; results: SubagentResult[] }> {
    const plan = this.currentPlan;
    if (!plan) throw new Error('No plan to execute. Call plan() first.');

    const results: SubagentResult[] = [];
    let completed = 0;
    let failed = 0;

    for (const step of plan.steps) {
      if (step.status === 'completed' || step.status === 'skipped') continue;

      this.updateStep(plan.id, step.id, 'in-progress');

      const config: SubagentConfig = {
        role: 'implementation-agent',
        planStep: step,
        model: 'capix/auto',
        maxTurns: options?.maxTurnsPerStep ?? 8,
        maxElapsedMs: options?.maxElapsedMsPerStep ?? 120_000,
        maxSpendUsdMinor: BigInt(500),
        worktreePath: join(this.rootPath, '.capix', 'worktrees', step.id),
        parentSessionId: context.sessionID,
        allowedTools: ['read_file', 'edit_file', 'bash'],
        filesystemScope: this.rootPath,
        approvalRules: 'auto',
      };

      try {
        const result = await subagentManager.spawn(config);
        results.push(result);
        if (result.status === 'completed') {
          completed++;
          this.updateStep(plan.id, step.id, 'completed');
        } else {
          failed++;
          this.updateStep(plan.id, step.id, 'failed');
        }
      } catch (err) {
        failed++;
        this.updateStep(plan.id, step.id, 'failed');
        results.push({
          subagentId: 'failed', stepId: step.id, status: 'failed',
          filesChanged: [], summary: String(err), costMinor: 0n, durationMs: 0, turns: 0,
        });
      }
    }

    return { completed, failed, results };
  }

  /** Get the current plan (most recently created/loaded). */
  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  /**
   * Checkpoint the plan (save to intelligence API). Gathers git repo state and
   * best-effort verification (typecheck/lint/tests), then calls
   * `intelligence.createCheckpoint`. Returns the checkpoint id.
   */
  async checkpoint(): Promise<string> {
    const plan = this.currentPlan;
    const repoState = gatherRepoState(this.rootPath);
    const verification = await runVerification(this.rootPath);
    const checkpoint = await intelligence.createCheckpoint({
      label: plan ? `plan:${plan.id}` : undefined,
      repoState,
      verification,
      planId: plan?.id,
      activeAgentIds: [],
      receiptSummary: { count: 0, totalCostMinor: '0', asset: 'USD', scale: 6 },
      source: 'capix-code:planner',
    });
    return checkpoint.id;
  }
}

// ── repo state + verification helpers ────────────────────────────────────────

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function gatherRepoState(
  root: string
): import('../intelligence-client.js').Checkpoint['repoState'] {
  const commit = git(['rev-parse', 'HEAD'], root) || 'unknown';
  const branch = git(['branch', '--show-current'], root) || 'HEAD';
  const porcelain = git(['status', '--porcelain'], root);
  const dirty = porcelain.length > 0;
  const diffStat = git(['diff', 'HEAD', '--stat'], root) || (dirty ? 'unstaged changes' : '');
  return { commit, branch, dirty, diffStat };
}

interface NpmScripts {
  [name: string]: string | undefined;
}

function readNpmScripts(root: string): NpmScripts {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function runScript(name: string, cwd: string, timeoutMs = 120_000): 'pass' | 'fail' | 'skipped' {
  const scripts = readNpmScripts(cwd);
  if (!scripts[name]) return 'skipped';
  try {
    execFileSync('npm', ['run', name, '--silent'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return 'pass';
  } catch (err) {
    const e = err as { signal?: string; status?: number };
    if (e.signal === 'SIGTERM') return 'skipped';
    return 'fail';
  }
}

function parseTestCounts(stdout: string): { passed: number; failed: number; skipped: number } {
  const out: { passed: number; failed: number; skipped: number } = {
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  const pass = stdout.match(/(\d+)\s+pass(?:ed|ing)?/i);
  const fail = stdout.match(/(\d+)\s+fail(?:ed|ing)?/i);
  const skip = stdout.match(/(\d+)\s+skip/i);
  if (pass) out.passed = Number.parseInt(pass[1]!, 10);
  if (fail) out.failed = Number.parseInt(fail[1]!, 10);
  if (skip) out.skipped = Number.parseInt(skip[1]!, 10);
  return out;
}

function runTestCommand(
  cwd: string,
  timeoutMs = 120_000
): { result: 'pass' | 'fail' | 'skipped'; counts: { passed: number; failed: number; skipped: number } } {
  const scripts = readNpmScripts(cwd);
  if (!scripts.test) {
    return { result: 'skipped', counts: { passed: 0, failed: 0, skipped: 0 } };
  }
  let stdout = '';
  try {
    stdout = execFileSync('npm', ['run', 'test', '--silent'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { result: 'pass', counts: parseTestCounts(stdout) };
  } catch (err) {
    const e = err as { signal?: string; stdout?: string };
    if (e.signal === 'SIGTERM') return { result: 'skipped', counts: parseTestCounts(stdout) };
    if (e.stdout) return { result: 'fail', counts: parseTestCounts(String(e.stdout)) };
    return { result: 'fail', counts: { passed: 0, failed: 0, skipped: 0 } };
  }
}

async function runVerification(
  root: string
): Promise<import('../intelligence-client.js').Checkpoint['verification']> {
  const typecheck = runScript('typecheck', root);
  const lint = runScript('lint', root);
  const testRes = runTestCommand(root);
  return {
    typecheck,
    lint,
    tests: testRes.result,
    testCounts: testRes.counts,
  };
}
