/**
 * Deploy — converts an approved `ArchitecturePlan` into live deployments.
 *
 * Refs:
 * - protocol/packages/contracts/openapi.yaml (/route/quote, /route/commit,
 *   /deployments/{id}, DeploymentState machine)
 * - intelligence-client (covenant gate, work receipts, hook events)
 *
 * Flow per workload:
 * 1. covenant gate — `infra:deploy` must not be `deny` (fail-closed on fetch
 *    error, matching the plugin's infra command gate);
 * 2. fresh route quote from the smart router (architect quotes may have
 *    expired — the token is only price-locked until `expiresAt`);
 * 3. commit the top-scored candidate via `/route/commit`;
 * 4. poll `GET /deployments/{id}` until `running` (healthy), `failed`, or
 *    timeout, emitting a progress event on every state transition;
 * 5. record a work receipt + hook events (best-effort, never blocks deploy).
 *
 * Progress is streamed to the caller through the `onEvent` callback as it
 * happens; the returned `DeployResult` summarizes the run.
 */

import * as intelligence from '../intelligence-client.js';
import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type {
  Deployment,
  DeploymentState,
  Money,
  RouteCandidate,
  RouteQuote,
} from '../routing-client.js';
import type { Architect, ArchitecturePlan } from './architect.js';

// ── Progress events ──────────────────────────────────────────────────────────

export type DeployProgressEvent =
  | { type: 'quoting'; workload: string }
  | {
      type: 'quoted';
      workload: string;
      routeQuoteId: string;
      expiresAt: string;
      candidate: RouteCandidate | null;
    }
  | { type: 'committing'; workload: string }
  | {
      type: 'committed';
      workload: string;
      deploymentId: string;
      routeReceiptId: string;
    }
  | {
      type: 'state';
      workload: string;
      deploymentId: string;
      state: DeploymentState;
      summary?: string;
    }
  | {
      type: 'healthy';
      workload: string;
      deploymentId: string;
      endpoints: Array<{ url: string; protocol: string }>;
      spendToDate: Money;
    }
  | { type: 'failed'; workload: string; error: string; deploymentId?: string }
  | { type: 'done'; succeeded: number; failed: number };

export interface DeployedWorkload {
  name: string;
  deploymentId?: string;
  state: 'running' | 'failed';
  error?: string;
  spendToDate?: Money;
}

export interface DeployResult {
  planId: string;
  status: 'deployed' | 'partial' | 'failed';
  workloads: DeployedWorkload[];
  startedAt: string;
  finishedAt: string;
}

export interface DeployOptions {
  projectId?: string;
  signal?: AbortSignal;
  /** Called synchronously as each progress event occurs. */
  onEvent?: (event: DeployProgressEvent) => void;
  /** Poll interval for deployment state (default 3000ms). */
  pollIntervalMs?: number;
  /** Per-workload health timeout (default 10 minutes). */
  timeoutMs?: number;
  /** Skip the covenant gate (tests only — production deploys always check). */
  skipCovenantCheck?: boolean;
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

export class Deployer {
  constructor(private readonly architect?: Architect) {}

  /**
   * Deploy an approved architecture plan. Throws if the plan is not approved
   * — spend always requires an explicit approval step first.
   */
  async deploy(plan: ArchitecturePlan, opts: DeployOptions = {}): Promise<DeployResult> {
    if (plan.status !== 'approved') {
      throw new Error(
        `deploy: plan ${plan.id} is "${plan.status}" — approve the architecture before deploying`
      );
    }

    const emit = (event: DeployProgressEvent) => {
      try {
        opts.onEvent?.(event);
      } catch {
        // A broken consumer must never interrupt the deploy loop.
      }
    };

    const allowed = opts.skipCovenantCheck ? true : await this.checkCovenant(opts.projectId);
    if (!allowed) {
      throw new Error('deploy: infra:deploy denied by Project Covenant');
    }

    const startedAt = new Date().toISOString();
    const results: DeployedWorkload[] = [];

    for (const workload of plan.workloads) {
      const deployed = await this.deployWorkload(plan, workload.name, emit, opts);
      results.push(deployed);
    }

    const succeeded = results.filter((r) => r.state === 'running').length;
    const failed = results.length - succeeded;
    emit({ type: 'done', succeeded, failed });

    const status = failed === 0 ? 'deployed' : succeeded > 0 ? 'partial' : 'failed';
    this.architect?.setStatus(plan.id, status === 'failed' ? 'failed' : 'deployed');

    return {
      planId: plan.id,
      status,
      workloads: results,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /** Fail-closed covenant gate for `infra:deploy`. */
  private async checkCovenant(projectId?: string): Promise<boolean> {
    try {
      const perm = await intelligence.checkPermission(
        { action: 'infra:deploy', environment: 'dev' },
        { projectId }
      );
      // `ask` is treated as allowed here: the human approval already happened
      // when the operator approved the architecture plan.
      return perm.decision !== 'deny';
    } catch (err) {
      logger.warn('deploy: covenant check failed — fail-closed', {
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  private async deployWorkload(
    plan: ArchitecturePlan,
    workloadName: string,
    emit: (e: DeployProgressEvent) => void,
    opts: DeployOptions
  ): Promise<DeployedWorkload> {
    const workload = plan.workloads.find((w) => w.name === workloadName)!;

    // 1. Fresh quote — architect quotes are price-locked only until expiry.
    emit({ type: 'quoting', workload: workloadName });
    let quote: RouteQuote;
    try {
      quote = await routing.createRouteQuote(workload.spec, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
    } catch (err) {
      const error = (err as Error)?.message ?? 'quote failed';
      emit({ type: 'failed', workload: workloadName, error });
      return { name: workloadName, state: 'failed', error };
    }

    const candidate = routing.bestCandidate(quote);
    emit({
      type: 'quoted',
      workload: workloadName,
      routeQuoteId: quote.routeQuoteId,
      expiresAt: quote.expiresAt,
      candidate,
    });
    this.recordHookEvent('deploy.quote', plan, workloadName, {
      routeQuoteId: quote.routeQuoteId,
      expiresAt: quote.expiresAt,
      candidates: quote.candidates.length,
    });

    if (!candidate) {
      const error = 'smart router returned no placement candidates';
      emit({ type: 'failed', workload: workloadName, error });
      return { name: workloadName, state: 'failed', error };
    }

    // 2. Commit the placement.
    emit({ type: 'committing', workload: workloadName });
    let deploymentId: string;
    try {
      const receipt = await routing.commitRoute(quote.quoteToken, candidate.candidateId, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
      deploymentId = receipt.deploymentId;
      emit({
        type: 'committed',
        workload: workloadName,
        deploymentId,
        routeReceiptId: receipt.routeReceiptId,
      });
      this.recordHookEvent('deploy.provision', plan, workloadName, {
        deploymentId,
        routeReceiptId: receipt.routeReceiptId,
      });
    } catch (err) {
      const error = (err as Error)?.message ?? 'commit failed';
      emit({ type: 'failed', workload: workloadName, error });
      return { name: workloadName, state: 'failed', error };
    }

    // 3. Monitor health until a terminal state or timeout.
    let final: Deployment;
    try {
      final = await this.monitor(workloadName, deploymentId, emit, opts);
    } catch (err) {
      const error = (err as Error)?.message ?? 'health monitoring failed';
      emit({ type: 'failed', workload: workloadName, deploymentId, error });
      return { name: workloadName, deploymentId, state: 'failed', error };
    }
    if (final.state === 'running') {
      const endpoints = final.customerView.endpoints ?? [];
      emit({
        type: 'healthy',
        workload: workloadName,
        deploymentId,
        endpoints,
        spendToDate: final.customerView.spendToDate,
      });
      this.recordReceipt(plan, workloadName, final);
      return {
        name: workloadName,
        deploymentId,
        state: 'running',
        spendToDate: final.customerView.spendToDate,
      };
    }

    const error =
      final.state === 'destroyed'
        ? 'deployment was destroyed during provisioning'
        : `deployment entered state "${final.state}"`;
    emit({ type: 'failed', workload: workloadName, deploymentId, error });
    return { name: workloadName, deploymentId, state: 'failed', error };
  }

  /** Poll deployment state, emitting an event on every transition. */
  private async monitor(
    workloadName: string,
    deploymentId: string,
    emit: (e: DeployProgressEvent) => void,
    opts: DeployOptions
  ): Promise<Deployment> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
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
        logger.warn('deploy: state poll failed', {
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
          workload: workloadName,
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
      `deploy: timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${workloadName} ` +
        `(${deploymentId}) to reach a healthy state`
    );
  }

  /** Best-effort hook event; never throws into the deploy loop. */
  private recordHookEvent(
    type: 'deploy.quote' | 'deploy.provision',
    plan: ArchitecturePlan,
    workload: string,
    payload: Record<string, unknown>
  ): void {
    intelligence
      .recordHookEvent({
        type,
        payload: { planId: plan.id, workload, ...payload },
        source: 'capix-code:deploy',
      })
      .catch((err) =>
        logger.warn('deploy: hook event recording failed', {
          type,
          error: (err as Error)?.message,
        })
      );
  }

  /** Best-effort work receipt once a workload is healthy. */
  private recordReceipt(plan: ArchitecturePlan, workload: string, deployment: Deployment): void {
    const spend = deployment.customerView.spendToDate;
    intelligence
      .createWorkReceipt({
        kind: 'infra-provision',
        costMinor: spend.amountMinor,
        asset: spend.currency,
        scale: spend.scale,
        summary: `deployed ${workload} (plan ${plan.id}, deployment ${deployment.deploymentId})`,
        outcome: 'success',
        environment: 'dev',
        resourceIds: [deployment.deploymentId],
        source: 'capix-code:deploy',
      })
      .catch((err) =>
        logger.warn('deploy: work receipt recording failed', {
          workload,
          error: (err as Error)?.message,
        })
      );
  }
}
