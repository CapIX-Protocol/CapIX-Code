/**
 * Sandpit — an isolated container environment where code is refactored,
 * reviewed, and tested without touching the user's local environment.
 *
 * Refs:
 * - protocol/docs/user-stories-and-competitive-analysis.md (Story 1:
 *   refactor, review, test in a sandpit — serverless job runtime with the
 *   user's code mounted, results streamed back to the CLI/IDE)
 * - protocol/packages/contracts/openapi.yaml (/route/quote, /route/commit,
 *   /deployments/{id}, DeploymentState machine)
 * - intelligence-client (covenant gate, work receipts, hook events)
 *
 * CLI surface (wired by the plugin):
 * - `capix-code sandpit create` — quote + commit an isolated container with
 *   the user's source mounted, and wait until it is running;
 * - `capix-code sandpit refactor --instruction "..."` — run the refactor as a
 *   serverless job inside the sandpit;
 * - `capix-code sandpit review` — run the security + quality review job;
 * - `capix-code sandpit test` — run the full test-suite job;
 * - `capix-code sandpit destroy` — tear the container down and report the
 *   total spend accumulated across the container and every job.
 *
 * Flow mirrors the deployer: covenant gate (fail-closed) → fresh route quote
 * → commit the top-scored candidate → poll the deployment until a terminal
 * state, emitting a progress event on every transition. Refactor/review/test
 * run as `serverless_job` workloads labeled with the sandpit id; a job
 * succeeds when its deployment reaches `stopped`, the container when it
 * reaches `running`.
 *
 * What this deliberately does NOT do:
 * - upload source bytes or pick hardware (server-authoritative scheduling);
 * - expose provider or node identity (the contract never returns any);
 * - use floating-point money. All amounts are string-encoded integer minor
 *   units.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import * as intelligence from '../intelligence-client.js';
import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type { Deployment, DeploymentState, Money, WorkloadSpec } from '../routing-client.js';

// ── Domain types ─────────────────────────────────────────────────────────────

export type SandpitAction = 'refactor' | 'review' | 'test';

export const SANDPIT_ACTIONS: readonly SandpitAction[] = ['refactor', 'review', 'test'];

/** Container image for the sandpit runtime (user code mounted at /workspace). */
export const SANDPIT_IMAGE = 'capix/sandpit-runtime:latest';

export interface SandpitSession {
  sandpitId: string;
  /** Deployment id of the long-running sandpit container. */
  deploymentId: string;
  sourcePath: string;
  state: DeploymentState;
  /** Accumulated spend: container plus every job, integer minor units. */
  spendToDate: Money;
  /** Deployment ids of the action jobs, in submission order. */
  jobDeploymentIds: string[];
  createdAt: string;
}

export type SandpitProgressEvent =
  | { type: 'validating'; sourcePath: string }
  | { type: 'quoting'; workload: string }
  | { type: 'quoted'; workload: string; routeQuoteId: string; expiresAt: string }
  | { type: 'committing'; workload: string }
  | { type: 'committed'; workload: string; deploymentId: string; routeReceiptId: string }
  | {
      type: 'state';
      workload: string;
      deploymentId: string;
      state: DeploymentState;
      summary?: string;
    }
  | { type: 'ready'; sandpitId: string; deploymentId: string; spendToDate: Money }
  | { type: 'job-submitted'; sandpitId: string; action: SandpitAction; deploymentId: string }
  | {
      type: 'job-finished';
      sandpitId: string;
      action: SandpitAction;
      deploymentId: string;
      status: 'succeeded' | 'failed';
      summary?: string;
    }
  | { type: 'destroying'; sandpitId: string; deploymentId: string }
  | { type: 'destroyed'; sandpitId: string; totalCost: Money }
  | { type: 'failed'; workload?: string; error: string };

export interface SandpitCreateResult {
  status: 'running' | 'failed';
  sandpitId?: string;
  deploymentId?: string;
  spendToDate?: Money;
  error?: string;
}

export interface SandpitJobResult {
  status: 'succeeded' | 'failed';
  sandpitId: string;
  action: SandpitAction;
  deploymentId?: string;
  /** Result summary streamed back from the job (review findings, test totals). */
  summary?: string;
  /** Job spend in integer minor units, when reported. */
  cost?: Money;
  error?: string;
}

export interface SandpitDestroyResult {
  status: 'destroyed' | 'failed';
  sandpitId: string;
  /** Total spend across the container and every job, integer minor units. */
  totalCost?: Money;
  error?: string;
}

interface SandpitCommonOptions {
  projectId?: string;
  signal?: AbortSignal;
  /** Called synchronously as each progress event occurs. */
  onEvent?: (event: SandpitProgressEvent) => void;
  /** Poll interval for deployment state (default 3000ms). */
  pollIntervalMs?: number;
}

export interface SandpitCreateOptions extends SandpitCommonOptions {
  /** Directory with the user's code to mount into the sandpit. */
  sourcePath: string;
  region?: routing.Region;
  /** Container start timeout (default 10 minutes). */
  timeoutMs?: number;
}

export interface SandpitJobOptions extends SandpitCommonOptions {
  sandpitId: string;
  /** Refactor instruction (required for `refactor`). */
  instruction?: string;
  /** Job timeout (default 30 minutes — full test suites run long). */
  timeoutMs?: number;
}

export interface SandpitDestroyOptions extends SandpitCommonOptions {
  sandpitId: string;
  /** Destroy timeout (default 5 minutes). */
  timeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('sandpit aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('sandpit aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function newSandpitId(): string {
  return `sp_${randomBytes(8).toString('hex')}`;
}

/** The argv the sandpit runtime executes for each action. */
export function sandpitJobCommand(action: SandpitAction, instruction?: string): string[] {
  switch (action) {
    case 'refactor':
      return ['refactor', '--instruction', instruction ?? ''];
    case 'review':
      return ['review', '--security', '--quality'];
    case 'test':
      return ['test', '--full'];
  }
}

/** Recursively list files under `dir` as POSIX-style relative paths. */
async function listFiles(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFiles(abs, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, abs));
    }
  }
}

export class Sandpit {
  private readonly sessions = new Map<string, SandpitSession>();

  /** Look up a live sandpit session. */
  get(sandpitId: string): SandpitSession | null {
    return this.sessions.get(sandpitId) ?? null;
  }

  /** All live sandpit sessions. */
  list(): SandpitSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Spin up an isolated container with the user's code mounted. Expected
   * failures (unreadable source, covenant denial, provisioning failure)
   * resolve to a `SandpitCreateResult` — they never throw.
   */
  async create(opts: SandpitCreateOptions): Promise<SandpitCreateResult> {
    const emit = this.emitter(opts);
    const workload = 'sandpit';

    // 1. Validate + fingerprint the source (local only — no network yet).
    emit({ type: 'validating', sourcePath: opts.sourcePath });
    let sourceRef: string;
    try {
      sourceRef = await this.fingerprintSource(opts.sourcePath);
    } catch (err) {
      const error = (err as Error)?.message ?? 'source path is unreadable';
      emit({ type: 'failed', workload, error });
      return { status: 'failed', error };
    }

    // 2. Covenant gate — fail-closed, before anything is provisioned.
    const allowed = await this.checkCovenant('infra:deploy', opts.projectId);
    if (!allowed) {
      const error = 'sandpit: infra:deploy denied by Project Covenant';
      emit({ type: 'failed', workload, error });
      return { status: 'failed', error };
    }

    // 3. Quote + commit the container.
    const sandpitId = newSandpitId();
    const spec: WorkloadSpec = {
      kind: 'container_service',
      name: `sandpit-${sandpitId}`,
      image: SANDPIT_IMAGE,
      port: 8080,
      region: opts.region ?? 'global',
      trustTier: 'verified',
      env: {
        CAPIX_SANDPIT_ID: sandpitId,
        CAPIX_SOURCE_REF: sourceRef,
      },
      labels: { 'capix.dev/sandpit': sandpitId },
    };
    const provisioned = await this.quoteCommitMonitor(workload, spec, 'running', emit, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    });
    if ('error' in provisioned) {
      emit({ type: 'failed', workload, error: provisioned.error });
      return { status: 'failed', deploymentId: provisioned.deploymentId, error: provisioned.error };
    }

    const session: SandpitSession = {
      sandpitId,
      deploymentId: provisioned.deployment.deploymentId,
      sourcePath: resolve(opts.sourcePath),
      state: 'running',
      spendToDate: provisioned.deployment.customerView.spendToDate,
      jobDeploymentIds: [],
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sandpitId, session);
    emit({
      type: 'ready',
      sandpitId,
      deploymentId: session.deploymentId,
      spendToDate: session.spendToDate,
    });
    this.recordHookEvent('sandpit.create', sandpitId, {
      deploymentId: session.deploymentId,
      sourcePath: session.sourcePath,
    });
    this.recordReceipt(sandpitId, provisioned.deployment, 'provisioned sandpit container');
    return {
      status: 'running',
      sandpitId,
      deploymentId: session.deploymentId,
      spendToDate: session.spendToDate,
    };
  }

  /** Run the refactor job inside the sandpit. */
  async refactor(opts: SandpitJobOptions & { instruction: string }): Promise<SandpitJobResult> {
    return this.runJob('refactor', opts);
  }

  /** Run the security + quality review job inside the sandpit. */
  async review(opts: SandpitJobOptions): Promise<SandpitJobResult> {
    return this.runJob('review', opts);
  }

  /** Run the full test-suite job inside the sandpit. */
  async test(opts: SandpitJobOptions): Promise<SandpitJobResult> {
    return this.runJob('test', opts);
  }

  /**
   * Tear the sandpit down and report total spend — container plus every job.
   * The session is forgotten once destroyed.
   */
  async destroy(opts: SandpitDestroyOptions): Promise<SandpitDestroyResult> {
    const emit = this.emitter(opts);
    const session = this.sessions.get(opts.sandpitId);
    if (!session) {
      const error = `sandpit: unknown sandpit "${opts.sandpitId}"`;
      emit({ type: 'failed', error });
      return { status: 'failed', sandpitId: opts.sandpitId, error };
    }

    const allowed = await this.checkCovenant('sandpit:run', opts.projectId);
    if (!allowed) {
      const error = 'sandpit: sandpit:run denied by Project Covenant';
      emit({ type: 'failed', error });
      return { status: 'failed', sandpitId: opts.sandpitId, error };
    }

    emit({ type: 'destroying', sandpitId: session.sandpitId, deploymentId: session.deploymentId });
    let final: Deployment;
    try {
      await routing.destroyDeployment(session.deploymentId, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
      final = await this.monitor(
        'sandpit',
        session.deploymentId,
        'destroyed',
        emit,
        { ...opts, timeoutMs: opts.timeoutMs ?? 5 * 60_000 }
      );
    } catch (err) {
      const error = (err as Error)?.message ?? 'destroy failed';
      emit({ type: 'failed', error });
      return { status: 'failed', sandpitId: session.sandpitId, error };
    }

    const totalCost = routing.addMoney(session.spendToDate, final.customerView.spendToDate);
    this.sessions.delete(session.sandpitId);
    emit({ type: 'destroyed', sandpitId: session.sandpitId, totalCost });
    this.recordHookEvent('sandpit.destroy', session.sandpitId, {
      deploymentId: session.deploymentId,
      totalCostMinor: totalCost.amountMinor,
    });
    this.recordReceipt(session.sandpitId, final, 'destroyed sandpit', totalCost);
    return { status: 'destroyed', sandpitId: session.sandpitId, totalCost };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Run a refactor/review/test action as a serverless job in the sandpit. */
  private async runJob(action: SandpitAction, opts: SandpitJobOptions): Promise<SandpitJobResult> {
    const emit = this.emitter(opts);
    const fail = (error: string, deploymentId?: string): SandpitJobResult => {
      emit({ type: 'failed', workload: `sandpit-${action}`, error });
      return { status: 'failed', sandpitId: opts.sandpitId, action, deploymentId, error };
    };

    const session = this.sessions.get(opts.sandpitId);
    if (!session) return fail(`sandpit: unknown sandpit "${opts.sandpitId}"`);
    if (session.state !== 'running') {
      return fail(`sandpit: sandpit "${opts.sandpitId}" is "${session.state}" — not running`);
    }
    if (action === 'refactor' && !opts.instruction?.trim()) {
      return fail('sandpit: refactor requires a non-empty --instruction');
    }

    const allowed = await this.checkCovenant('sandpit:run', opts.projectId);
    if (!allowed) return fail('sandpit: sandpit:run denied by Project Covenant');

    const workload = `sandpit-${action}`;
    // Announce the job as soon as its placement is committed.
    const jobEmit = (event: SandpitProgressEvent) => {
      emit(event);
      if (event.type === 'committed') {
        emit({
          type: 'job-submitted',
          sandpitId: session.sandpitId,
          action,
          deploymentId: event.deploymentId,
        });
      }
    };
    const spec: WorkloadSpec = {
      kind: 'serverless_job',
      name: `${session.sandpitId}-${action}`,
      image: SANDPIT_IMAGE,
      command: sandpitJobCommand(action, opts.instruction),
      timeoutSeconds: Math.round((opts.timeoutMs ?? 30 * 60_000) / 1000),
      region: 'global',
      trustTier: 'verified',
      labels: {
        'capix.dev/sandpit': session.sandpitId,
        'capix.dev/action': action,
        'capix.dev/source-ref': `file://${session.sourcePath}`,
      },
    };

    const ran = await this.quoteCommitMonitor(workload, spec, 'stopped', jobEmit, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    });
    if ('error' in ran) {
      emit({ type: 'failed', workload, error: ran.error });
      return {
        status: 'failed',
        sandpitId: session.sandpitId,
        action,
        deploymentId: ran.deploymentId,
        error: ran.error,
      };
    }

    const deployment = ran.deployment;
    session.jobDeploymentIds.push(deployment.deploymentId);
    session.spendToDate = routing.addMoney(
      session.spendToDate,
      deployment.customerView.spendToDate
    );
    const summary = deployment.customerView.summary;
    emit({
      type: 'job-finished',
      sandpitId: session.sandpitId,
      action,
      deploymentId: deployment.deploymentId,
      status: 'succeeded',
      summary,
    });
    this.recordHookEvent('sandpit.job', session.sandpitId, {
      action,
      deploymentId: deployment.deploymentId,
    });
    this.recordReceipt(session.sandpitId, deployment, `ran sandpit ${action}`);
    return {
      status: 'succeeded',
      sandpitId: session.sandpitId,
      action,
      deploymentId: deployment.deploymentId,
      summary,
      cost: deployment.customerView.spendToDate,
    };
  }

  /** Quote → commit → monitor until `successState`; resolves to the final deployment or an error. */
  private async quoteCommitMonitor(
    workload: string,
    spec: WorkloadSpec,
    successState: DeploymentState,
    emit: (e: SandpitProgressEvent) => void,
    opts: SandpitCommonOptions & { timeoutMs: number }
  ): Promise<{ deployment: Deployment } | { error: string; deploymentId?: string }> {
    emit({ type: 'quoting', workload });
    let quote: routing.RouteQuote;
    try {
      quote = await routing.createRouteQuote(spec, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
    } catch (err) {
      return { error: (err as Error)?.message ?? 'quote failed' };
    }
    emit({
      type: 'quoted',
      workload,
      routeQuoteId: quote.routeQuoteId,
      expiresAt: quote.expiresAt,
    });

    const candidate = routing.bestCandidate(quote);
    if (!candidate) {
      return { error: 'smart router returned no placement candidates' };
    }

    emit({ type: 'committing', workload });
    let deploymentId: string;
    try {
      const receipt = await routing.commitRoute(quote.quoteToken, candidate.candidateId, {
        projectId: opts.projectId,
        signal: opts.signal,
      });
      deploymentId = receipt.deploymentId;
      emit({ type: 'committed', workload, deploymentId, routeReceiptId: receipt.routeReceiptId });
    } catch (err) {
      return { error: (err as Error)?.message ?? 'commit failed' };
    }

    try {
      const deployment = await this.monitor(workload, deploymentId, successState, emit, opts);
      return { deployment };
    } catch (err) {
      return { error: (err as Error)?.message ?? 'monitoring failed', deploymentId };
    }
  }

  /** Poll deployment state, emitting an event on every transition. */
  private async monitor(
    workload: string,
    deploymentId: string,
    successState: DeploymentState,
    emit: (e: SandpitProgressEvent) => void,
    opts: SandpitCommonOptions & { timeoutMs: number }
  ): Promise<Deployment> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const deadline = Date.now() + opts.timeoutMs;
    let lastState: DeploymentState | null = null;

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('sandpit aborted');
      let deployment: Deployment;
      try {
        deployment = await routing.getDeployment(deploymentId, {
          projectId: opts.projectId,
          signal: opts.signal,
        });
      } catch (err) {
        logger.warn('sandpit: state poll failed', {
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
          workload,
          deploymentId,
          state: deployment.state,
          summary: deployment.customerView.summary,
        });
      }
      if (deployment.state === successState) return deployment;
      if (deployment.state === 'failed' || deployment.state === 'destroyed') {
        throw new Error(`deployment entered state "${deployment.state}"`);
      }
      await sleep(pollIntervalMs, opts.signal);
    }

    throw new Error(
      `sandpit: timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${workload} ` +
        `(${deploymentId}) to reach "${successState}"`
    );
  }

  /** Fail-closed covenant gate. */
  private async checkCovenant(action: string, projectId?: string): Promise<boolean> {
    try {
      const perm = await intelligence.checkPermission(
        { action, environment: 'dev' },
        { projectId }
      );
      return perm.decision !== 'deny';
    } catch (err) {
      logger.warn('sandpit: covenant check failed — fail-closed', {
        action,
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  /**
   * Hash + size the source tree; the container mounts it by `file://` URI.
   * The digest covers the sorted relative paths so the control plane can
   * detect source drift between actions.
   */
  private async fingerprintSource(sourcePath: string): Promise<string> {
    const abs = resolve(sourcePath);
    const info = await stat(abs);
    if (!info.isDirectory()) {
      throw new Error(`sandpit: source path is not a directory: ${sourcePath}`);
    }
    const files: string[] = [];
    await listFiles(abs, abs, files);
    files.sort();
    const digest = createHash('sha256').update(files.join('\n')).digest('hex');
    return `file://${abs}#sha256=${digest}`;
  }

  private emitter(opts: SandpitCommonOptions): (e: SandpitProgressEvent) => void {
    return (event) => {
      try {
        opts.onEvent?.(event);
      } catch {
        // A broken consumer must never interrupt the sandpit loop.
      }
    };
  }

  /** Best-effort hook event; never throws into the sandpit loop. */
  private recordHookEvent(
    type: 'sandpit.create' | 'sandpit.job' | 'sandpit.destroy',
    sandpitId: string,
    payload: Record<string, unknown>
  ): void {
    intelligence
      .recordHookEvent({
        type,
        payload: { sandpitId, ...payload },
        source: 'capix-code:sandpit',
      })
      .catch((err) =>
        logger.warn('sandpit: hook event recording failed', {
          type,
          error: (err as Error)?.message,
        })
      );
  }

  /** Best-effort work receipt; never throws into the sandpit loop. */
  private recordReceipt(
    sandpitId: string,
    deployment: Deployment,
    summary: string,
    spend?: Money
  ): void {
    const cost = spend ?? deployment.customerView.spendToDate;
    intelligence
      .createWorkReceipt({
        kind: 'sandpit-run',
        costMinor: cost.amountMinor,
        asset: cost.currency,
        scale: cost.scale,
        summary: `${summary} (sandpit ${sandpitId}, deployment ${deployment.deploymentId})`,
        outcome: 'success',
        environment: 'dev',
        resourceIds: [sandpitId, deployment.deploymentId],
        source: 'capix-code:sandpit',
      })
      .catch((err) =>
        logger.warn('sandpit: work receipt recording failed', {
          sandpitId,
          error: (err as Error)?.message,
        })
      );
  }
}
