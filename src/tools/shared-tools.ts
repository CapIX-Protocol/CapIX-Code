/**
 * Shared tool factory — creates the full Capix tool set for both CLI and IDE.
 *
 * The CLI registers these in `src/plugin.ts`; the IDE registers them through
 * `agentRuntimeEngine.ts` `extraTools`. One factory, one behavior, one permission
 * model. The IDE passes its own model invoker and routing client; the CLI passes
 * its own. Everything else is identical.
 */

import type { ToolDefinition } from '@capix/agent-runtime';
import { Architect } from '../planner/architect.js';
import { Deployer } from '../planner/deploy.js';
import { Trainer } from '../planner/train.js';
import { Sandpit } from '../planner/sandpit.js';
import { PrivateModelManager } from '../planner/private-llm.js';
import { MvpPlanner, MvpDeployer } from '../planner/mvp.js';
import { FullSolutionPlanner } from '../planner/full-solution.js';
import { createSandpitTools } from './sandpit-tools.js';
import { createModelTools } from './model-tools.js';
import type { ModelInvoker } from '../planner/index.js';

export interface SharedToolContext {
  modelInvoker: ModelInvoker;
  formatMoney: (money: { amountMinor: string; currency: string; scale: number }) => string;
}

/**
 * Create the full Capix tool set. Both CLI and IDE call this with their own
 * context (model invoker, money formatter) and receive the same tools.
 */
export function createSharedTools(ctx: SharedToolContext): ToolDefinition[] {
  const architect = new Architect(ctx.modelInvoker);
  const deployer = new Deployer(architect);
  const trainer = new Trainer();
  const sandpit = new Sandpit();
  const privateModelManager = new PrivateModelManager();
  const mvpPlanner = new MvpPlanner(ctx.modelInvoker);
  const mvpDeployer = new MvpDeployer(mvpPlanner);
  const fullSolutionPlanner = new FullSolutionPlanner(ctx.modelInvoker);

  return [
    // Architect mode
    {
      name: 'capix_architect',
      description:
        'Architect mode: turn a natural-language intent into a deployable system architecture with live cost quotes from the smart router.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args) {
        const intent = String(args.intent ?? '');
        const plan = await architect.design(intent);
        if (args.approve) architect.approve(plan.id);
        return {
          output: `Architecture plan: ${plan.summary}\nWorkloads: ${plan.workloads.length}\nCost estimate: ${plan.costEstimate?.total ?? 'N/A'}`,
          metadata: { planId: plan.id, status: plan.status },
        };
      },
    },
    // Deploy mode
    {
      name: 'capix_deploy',
      description:
        'Deploy mode: convert an approved architecture plan into workloads and dispatch them through the smart router.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(_args) {
        const plan = architect.getCurrentPlan();
        if (!plan) return { output: 'No approved plan. Run capix_architect first.', isError: true };
        const result = await deployer.deploy(plan, {
          onEvent: () => undefined,
        });
        return {
          output: `Deploy ${result.status}: ${result.workloads.map((w) => `${w.name}=${w.state}`).join(', ')}`,
          metadata: { planId: result.planId, status: result.status },
        };
      },
    },
    // Train mode
    {
      name: 'capix_train',
      description: 'Train mode: fine-tune a base model on a dataset via Capix.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await trainer.train({
          baseModel: String(args.model ?? ''),
          datasetPath: String(args.dataset ?? ''),
          specialize: String(args.specialize ?? ''),
          onEvent: () => undefined,
        });
        return {
          output: `Train ${result.status}${result.modelId ? `: ${result.modelId}` : ''}${result.error ? ` — ${result.error}` : ''}`,
          metadata: { jobId: result.jobId ?? null, status: result.status },
        };
      },
    },
    // MVP architect
    {
      name: 'capix_mvp_architect',
      description: 'MVP architect: turn a product idea into a deployable MVP plan.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args) {
        const mvp = await mvpPlanner.design(String(args.intent ?? ''));
        if (args.approve) mvpPlanner.approve(mvp.architecture.id);
        return {
          output: `MVP plan: ${mvp.architecture.summary}\nWorkloads: ${mvp.architecture.workloads.length}`,
          metadata: { planId: mvp.architecture.id, status: mvp.architecture.status },
        };
      },
    },
    // MVP deploy
    {
      name: 'capix_mvp_deploy',
      description: 'MVP deploy: deploy an approved MVP plan.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(_args) {
        const plan = mvpPlanner.getCurrentPlan();
        if (!plan) return { output: 'No approved MVP plan. Run capix_mvp_architect first.', isError: true };
        const result = await mvpDeployer.deploy(plan, { onEvent: () => undefined });
        return {
          output: `MVP deploy ${result.status}${result.url ? `: ${result.url}` : ''}`,
          metadata: { planId: result.planId, status: result.status, url: result.url ?? null },
        };
      },
    },
    // Full solution architect
    {
      name: 'capix_full_solution',
      description: 'Full solution architect: analyze an MVP directory and produce a production architecture.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await fullSolutionPlanner.design(String(args.scaleIntent ?? ''), {
          fromMvp: String(args.mvpPath ?? ''),
        });
        if (args.approve) fullSolutionPlanner.approve(result.architecture.id);
        return {
          output: `Full solution: ${result.architecture.summary}\nWorkloads: ${result.architecture.workloads.length}`,
          metadata: { planId: result.architecture.id, status: result.architecture.status },
        };
      },
    },
    // Sandpit tools
    ...createSandpitTools(sandpit),
    // Model tools
    ...createModelTools(privateModelManager),
  ];
}
