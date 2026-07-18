/**
 * Model tools — agent-runtime tool definitions for private model operations.
 *
 * These back the `capix-code model` verbs when driven by an agent turn:
 * - `model_deploy` — deploy an owner-only private instance of a catalog base
 *   model (`capix-code model deploy --private --base <model>`);
 * - `model_train` — fine-tune a model on a local dataset
 *   (`capix-code model train --dataset <path> --specialize "<prompt>"`);
 * - `model_list` — list the managed catalog (public models plus the owner's
 *   private entries).
 *
 * Deploy and train spend money, so both are `billing` risk class and always
 * require approval regardless of mode. All output is customer-facing: model
 * IDs, states, and costs only — never provider or node identity. Money is
 * rendered from string-encoded integer minor units via `formatMoney`.
 */

import type { ToolDefinition, ToolResult } from '@capix/agent-runtime';

import { PrivateModelManager, isPrivateModelRef } from '../planner/private-llm.js';
import type { TrainingHyperparameters } from '../routing-client.js';
import { formatMoney, zeroMoney } from '../routing-client.js';

function text(result: ToolResult): ToolResult {
  return result;
}

/** The model tool set. One manager instance is shared across all tools. */
export function createModelTools(manager = new PrivateModelManager()): ToolDefinition[] {
  return [
    {
      name: 'model_deploy',
      description:
        'Deploy a private, owner-only instance of a base model from the managed catalog. ' +
        'Returns the private model ID (private/<id>) once it is registered.',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args) {
        const baseModel = String(args.base_model ?? '').trim();
        if (!baseModel) return text({ output: 'base_model is required', isError: true });
        const lines: string[] = [];
        const result = await manager.deploy({
          baseModel,
          ...(args.name !== undefined ? { name: String(args.name) } : {}),
          ...(args.region !== undefined
            ? { region: String(args.region) as Parameters<typeof manager.deploy>[0]['region'] }
            : {}),
          ...(args.min_gpu_memory_gib !== undefined
            ? { minGpuMemoryGiB: Number(args.min_gpu_memory_gib) }
            : {}),
          ...(args.max_concurrent_requests !== undefined
            ? { maxConcurrentRequests: Number(args.max_concurrent_requests) }
            : {}),
          ...(args.timeout_ms !== undefined ? { timeoutMs: Number(args.timeout_ms) } : {}),
          ...(args.poll_interval_ms !== undefined
            ? { pollIntervalMs: Number(args.poll_interval_ms) }
            : {}),
          onEvent: (e) => {
            if (e.type === 'state') lines.push(`state: ${e.state}`);
          },
        });
        if (result.status !== 'deployed') {
          return text({ output: `deploy failed: ${result.error ?? 'unknown error'}`, isError: true });
        }
        const spend =
          result.costMinor !== undefined && result.asset !== undefined && result.scale !== undefined
            ? formatMoney({ amountMinor: result.costMinor, currency: result.asset, scale: result.scale })
            : formatMoney(zeroMoney());
        return text({
          output:
            [`deployed private model ${result.modelId} (deployment ${result.deploymentId})`]
              .concat(lines)
              .join('\n') + `\nspend to date: ${spend}`,
          metadata: {
            modelId: result.modelId,
            deploymentId: result.deploymentId,
            costMinor: result.costMinor,
            asset: result.asset,
            scale: result.scale,
          },
        });
      },
    },
    {
      name: 'model_train',
      description:
        'Fine-tune a model on a local dataset and register the result in the private catalog. ' +
        'The base may be a catalog model or a private model ID (private/<id>).',
      riskClass: 'billing',
      alwaysRequiresApproval: true,
      async execute(args, ctx) {
        const baseModel = String(args.base_model ?? '').trim();
        if (!baseModel) return text({ output: 'base_model is required', isError: true });
        const dataset = String(args.dataset ?? '').trim();
        if (!dataset) return text({ output: 'dataset is required', isError: true });
        const specialize = String(args.specialize ?? '').trim();
        if (!specialize) return text({ output: 'specialize is required', isError: true });

        const hyperparameters: TrainingHyperparameters = {};
        if (args.epochs !== undefined) hyperparameters.epochs = Number(args.epochs);
        if (args.learning_rate !== undefined) hyperparameters.learningRate = Number(args.learning_rate);
        if (args.lora_rank !== undefined) hyperparameters.loraRank = Number(args.lora_rank);

        const result = await manager.fineTune({
          baseModel,
          datasetPath: dataset,
          specialize,
          ...(Object.keys(hyperparameters).length > 0 ? { hyperparameters } : {}),
          ...(args.timeout_ms !== undefined ? { timeoutMs: Number(args.timeout_ms) } : {}),
          ...(args.poll_interval_ms !== undefined
            ? { pollIntervalMs: Number(args.poll_interval_ms) }
            : {}),
          signal: ctx.signal,
        });
        if (result.status !== 'ready') {
          return text({ output: `train failed: ${result.error ?? 'unknown error'}`, isError: true });
        }
        const spend =
          result.costMinor !== undefined && result.asset !== undefined && result.scale !== undefined
            ? formatMoney({ amountMinor: result.costMinor, currency: result.asset, scale: result.scale })
            : formatMoney(zeroMoney());
        return text({
          output: `trained ${result.modelId} from ${baseModel} (job ${result.jobId})\ncost: ${spend}`,
          metadata: {
            modelId: result.modelId,
            jobId: result.jobId,
            costMinor: result.costMinor,
            asset: result.asset,
            scale: result.scale,
          },
        });
      },
    },
    {
      name: 'model_list',
      description:
        'List the managed model catalog: public models plus your own private entries ' +
        '(private/<id>). Use a private model ID with --model for inference.',
      riskClass: 'read',
      async execute(args, ctx) {
        const visibility = args.visibility !== undefined ? String(args.visibility) : undefined;
        if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
          return text({ output: 'visibility must be "public" or "private"', isError: true });
        }
        const catalog = await manager.listCatalog({ signal: ctx.signal });
        const models = visibility ? catalog.filter((m) => m.visibility === visibility) : catalog;
        if (models.length === 0) {
          return text({ output: 'no models found in the catalog' });
        }
        const lines = models.map((m) => {
          const price = `${formatMoney(m.pricePerInputToken)}/1M input`;
          return `${m.modelId} [${m.visibility}] ${m.capabilities.join(', ')} — ${price}`;
        });
        const privateIds = models
          .filter((m) => m.visibility === 'private' && isPrivateModelRef(m.modelId))
          .map((m) => m.modelId);
        return text({
          output: lines.join('\n'),
          metadata: { count: models.length, privateModelIds: privateIds },
        });
      },
    },
  ];
}
