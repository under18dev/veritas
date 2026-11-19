import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Approval,
  ApprovalLedger,
  type Property,
  resolveInsideRoot,
  SCHEMA_VERSION,
  stableId,
  VeritasError,
} from '@veritas/core';

export const APPROVALS_FILE = path.join('.veritas', 'approvals.json');

export function loadApprovals(root: string): ApprovalLedger {
  const file = resolveInsideRoot(root, APPROVALS_FILE);
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, approvals: [] };
  const parsed = ApprovalLedger.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new VeritasError(
      'user',
      'APPROVALS_INVALID',
      `${APPROVALS_FILE} is not a valid approval ledger`,
      'restore it from version control',
    );
  }
  return parsed.data;
}

/** Append-only: decisions are never edited or removed. */
export function recordDecision(
  root: string,
  property: Property,
  decision: Approval['decision'],
  actor: string,
  reason: string,
  now: Date = new Date(),
): Approval {
  if (!actor.trim())
    throw new VeritasError(
      'user',
      'APPROVAL_ACTOR',
      'an approval needs an actor',
      'pass --actor or set git user.name',
    );
  if (!reason.trim())
    throw new VeritasError('user', 'APPROVAL_REASON', 'an approval needs a reason', 'pass --reason "<why>"');
  const ledger = loadApprovals(root);
  const approval: Approval = {
    id: stableId('A', {
      property: property.id,
      version: property.version,
      decision,
      actor,
      at: now.toISOString(),
    }),
    propertyId: property.id,
    propertyVersion: property.version,
    decision,
    actor,
    reason,
    decidedAt: now.toISOString(),
    sourceIds: property.sourceIds,
  };
  ledger.approvals.push(approval);
  const file = resolveInsideRoot(root, APPROVALS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return approval;
}

export interface AppliedApprovals {
  properties: Property[];
  /** Decisions recorded for an older version of a property; they no longer apply. */
  staleApprovals: Approval[];
}

/**
 * Apply the latest decision per property, only when it was made for the current version.
 * Accepting one side of a conflict marks the other sides `superseded`.
 */
export function applyApprovals(properties: Property[], ledger: ApprovalLedger): AppliedApprovals {
  const latest = new Map<string, Approval>();
  for (const a of ledger.approvals) latest.set(a.propertyId, a);
  const staleApprovals: Approval[] = [];
  const out = properties.map((p) => ({ ...p }));
  const byId = new Map(out.map((p) => [p.id, p]));
  for (const p of out) {
    const a = latest.get(p.id);
    if (!a) continue;
    if (a.propertyVersion !== p.version) {
      staleApprovals.push(a);
      continue;
    }
    p.reviewedBy = a.actor;
    if (a.decision === 'accept') p.status = 'accepted';
    else if (a.decision === 'reject') p.status = 'rejected';
    else if (a.decision === 'review' && p.status === 'proposed') p.status = 'reviewed';
    else if (a.decision === 'supersede') p.status = 'superseded';
  }
  for (const p of out) {
    if (p.status !== 'accepted') continue;
    for (const other of p.conflictsWith) {
      const peer = byId.get(other);
      if (peer && peer.status === 'conflicted') {
        peer.status = 'superseded';
        peer.supersededBy = p.id;
      }
    }
  }
  return { properties: out, staleApprovals };
}
