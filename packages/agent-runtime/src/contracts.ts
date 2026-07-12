/**
 * @capix/agent-runtime — cross-client contracts.
 *
 * Error types and response shapes shared between Capix Code TUI and
 * CapixIDE. Ensures both clients render the same error states.
 */

export interface CapixProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  capixCode: string;
  instance?: string;
  traceId?: string;
  supportId?: string;
  retryClass?: 'none' | 'retry' | 'retry-after';
  retryAfterMs?: number;
  limitScope?: string;
  resetTime?: string;
}

export class CapixAgentError extends Error {
  constructor(public readonly problem: CapixProblemDetail) {
    super(problem.detail || problem.title);
    this.name = 'CapixAgentError';
  }
}

export const CAPIX_ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  FEATURE_DISABLED: 'feature_disabled',
  SESSION_NOT_FOUND: 'session_not_found',
  MODEL_NOT_FOUND: 'model_not_found',
  PROVIDER_ERROR: 'provider_error',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type CapixErrorCode = (typeof CAPIX_ERROR_CODES)[keyof typeof CAPIX_ERROR_CODES];

export interface ClientMeta {
  client: 'capix-code' | 'capix-ide';
  version: string;
  releaseId?: string;
}

export interface RuntimeInfo {
  runtimeVersion: string;
  pluginVersion: string;
  acpVersion: string;
  client: ClientMeta;
}
