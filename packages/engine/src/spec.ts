import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type Approval,
  listRuns,
  type Property,
  RUNS_DIR,
  runCommand,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  applyApprovals,
  diffRegistries,
  loadApprovals,
  type RegistryDiff,
  recordDecision,
} from '@under18dev/veritas-property-engine';
import { ARTIFACTS } from './artifacts.js';
import { readArtifact, readLatest } from './project.js';

/** Properties of the latest run with the current approval ledger applied. */
export function listProperties(root: string): { runId: string; properties: Property[] } {
  const latest = readLatest(root, 'properties');
  return {
    runId: latest.runId,
    properties: applyApprovals(latest.data.properties, loadApprovals(root)).properties,
  };
}

export function showProperty(root: string, id: string): { property: Property; approvals: Approval[] } {
  const { properties } = listProperties(root);
  const property = properties.find((p) => p.id === id);
  if (!property)
    throw new VeritasError(
      'user',
      'PROPERTY_NOT_FOUND',
      `no property ${id} in the latest run`,
      'run `veritas spec list`',
    );
  return { property, approvals: loadApprovals(root).approvals.filter((a) => a.propertyId === id) };
}

async function gitUser(root: string): Promise<string> {
  const r = await runCommand('git', ['config', 'user.name'], { cwd: root, timeoutMs: 5000 });
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

/** Record a human decision. The actor defaults to VERITAS_ACTOR, then git user.name. */
export async function decideProperty(
  root: string,
  id: string,
  decision: 'accept' | 'reject',
  options: { reason: string; actor?: string },
): Promise<Approval> {
  const { property } = showProperty(root, id);
  const actor = options.actor ?? process.env.VERITAS_ACTOR ?? (await gitUser(root));
  return recordDecision(root, property, decision, actor, options.reason);
}

/** Diff the properties of the two most recent runs that produced them. */
export function diffLatest(root: string): { from: string | null; to: string; diff: RegistryDiff } {
  const runs = listRuns(root).filter((r) =>
    existsSync(path.join(root, RUNS_DIR, r, ARTIFACTS.properties.file)),
  );
  const [to, from] = runs;
  if (!to)
    throw new VeritasError('user', 'NO_RUN', 'no run has produced properties yet', 'run `veritas run` first');
  const after = readArtifact(root, to, 'properties').data.properties;
  const before = from ? readArtifact(root, from, 'properties').data.properties : [];
  return { from: from ?? null, to, diff: diffRegistries(before, after) };
}
