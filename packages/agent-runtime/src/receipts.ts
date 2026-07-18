/**
 * @capix/agent-runtime — receipt hashing and local anchoring.
 *
 * Every unit of billable work the runtime records produces a receipt with
 * integer minor-unit cost. Each receipt gets a SHA-256 leaf hash over its
 * canonical form; the set of a session's receipt leaf hashes folds into a
 * Merkle root that anchors the session to the settlement ledger. The root is
 * computed locally — `verifyReceipt` recomputes the leaf hash and re-walks
 * the tree client-side, so verification never trusts the API.
 */

import { createHash } from 'node:crypto';
import type { ReceiptRow } from './store.js';

export const RECEIPT_ASSET = 'USDC';
export const RECEIPT_SCALE = 6;

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Canonical fields of a receipt, in a stable order. */
export function canonicalReceipt(receipt: {
  receiptId: string;
  sessionId: string;
  turnId: string;
  kind: string;
  modelCapability: string;
  costMinor: string;
  asset: string;
  scale: number;
  summary: string;
  outcome: string;
  createdAt: string;
}): string {
  return [
    'capix:receipt:v1',
    receipt.receiptId,
    receipt.sessionId,
    receipt.turnId,
    receipt.kind,
    receipt.modelCapability,
    receipt.costMinor,
    receipt.asset,
    String(receipt.scale),
    receipt.summary,
    receipt.outcome,
    receipt.createdAt,
  ].join('|');
}

export function receiptLeafHash(receipt: Parameters<typeof canonicalReceipt>[0]): string {
  return sha256Hex(canonicalReceipt(receipt));
}

/** Fold leaf hashes into a Merkle root (duplicate-last on odd levels). */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return '';
  let level = [...leafHashes].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(`${left}:${right}`));
    }
    level = next;
  }
  return level[0]!;
}

export function sessionReceiptRoot(receipts: ReceiptRow[]): string {
  return merkleRoot(receipts.map((r) => r.leaf_hash));
}

export function receiptRowToLeafInput(row: ReceiptRow): Parameters<typeof canonicalReceipt>[0] {
  return {
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    kind: row.kind,
    modelCapability: row.model_capability,
    costMinor: row.cost_minor,
    asset: row.asset,
    scale: row.scale,
    summary: row.summary,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}
