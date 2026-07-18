/**
 * Train — fine-tunes a base model on a local dataset via the Capix training
 * API, then registers the result in the user's model catalog.
 *
 * Refs:
 * - protocol/packages/contracts/openapi.yaml (/models/train, TrainingJob
 *   status machine: queued → provisioning → training → registering → ready |
 *   failed | cancelled)
 * - intelligence-client (covenant gate, work receipts, hook events)
 * - routing-client (createTrainingJob / getTrainingJob, listManagedModels)
 *
 * Flow per training run:
 * 1. validate + fingerprint the dataset locally (SHA-256, byte length, format
 *    inferred from extension) — the job references it by `file://` URI, and a
 *    missing/unreadable file fails before any network call;
 * 2. covenant gate — `models:train` must not be `deny` (fail-closed on fetch
 *    error, matching the deployer's infra gate);
 * 3. submit `POST /models/train` (idempotency key attached by the client);
 * 4. poll `GET /models/train/{jobId}` until a terminal state, emitting a
 *    progress event on every status/checkpoint transition;
 * 5. on `ready`, surface `registeredModelId` (format `private/<jobId>`) as the
 *    catalog entry and record a work receipt + hook events (best-effort,
 *    never blocks the run).
 *
 * Progress is streamed to the caller through the `onEvent` callback as it
 * happens; the returned `TrainResult` summarizes the run.
 *
 * What this deliberately does NOT do:
 * - upload dataset bytes or pick hardware (server-authoritative scheduling);
 * - expose provider or node identity (the contract never returns any);
 * - use floating-point money. All amounts are string-encoded integer minor
 *   units.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as intelligence from '../intelligence-client.js';
import { logger } from '../logger.js';
import * as routing from '../routing-client.js';
import type {
  TrainingDatasetSpec,
  TrainingHyperparameters,
  TrainingJob,
  TrainingJobStatus,
} from '../routing-client.js';

// ── Progress events ──────────────────────────────────────────────────────────

export type TrainProgressEvent =
  | { type: 'validating' }
  | { type: 'submitting'; baseModel: string }
  | { type: 'submitted'; jobId: string }
  | {
      type: 'state';
      jobId: string;
      state: TrainingJobStatus;
      percent?: number;
      currentEpoch?: number;
      totalEpochs?: number;
    }
  | { type: 'checkpoint'; jobId: string; checkpointId: string; epoch: number }
  | { type: 'registered'; jobId: string; modelId: string }
  | { type: 'failed'; jobId?: string; message: string }
  | { type: 'done'; jobId?: string; modelId?: string };

export interface TrainResult {
  status: 'ready' | 'failed' | 'cancelled';
  jobId?: string;
  modelId?: string;
  error?: string;
  /** String-encoded integer minor units of actual spend, when reported. */
  costMinor?: string;
  asset?: string;
  scale?: number;
}

export interface TrainOptions {
  baseModel: string;
  datasetPath: string;
  specialize: string;
  hyperparameters?: TrainingHyperparameters;
  projectId?: string;
  signal?: AbortSignal;
  /** Called synchronously as each progress event occurs. */
  onEvent?: (event: TrainProgressEvent) => void;
  /** Poll interval for job status (default 3000ms). */
  pollIntervalMs?: number;
  /** Overall training timeout (default 30 minutes — training runs long). */
  timeoutMs?: number;
  /** Resume from a prior checkpoint instead of the base weights. */
  resumeFromCheckpointId?: string;
}

const TERMINAL_STATES: ReadonlySet<TrainingJobStatus> = new Set(['ready', 'failed', 'cancelled']);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('training aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('training aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Infer the dataset wire format from the file extension. */
function datasetFormat(path: string): TrainingDatasetSpec['format'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jsonl')) return 'jsonl';
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.csv')) return 'csv';
  return 'text';
}

export class Trainer {
  /**
   * Train a specialized model. Expected failures (missing dataset, covenant
   * denial, job failure) resolve to a `TrainResult` — they never throw.
   */
  async train(opts: TrainOptions): Promise<TrainResult> {
    const emit = (event: TrainProgressEvent) => {
      try {
        opts.onEvent?.(event);
      } catch {
        // A broken consumer must never interrupt the training loop.
      }
    };

    // 1. Validate + fingerprint the dataset (local only — no network yet).
    emit({ type: 'validating' });
    let dataset: TrainingDatasetSpec;
    try {
      dataset = await this.fingerprintDataset(opts.datasetPath);
    } catch (err) {
      const error = (err as Error)?.message ?? 'dataset is unreadable';
      emit({ type: 'failed', message: error });
      emit({ type: 'done' });
      return { status: 'failed', error };
    }

    // 2. Covenant gate — fail-closed, before any job is submitted.
    const allowed = await this.checkCovenant(opts.projectId);
    if (!allowed) {
      const error = 'train: models:train denied by Project Covenant';
      emit({ type: 'failed', message: error });
      emit({ type: 'done' });
      return { status: 'failed', error };
    }

    // 3. Submit the job.
    emit({ type: 'submitting', baseModel: opts.baseModel });
    let job: TrainingJob;
    try {
      const submitted = await routing.createTrainingJob(
        {
          baseModel: opts.baseModel,
          dataset,
          hyperparameters: opts.hyperparameters,
          specializationPrompt: opts.specialize,
          projectId: opts.projectId,
          ...(opts.resumeFromCheckpointId
            ? { resumedFromCheckpointId: opts.resumeFromCheckpointId }
            : {}),
        },
        { projectId: opts.projectId, signal: opts.signal }
      );
      if (!submitted) throw new Error('empty training job response');
      job = submitted;
    } catch (err) {
      const error = (err as Error)?.message ?? 'training failed';
      emit({ type: 'failed', message: error });
      emit({ type: 'done' });
      return { status: 'failed', error };
    }
    emit({ type: 'submitted', jobId: job.jobId });
    this.recordHookEvent('train.submit', job.jobId, {
      baseModel: opts.baseModel,
      datasetFormat: dataset.format,
      datasetBytes: dataset.bytes,
      resumedFromCheckpointId: opts.resumeFromCheckpointId,
    });

    // 4. Monitor until a terminal state or timeout.
    let final: TrainingJob;
    try {
      final = await this.monitor(job.jobId, emit, opts);
    } catch (err) {
      const error = (err as Error)?.message ?? 'training failed';
      emit({ type: 'failed', jobId: job.jobId, message: error });
      emit({ type: 'done', jobId: job.jobId });
      return { status: 'failed', jobId: job.jobId, error };
    }

    // 5. Terminal states.
    if (final.status === 'ready') {
      const modelId = final.registeredModelId ?? `private/${final.jobId}`;
      emit({ type: 'registered', jobId: final.jobId, modelId });
      emit({ type: 'done', jobId: final.jobId, modelId });
      this.recordHookEvent('train.register', final.jobId, { modelId });
      this.recordReceipt(final, modelId);
      return {
        status: 'ready',
        jobId: final.jobId,
        modelId,
        costMinor: final.actualCost?.amountMinor,
        asset: final.actualCost?.currency,
        scale: final.actualCost?.scale,
      };
    }

    if (final.status === 'cancelled') {
      const error = 'training job was cancelled';
      emit({ type: 'failed', jobId: final.jobId, message: error });
      emit({ type: 'done', jobId: final.jobId });
      return { status: 'cancelled', jobId: final.jobId, error };
    }

    const error = final.failureReason ?? `training job entered state "${final.status}"`;
    emit({ type: 'failed', jobId: final.jobId, message: error });
    emit({ type: 'done', jobId: final.jobId });
    return { status: 'failed', jobId: final.jobId, error };
  }

  /** Fail-closed covenant gate for `models:train`. */
  private async checkCovenant(projectId?: string): Promise<boolean> {
    try {
      const perm = await intelligence.checkPermission(
        { action: 'models:train', environment: 'dev' },
        { projectId }
      );
      return perm.decision !== 'deny';
    } catch (err) {
      logger.warn('train: covenant check failed — fail-closed', {
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  /** Hash + size the dataset; the job references it by `file://` URI. */
  private async fingerprintDataset(datasetPath: string): Promise<TrainingDatasetSpec> {
    const abs = resolve(datasetPath);
    const bytes = await readFile(abs);
    return {
      uri: `file://${abs}`,
      format: datasetFormat(abs),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: String(bytes.byteLength),
    };
  }

  /** Poll job status, emitting an event on every status/checkpoint transition. */
  private async monitor(
    jobId: string,
    emit: (e: TrainProgressEvent) => void,
    opts: TrainOptions
  ): Promise<TrainingJob> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastState: TrainingJobStatus | null = null;
    let lastProgressKey: string | null = null;
    const seenCheckpoints = new Set<string>();

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('training aborted');
      let job: TrainingJob | undefined;
      try {
        job = await routing.getTrainingJob(jobId, {
          projectId: opts.projectId,
          signal: opts.signal,
        });
      } catch (err) {
        logger.warn('train: status poll failed', {
          jobId,
          error: (err as Error)?.message,
        });
        await sleep(pollIntervalMs, opts.signal);
        continue;
      }
      if (!job) {
        await sleep(pollIntervalMs, opts.signal);
        continue;
      }

      const percent = job.progress?.percent;
      const currentEpoch = job.progress?.currentEpoch;
      const totalEpochs = job.progress?.totalEpochs;
      const progressKey = `${percent ?? ''}/${currentEpoch ?? ''}/${totalEpochs ?? ''}`;
      if (job.status !== lastState || progressKey !== lastProgressKey) {
        lastState = job.status;
        lastProgressKey = progressKey;
        emit({
          type: 'state',
          jobId,
          state: job.status,
          ...(percent !== undefined ? { percent } : {}),
          ...(currentEpoch !== undefined ? { currentEpoch } : {}),
          ...(totalEpochs !== undefined ? { totalEpochs } : {}),
        });
      }

      for (const checkpoint of job.checkpoints ?? []) {
        if (!seenCheckpoints.has(checkpoint.checkpointId)) {
          seenCheckpoints.add(checkpoint.checkpointId);
          emit({
            type: 'checkpoint',
            jobId,
            checkpointId: checkpoint.checkpointId,
            epoch: checkpoint.epoch,
          });
        }
      }

      if (TERMINAL_STATES.has(job.status)) {
        return job;
      }
      await sleep(pollIntervalMs, opts.signal);
    }

    throw new Error(
      `train: timed out after ${Math.round(timeoutMs / 1000)}s waiting for job ${jobId} ` +
        'to reach a terminal state'
    );
  }

  /** Best-effort hook event; never throws into the training loop. */
  private recordHookEvent(
    type: 'train.submit' | 'train.register',
    jobId: string,
    payload: Record<string, unknown>
  ): void {
    intelligence
      .recordHookEvent({
        type,
        payload: { jobId, ...payload },
        source: 'capix-code:train',
      })
      .catch((err) =>
        logger.warn('train: hook event recording failed', {
          type,
          error: (err as Error)?.message,
        })
      );
  }

  /** Best-effort work receipt once the model is registered. */
  private recordReceipt(job: TrainingJob, modelId: string): void {
    const cost = job.actualCost ?? { amountMinor: '0', currency: 'USD', scale: 2 };
    intelligence
      .createWorkReceipt({
        kind: 'model-training',
        costMinor: cost.amountMinor,
        asset: cost.currency,
        scale: cost.scale,
        summary: `trained ${modelId} from ${job.baseModel} (job ${job.jobId})`,
        outcome: 'success',
        environment: 'dev',
        resourceIds: [job.jobId, modelId],
        source: 'capix-code:train',
      })
      .catch((err) =>
        logger.warn('train: work receipt recording failed', {
          jobId: job.jobId,
          error: (err as Error)?.message,
        })
      );
  }
}
