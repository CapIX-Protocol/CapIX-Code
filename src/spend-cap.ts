/**
 * Process-level spend cap for autonomous runs.
 *
 * `capix-code run --auto --spend-cap <usd>` exports `CAPIX_SPEND_CAP_USD_MINOR`
 * (integer micro-USD, scale 6 — the same minor units receipts carry). Every
 * inference stream feeds its real receipt cost (`provisionalCost.amount` at
 * `provisionalCost.scale`) into this ledger; the provider checks the ledger
 * before issuing any new request and refuses once the cap is reached, so no
 * code path can overshoot the budget.
 *
 * Honesty rules enforced here:
 * - Accounting comes only from real receipt cost events — never estimates.
 * - At >= 90% of the cap a warning is logged exactly once.
 * - At >= 100% new inference calls fail with capixCode `spend_cap_reached`.
 * - Nothing is persisted; the ledger lives for the duration of the process.
 */

import { logger } from './logger.js';

/** capixCode carried by the error thrown when the cap is exhausted. */
export const SPEND_CAP_REACHED_CODE = 'spend_cap_reached';

/** Error thrown when a new request would exceed the configured spend cap. */
export class SpendCapReachedError extends Error {
  readonly capixCode = SPEND_CAP_REACHED_CODE;
  constructor(
    readonly capMinor: string,
    readonly spentMinor: string
  ) {
    super(
      `spend cap reached: spent ${spentMinor} of ${capMinor} micro-USD; ` +
        'stopping instead of overshooting the budget'
    );
    this.name = 'SpendCapReachedError';
  }
}

export interface SpendCapStatus {
  /** Configured cap in micro-USD minor units; null when no cap is set. */
  capMinor: string | null;
  /** Real receipt-accounted spend so far, micro-USD minor units. */
  spentMinor: string;
  /** Whether the 90% warning has fired. */
  warnedAt90: boolean;
  /** Whether spent >= cap. */
  exceeded: boolean;
}

let spentMinor = 0n;
let warnedAt90 = false;

/** Read the configured cap from the environment (micro-USD, scale 6). */
export function readSpendCapMinor(env: NodeJS.ProcessEnv = process.env): bigint | null {
  const raw = env.CAPIX_SPEND_CAP_USD_MINOR?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    logger.warn('spend-cap: ignoring malformed CAPIX_SPEND_CAP_USD_MINOR', { raw });
    return null;
  }
  return BigInt(raw);
}

/** Scale-normalize a receipt cost amount (integer string at `scale`) to micro-USD (scale 6). */
export function toMicroUsd(amount: string, scale: number): bigint {
  if (!/^\d+$/.test(amount)) return 0n;
  const value = BigInt(amount);
  if (scale === 6) return value;
  if (scale > 6) return value / 10n ** BigInt(scale - 6);
  return value * 10n ** BigInt(6 - scale);
}

/**
 * Record real receipt cost against the cap. Returns the ledger status after
 * the update. Fires the one-shot 90% warning as a side effect.
 */
export function recordSpendCapCost(
  amount: string,
  scale: number,
  env: NodeJS.ProcessEnv = process.env
): SpendCapStatus {
  spentMinor += toMicroUsd(amount, scale);
  const status = spendCapStatus(env);
  if (!status.exceeded && !warnedAt90 && status.capMinor !== null && isAt90(status)) {
    warnedAt90 = true;
    logger.warn('spend-cap: 90% of the run budget is spent', {
      capMinor: status.capMinor,
      spentMinor: status.spentMinor,
    });
  }
  return status;
}

/** Current ledger status (no side effects). */
export function spendCapStatus(env: NodeJS.ProcessEnv = process.env): SpendCapStatus {
  const cap = readSpendCapMinor(env);
  return {
    capMinor: cap === null ? null : cap.toString(),
    spentMinor: spentMinor.toString(),
    warnedAt90,
    exceeded: cap !== null && spentMinor >= cap,
  };
}

function isAt90(status: SpendCapStatus): boolean {
  if (status.capMinor === null) return false;
  // spent >= 0.9 * cap  ⇔  10 * spent >= 9 * cap (integer math, no floats).
  return 10n * BigInt(status.spentMinor) >= 9n * BigInt(status.capMinor);
}

/**
 * Throw `SpendCapReachedError` when the configured cap is exhausted. Called
 * by the provider before every new inference request.
 */
export function assertSpendCapNotExceeded(env: NodeJS.ProcessEnv = process.env): void {
  const cap = readSpendCapMinor(env);
  if (cap !== null && spentMinor >= cap) {
    throw new SpendCapReachedError(cap.toString(), spentMinor.toString());
  }
}

/** Test hook: reset the in-process ledger. */
export function resetSpendCapLedger(): void {
  spentMinor = 0n;
  warnedAt90 = false;
}
