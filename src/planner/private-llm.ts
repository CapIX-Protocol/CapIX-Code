/**
 * Private LLM — deploys an owner-only model instance and fine-tunes it.
 *
 * Backs the CLI verbs:
 * - `capix-code model deploy --private --base <model>` — route, provision,
 *   and register a private model deployment;
 * - `capix-code model train --dataset <path> --specialize "<prompt>"` —
 *   fine-tune the private (or any catalog) model (delegates to `Trainer`);
 * - `capix-code --model private/<id>` — resolve a private catalog entry for
 *   inference (owner-only: the catalog only ever returns the caller's own
 *   private models).
 *
 * Refs:
 * - protocol/packages/contracts/openapi.yaml (/route/quote, /route/commit,
 *   /deployments/{id}, /models, /models/train)
 * - routing-client (private_model WorkloadSpec, ManagedModel visibility)
 * - planner/train (fine-tuning flow, reused unchanged)
 *
 * Deploy flow:
 * 1. resolve the base model against the managed catalog — a private
 *    deployment always derives from a catalog model, and a miss fails before
 *    any network spend;
 * 2. covenant gate — `models:deploy` must not be `deny` (fail-closed on
 *    fetch error, matching the trainer and deployer gates);
 * 3. fresh route quote for a `private_model` workload, commit the
 *    top-scored candidate, poll the deployment to `running`;
 * 4. poll the catalog until the model appears with `visibility: 'private'`
 *    bound to this deployment — that entry is the `private/<id>` handle used
 *    for training and inference;
 * 5. record a work receipt + hook events (best-effort, never blocks).
 *
 * What this deliberately does NOT do:
 * - expose provider or node identity (the contract never returns any);
 * - use floating-point money. All amounts are string-encoded integer minor
 *   units.
 */

import * as intelligence from '../intelligence-client.js';
import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type {
  Deployment,
  DeploymentState,
  ManagedModel,
  Region,
  TrustTier,
} from '../routing-client.js';
import { Trainer } from './train.js';
import type { TrainOptions, TrainResult } from './train.js';

// ── Model references ─────────────────────────────────────────────────────────

/** A private model reference has the form `private/<id>`. */
export function isPrivateModelRef(modelId: string): boolean {
  return /^private\/[A-Za-z0-9_-]+$/.test(modelId);
}

// ── Progress events ──────────────────────────────────────────────────────────

export type PrivateLlmEvent =
  | { type: 'resolving'; baseModel: string }
  | { type: 'quoting'; modelRef: string }
  | { type: 'quoted'; modelRef: string; routeQuoteId: string; expiresAt: string }
  | { type: 'committing'; modelRef: string }
  | { type: 'committed'; modelRef: string; deploymentId: string }
  | { type: 'state'; deploymentId: string; state: DeploymentState; summary?: string }
  | { type: 'catalog-check'; deploymentId: string }
  | { type: 'registered'; modelId: string; deploymentId: string }
  | { type: 'failed'; message: string; deploymentId?: string }
  | { type: 'done'; modelId?: string };

export interface PrivateDeployResult {
  status: 'deployed' | 'failed';
  modelId?: string;
  deploymentId?: string;
  error?: string;
  /** String-encoded integer minor units of spend to date, when reported. */
  costMinor?: string;
  asset?: string;
  scale?: number;
}

export interface PrivateDeployOptions {
  baseModel: string;
  /** Human-readable deployment name (default derived from the base model). */
  name?: string;
  region?: Region;
  trustTier?: TrustTier;
  /** Minimum accelerator memory for the private instance (default 24 GiB). */
  minGpuMemoryGiB?: number;
  maxConcurrentRequests?: number;
  projectId?: string;
  signal?: AbortSignal;
  /** Called synchronously as each progress event occurs. */
  onEvent?: (event: PrivateLlmEvent) => void;
  /** Poll interval for deployment state (default 3000ms). */
  pollIntervalMs?: number;
  /** Overall provisioning timeout (default 15 minutes). */
  timeoutMs?: number;
  /** How long to wait for the private catalog entry (default 60s). */
  catalogTimeoutMs?: number;
}

const TERMINAL_STATES: ReadonlySet<DeploymentState> = new Set(['running', 'failed', 'destroyed']);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('deploy aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('deploy aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class PrivateModelManager {
  private readonly trainer = new Trainer();

  /**
   * Deploy a private, owner-only instance of a catalog base model. Expected
   * failures (unknown base model, covenant denial, quote/commit/health
   * failure, missing catalog entry) resolve to a `PrivateDeployResult` —
   * they never throw.
   */
  async deploy(opts: PrivateDeployOptions): Promise<PrivateDeployResult> {
    const emit = (event: PrivateLlmEvent) => {
      try {
        opts.onEvent?.(event);
      } catch {
        // A broken consumer must never interrupt the deploy loop.
      }
    };
    const fail = (message: string, deploymentId?: string): PrivateDeployResult => {
      emit({ type: 'failed', message, ...(deploymentId ? { deploymentId } : {}) });
      emit({ type: 'done' });
      return { status: 'failed', error: message, ...(deploymentId ? { deploymentId } : {}) };
    };

    // 1. Resolve the base model against the managed catalog (no spend yet).
    emit({ type: 'resolving', baseModel: opts.baseModel });
    try {
      const catalog = await routing.listManagedModels({
        projectId: opts.projectId,
        signal: opts.signal,
      });
      if (!catalog.some((m) => m.modelId === opts.baseModel || m.name === opts.baseModel)) {
        return fail(`model deploy: "${opts.baseModel}" is not in the model catalog`);
      }
    } catch (err) {
      return fail((err as Error)?.message ?? 'model deploy: catalog lookup failed');
    }

    // 2. Covenant gate — fail-closed, before any spend.
    const allowed = await this.checkCovenant(opts.projectId);
    if (!allowed) {
      return fail('model deploy: models:deploy denied by Project Covenant');
    }

    // 3. Quote + commit a private_model workload.
    const modelRef = opts.baseModel;
    const spec = {
      kind: 'private_model' as const,
      name: opts.name ?? `private-${modelRef.replace(/[^A-Za-z0-9-]+/g, '-')}`,
      region: opts.region ?? 'us-east',
      trustTier: opts.trustTier ?? ('verified' as TrustTier),
      modelRef,
      minGpuMemoryGiB: opts.minGpuMemoryGiB ?? 24,
      ...(opts.maxConcurrentRequests !== undefined
        ? { maxConcurrentRequests: opts.maxConcurrentRequests }
        : {}),
    };

    emit({ type: 'quoting', modelRef });
    let quote;
    try {
      quote = await routing.createRouteQuote(spec, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
    } catch (err) {
      return fail((err as Error)?.message ?? 'quote failed');
    }
    emit({
      type: 'quoted',
      modelRef,
      routeQuoteId: quote.routeQuoteId,
      expiresAt: quote.expiresAt,
    });
    this.recordHookEvent('deploy.quote', {
      modelRef,
      routeQuoteId: quote.routeQuoteId,
      expiresAt: quote.expiresAt,
      candidates: quote.candidates.length,
    });

    const candidate = routing.bestCandidate(quote);
    if (!candidate) {
      return fail('smart router returned no placement candidates');
    }

    emit({ type: 'committing', modelRef });
    let deploymentId: string;
    try {
      const receipt = await routing.commitRoute(quote.quoteToken, candidate.candidateId, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
      deploymentId = receipt.deploymentId;
    } catch (err) {
      return fail((err as Error)?.message ?? 'commit failed');
    }
    emit({ type: 'committed', modelRef, deploymentId });
    this.recordHookEvent('deploy.provision', { modelRef, deploymentId });

    // 4. Monitor health until a terminal state or timeout.
    let final: Deployment;
    try {
      final = await this.monitor(deploymentId, emit, opts);
    } catch (err) {
      return fail((err as Error)?.message ?? 'health monitoring failed', deploymentId);
    }
    if (final.state !== 'running') {
      const message =
        final.state === 'destroyed'
          ? 'deployment was destroyed during provisioning'
          : `deployment entered state "${final.state}"`;
      return fail(message, deploymentId);
    }

    // 5. The model must appear in the catalog as a private entry bound to
    //    this deployment — that entry is the `private/<id>` handle.
    emit({ type: 'catalog-check', deploymentId });
    let model: ManagedModel | null;
    try {
      model = await this.awaitCatalogEntry(deploymentId, opts);
    } catch (err) {
      return fail((err as Error)?.message ?? 'catalog registration failed', deploymentId);
    }
    if (!model) {
      return fail('model did not appear in the private catalog', deploymentId);
    }

    emit({ type: 'registered', modelId: model.modelId, deploymentId });
    emit({ type: 'done', modelId: model.modelId });
    this.recordReceipt(modelRef, deploymentId, final);
    return {
      status: 'deployed',
      modelId: model.modelId,
      deploymentId,
      costMinor: final.customerView.spendToDate.amountMinor,
      asset: final.customerView.spendToDate.currency,
      scale: final.customerView.spendToDate.scale,
    };
  }

  /**
   * Fine-tune a model (`capix-code model train`). When `baseModel` is a
   * private reference it is resolved owner-only first — training against
   * someone else's private model is impossible by construction (the catalog
   * only returns the caller's own private entries). Everything else is the
   * shared `Trainer` flow, unchanged.
   */
  async fineTune(opts: TrainOptions): Promise<TrainResult> {
    if (isPrivateModelRef(opts.baseModel)) {
      try {
        await this.resolveForInference(opts.baseModel, {
          projectId: opts.projectId,
          signal: opts.signal,
        });
      } catch (err) {
        return { status: 'failed', error: (err as Error)?.message ?? 'private model unavailable' };
      }
    }
    return this.trainer.train(opts);
  }

  /** The managed catalog: public models plus the caller's own private entries. */
  async listCatalog(
    opts: { projectId?: string; signal?: AbortSignal } = {}
  ): Promise<ManagedModel[]> {
    return routing.listManagedModels(opts);
  }

  /**
   * Resolve a `private/<id>` reference to its catalog entry for inference
   * (`capix-code --model private/<id>`). Throws unless the entry exists with
   * `visibility: 'private'`. Access is owner-only: the control plane only
   * returns the caller's own private models, so a hit is proof of ownership.
   */
  async resolveForInference(
    modelId: string,
    opts: { projectId?: string; signal?: AbortSignal } = {}
  ): Promise<ManagedModel> {
    if (!isPrivateModelRef(modelId)) {
      throw new Error(`model: "${modelId}" is not a private model reference (private/<id>)`);
    }
    const catalog = await routing.listManagedModels({
      projectId: opts.projectId,
      signal: opts.signal,
    });
    const model = catalog.find((m) => m.modelId === modelId && m.visibility === 'private');
    if (!model) {
      throw new Error(`model: "${modelId}" was not found in your private model catalog`);
    }
    return model;
  }

  /** Fail-closed covenant gate for `models:deploy`. */
  private async checkCovenant(projectId?: string): Promise<boolean> {
    try {
      const perm = await intelligence.checkPermission(
        { action: 'models:deploy', environment: 'dev' },
        { projectId }
      );
      return perm.decision !== 'deny';
    } catch (err) {
      logger.warn('private-llm: covenant check failed — fail-closed', {
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  /** Poll deployment state, emitting an event on every transition. */
  private async monitor(
    deploymentId: string,
    emit: (e: PrivateLlmEvent) => void,
    opts: PrivateDeployOptions
  ): Promise<Deployment> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastState: DeploymentState | null = null;

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('deploy aborted');
      let deployment: Deployment;
      try {
        deployment = await routing.getDeployment(deploymentId, {
          projectId: opts.projectId,
          signal: opts.signal,
        });
      } catch (err) {
        logger.warn('private-llm: state poll failed', {
          deploymentId,
          error: (err as Error)?.message,
        });
        await sleep(pollIntervalMs, opts.signal);
        continue;
      }

      if (deployment.state !== lastState) {
        lastState = deployment.state;
        emit({
          type: 'state',
          deploymentId,
          state: deployment.state,
          summary: deployment.customerView.summary,
        });
      }
      if (TERMINAL_STATES.has(deployment.state)) {
        return deployment;
      }
      await sleep(pollIntervalMs, opts.signal);
    }

    throw new Error(
      `model deploy: timed out after ${Math.round(timeoutMs / 1000)}s waiting for ` +
        `deployment ${deploymentId} to reach a healthy state`
    );
  }

  /**
   * Poll the catalog until a private entry bound to `deploymentId` appears,
   * or the catalog window expires. Returns `null` on expiry.
   */
  private async awaitCatalogEntry(
    deploymentId: string,
    opts: PrivateDeployOptions
  ): Promise<ManagedModel | null> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const deadline = Date.now() + (opts.catalogTimeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('deploy aborted');
      let catalog: ManagedModel[];
      try {
        catalog = await routing.listManagedModels({
          projectId: opts.projectId,
          signal: opts.signal,
        });
      } catch (err) {
        logger.warn('private-llm: catalog poll failed', {
          deploymentId,
          error: (err as Error)?.message,
        });
        await sleep(pollIntervalMs, opts.signal);
        continue;
      }
      const model = catalog.find(
        (m) => m.visibility === 'private' && m.deploymentId === deploymentId
      );
      if (model) return model;
      await sleep(pollIntervalMs, opts.signal);
    }
    return null;
  }

  /** Best-effort hook event; never throws into the deploy loop. */
  private recordHookEvent(
    type: 'deploy.quote' | 'deploy.provision',
    payload: Record<string, unknown>
  ): void {
    intelligence
      .recordHookEvent({ type, payload, source: 'capix-code:private-llm' })
      .catch((err) =>
        logger.warn('private-llm: hook event recording failed', {
          type,
          error: (err as Error)?.message,
        })
      );
  }

  /** Best-effort work receipt once the deployment is healthy. */
  private recordReceipt(modelRef: string, deploymentId: string, deployment: Deployment): void {
    const spend = deployment.customerView.spendToDate;
    intelligence
      .createWorkReceipt({
        kind: 'infra-provision',
        costMinor: spend.amountMinor,
        asset: spend.currency,
        scale: spend.scale,
        summary: `deployed private model ${modelRef} (deployment ${deploymentId})`,
        outcome: 'success',
        environment: 'dev',
        resourceIds: [deploymentId],
        source: 'capix-code:private-llm',
      })
      .catch((err) =>
        logger.warn('private-llm: work receipt recording failed', {
          deploymentId,
          error: (err as Error)?.message,
        })
      );
  }
}
