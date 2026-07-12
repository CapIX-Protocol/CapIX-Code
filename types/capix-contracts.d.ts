declare module '@capix/contracts' {
  export interface CapixRouteEvent {
    type: 'capix.route';
    receiptId: string;
    modelCapability: string;
    region: string;
    privacyClass: string;
    estimatedCeiling?: number;
  }
  export interface ContentDeltaEvent {
    type: 'content.delta';
    content: string;
    role?: string;
  }
  export interface ToolDeltaEvent {
    type: 'tool.delta';
    toolCallId: string;
    function?: { name?: string; arguments?: string };
    index: number;
  }
  export interface CapixUsageEvent {
    type: 'capix.usage';
    inputUnits: number;
    outputUnits: number;
    cacheUnits?: number;
    computeUnits?: number;
    provisionalCost?: { amount: string; asset: string; scale: number };
  }
  export interface CapixFinalEvent {
    type: 'capix.final';
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
    finalUsage: Omit<CapixUsageEvent, 'type'>;
    receiptId: string;
    ledgerRef?: string;
    retryCount?: number;
    fallbackCount?: number;
  }
  export interface CapixErrorEvent {
    type: 'capix.error';
    capixCode: string;
    message: string;
    supportId?: string;
    retryClass?: 'none' | 'retry' | 'retry-after';
    retryAfterMs?: number;
  }
  export type InferenceStreamChunk =
    | CapixRouteEvent
    | ContentDeltaEvent
    | ToolDeltaEvent
    | CapixUsageEvent
    | CapixFinalEvent
    | CapixErrorEvent;
  export interface InferenceRequest {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
    maxTokens?: number;
    temperature?: number;
    tools?: unknown[];
    projectId?: string;
    savedPolicyId?: string;
    privateEndpointId?: string;
  }
  export interface InferenceErrorResponse {
    capixCode: string;
    message: string;
    status: number;
    supportId?: string;
    traceId?: string;
    retryClass?: 'none' | 'retry' | 'retry-after';
  }

  /** Settlement epoch status (root anchors the CPX ledger). */
  export interface SettlementStatusEvent {
    epoch: string;
    root: string;
    cluster: string;
    paused: boolean;
  }

  /** Result of a local merkle proof verification. */
  export interface ProofVerifiedEvent {
    receiptId: string;
    verified: boolean;
    root: string;
  }
}
