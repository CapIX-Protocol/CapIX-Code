/**
 * TUI delegation manager — one-click delegation to specialists.
 *
 * Wraps an `OrchestrationEngine` with the workflow the TUI needs:
 *  - smart specialist suggestions for a free-form task (engine scoring);
 *  - a delegation preview with cost estimation BEFORE anything runs, so the
 *    operator confirms role, context and budget in one step;
 *  - delegation templates for common tasks (explore, implement, test, …);
 *  - one-click `delegate` / `applyTemplate` that resolve the role (explicit >
 *    top suggestion > implement), assemble the handoff context, and queue the
 *    delegation on the engine.
 *
 * Money stays in integer minor units end-to-end (`formatMoney` from
 * routing-client) — never floats.
 */

import {
  OrchestrationEngine,
  estimateDelegationCost,
  getSpecialist,
  suggestSpecialists,
  type Delegation,
  type DelegationCostEstimate,
  type SpecialistSuggestion,
  type TaskComplexity,
} from '@capix/agent-runtime';
import { formatMoney } from '../routing-client.js';

// ── Templates ────────────────────────────────────────────────────────────────

export interface DelegationTemplate {
  id: string;
  label: string;
  role: string;
  description: string;
  /** `{task}` is replaced with the operator's task text. */
  taskTemplate: string;
  /** Optional extra handoff context; `{task}` placeholder supported. */
  contextTemplate?: string;
}

export const DELEGATION_TEMPLATES: readonly DelegationTemplate[] = [
  {
    id: 'explore-codebase',
    label: 'Explore codebase',
    role: 'explore',
    description: 'Map structure, entry points, and dependencies for an area',
    taskTemplate: 'Explore the codebase and explain: {task}',
    contextTemplate: 'Orientation request from the operator. Focus areas: {task}',
  },
  {
    id: 'implement-feature',
    label: 'Implement feature',
    role: 'implement',
    description: 'Write the code for a feature or fix, matching project style',
    taskTemplate: 'Implement the following, matching existing code style: {task}',
  },
  {
    id: 'write-tests',
    label: 'Write tests',
    role: 'test',
    description: 'Add tests for recent changes and report coverage gaps',
    taskTemplate: 'Write and run tests for: {task}. Report pass/fail and coverage gaps.',
  },
  {
    id: 'review-changes',
    label: 'Review changes',
    role: 'review',
    description: 'Review the current diff for bugs, style, and quality',
    taskTemplate: 'Review the current changes for correctness and quality: {task}',
  },
  {
    id: 'security-audit',
    label: 'Security audit',
    role: 'security',
    description: 'Scan for vulnerabilities, secrets, and unsafe patterns',
    taskTemplate: 'Security audit: {task}. Check injection, secrets, traversal, SSRF, auth.',
  },
  {
    id: 'deploy-cloud',
    label: 'Deploy to cloud',
    role: 'deploy',
    description: 'Provision and deploy to Capix Cloud with SSL and health checks',
    taskTemplate: 'Deploy to Capix Cloud: {task}. Verify the deployment is healthy.',
  },
];

export function getDelegationTemplate(id: string): DelegationTemplate | null {
  return DELEGATION_TEMPLATES.find((t) => t.id === id) ?? null;
}

// ── Preview ──────────────────────────────────────────────────────────────────

export interface DelegationPreview {
  role: string;
  name: string;
  icon: string;
  model: string;
  task: string;
  context: string;
  estimate: DelegationCostEstimate;
  /** Other specialists worth considering, best first. */
  alternatives: SpecialistSuggestion[];
  /** Template the preview was built from, if any. */
  templateId: string | null;
}

export interface DelegateOptions {
  /** Force a role; otherwise the top suggestion wins (default: implement). */
  role?: string;
  /** Extra operator-supplied handoff context. */
  context?: string;
  /** Build the delegation from a template id. */
  templateId?: string;
  /** Complexity hint for the cost estimate. */
  complexity?: TaskComplexity;
}

export class DelegationManager {
  private readonly engine: OrchestrationEngine;

  constructor(engine: OrchestrationEngine) {
    this.engine = engine;
  }

  /** Smart suggestions for a free-form task. */
  suggest(task: string, max = 3): SpecialistSuggestion[] {
    return suggestSpecialists(task, { max });
  }

  listTemplates(): DelegationTemplate[] {
    return [...DELEGATION_TEMPLATES];
  }

  /** Resolve which role a delegation would use, without creating anything. */
  resolveRole(task: string, opts: Pick<DelegateOptions, 'role' | 'templateId'> = {}): string {
    if (opts.role) {
      if (!getSpecialist(opts.role)) throw new Error(`unknown specialist role: ${opts.role}`);
      return opts.role;
    }
    if (opts.templateId) {
      const template = getDelegationTemplate(opts.templateId);
      if (!template) throw new Error(`unknown delegation template: ${opts.templateId}`);
      return template.role;
    }
    const [top] = this.suggest(task, 1);
    return top?.role ?? 'implement';
  }

  /**
   * Build the full delegation preview — resolved role, templated task and
   * context, cost estimate, and alternative specialists — so the TUI can
   * show exactly what one click will do before it does it.
   */
  preview(task: string, opts: DelegateOptions = {}): DelegationPreview {
    const template = opts.templateId ? getDelegationTemplate(opts.templateId) : null;
    if (opts.templateId && !template) {
      throw new Error(`unknown delegation template: ${opts.templateId}`);
    }
    const role = this.resolveRole(task, opts);
    const specialist = getSpecialist(role)!;
    const finalTask = template ? template.taskTemplate.replaceAll('{task}', task) : task;
    const contextParts: string[] = [];
    if (template?.contextTemplate) {
      contextParts.push(template.contextTemplate.replaceAll('{task}', task));
    }
    if (opts.context) contextParts.push(opts.context);
    const estimate = estimateDelegationCost(role, { complexity: opts.complexity });
    if (!estimate) throw new Error(`cannot estimate cost for role: ${role}`);
    return {
      role,
      name: specialist.name,
      icon: specialist.icon,
      model: specialist.model,
      task: finalTask,
      context: contextParts.join('\n'),
      estimate,
      alternatives: this.suggest(task).filter((s) => s.role !== role),
      templateId: template?.id ?? null,
    };
  }

  /**
   * One-click delegation: resolve role, assemble context, queue on the
   * engine. Returns the created delegation (status `queued` or `running`).
   */
  delegate(task: string, opts: DelegateOptions = {}): Delegation {
    const plan = this.preview(task, opts);
    return this.engine.delegate({
      role: plan.role,
      task: plan.task,
      context: plan.context || undefined,
    });
  }

  /** One-click delegation from a template. */
  applyTemplate(templateId: string, task: string, opts: DelegateOptions = {}): Delegation {
    return this.delegate(task, { ...opts, templateId });
  }

  /** Estimate cost for a role without previewing a whole delegation. */
  estimateCost(role: string, complexity?: TaskComplexity): DelegationCostEstimate | null {
    return estimateDelegationCost(role, { complexity });
  }
}

// ── Renderer (pure) ──────────────────────────────────────────────────────────

function usd(amountMinor: string): string {
  return formatMoney({ amountMinor, currency: 'USD', scale: 2 });
}

/**
 * Confirmation text for a delegation preview, e.g. the body of the TUI's
 * "delegate?" dialog:
 *
 * ```
 * ⚡ Implement Agent (capix/auto-best)
 *   task: Implement the following, matching existing code style: add auth middleware
 *   est. cost: USD 2.50 (ceiling USD 5.00)
 *   alternatives: 👀 Code Review Agent (50%), 🧪 Test Agent (50%)
 * ```
 */
export function renderDelegationPreview(preview: DelegationPreview): string {
  const lines = [`${preview.icon} ${preview.name} (${preview.model})`, `  task: ${preview.task}`];
  if (preview.context) {
    lines.push(`  context: ${preview.context.replace(/\n/g, ' · ')}`);
  }
  lines.push(
    `  est. cost: ${usd(preview.estimate.estimatedMinor)} (ceiling ${usd(preview.estimate.ceilingMinor)})`
  );
  if (preview.alternatives.length > 0) {
    const alts = preview.alternatives
      .map((a) => `${a.icon} ${a.name} (${Math.round(a.score * 100)}%)`)
      .join(', ');
    lines.push(`  alternatives: ${alts}`);
  }
  return lines.join('\n');
}
