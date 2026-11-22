import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type Approval,
  listRuns,
  loadConfig,
  type Property,
  RUNS_DIR,
  runCommand,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  applyApprovals,
  declaredProperties,
  diffRegistries,
  loadApprovals,
  type RegistryDiff,
  recordDecision,
} from '@under18dev/veritas-property-engine';
import { ARTIFACTS } from './artifacts.js';
import { latestRunWith, type OpenOptions, readArtifact } from './project.js';

export interface PropertyListOptions {
  /**
   * The project's configuration. Its declared properties (`properties`) are fully defined by it, so they are listed
   * (and can be accepted or rejected) before any run, and in their current version when the latest run checked an
   * older one or predates the declaration. Without it, only the latest run's properties are listed.
   */
  config?: VeritasConfig;
}

/**
 * The configuration whose declarations the spec commands add to the latest run's properties: undefined when the
 * project has none, or when it is a code configuration this context may not load (then only the run's properties
 * are listed, as without declarations). Any other configuration error is thrown.
 */
export async function propertyConfig(
  root: string,
  options: OpenOptions = {},
): Promise<VeritasConfig | undefined> {
  try {
    return (await loadConfig(root, options)).config;
  } catch (error) {
    if (
      error instanceof VeritasError &&
      (error.code === 'CONFIG_MISSING' || error.code === 'CONFIG_CODE_NOT_ALLOWED')
    )
      return undefined;
    throw error;
  }
}

/** The declared properties of a configuration, as the spec stage builds them. */
function configuredProperties(config: VeritasConfig): Property[] {
  return declaredProperties(config.properties, {
    integerDomain: config.formal.integerDomain,
    maxArrayLength: config.formal.maxArrayLength,
  });
}

/**
 * Properties of the latest run with the current approval ledger applied. With `options.config`, a declared property
 * the run does not have in its current version is added or replaced by the one the configuration defines now (the
 * run's own is kept when the versions match, with what the run recorded about it); `runId` is null when no run has
 * produced properties yet. Discovered properties only ever come from a run.
 */
export function listProperties(
  root: string,
  options: PropertyListOptions = {},
): { runId: string | null; properties: Property[] } {
  const runId = latestRunWith(root, 'properties');
  const declared = options.config ? configuredProperties(options.config) : [];

  if (!runId && declared.length === 0) {
    throw new VeritasError(
      'user',
      'NO_RUN',
      'no run has produced properties.json yet',
      'run `veritas run` or the matching stage first',
    );
  }
  const fromRun = runId ? readArtifact(root, runId, 'properties').data.properties : [];
  const current = new Map(declared.map((p) => [p.id, p]));
  const merged = fromRun.map((p) => {
    const now = current.get(p.id);

    if (!now) return p;
    current.delete(p.id);

    return now.version === p.version ? p : now;
  });

  return {
    runId,
    properties: applyApprovals([...merged, ...current.values()], loadApprovals(root)).properties,
  };
}

export function showProperty(
  root: string,
  id: string,
  options: PropertyListOptions = {},
): { property: Property; approvals: Approval[] } {
  const { properties } = listProperties(root, options);
  const property = properties.find((p) => p.id === id);

  if (!property)
    throw new VeritasError(
      'user',
      'PROPERTY_NOT_FOUND',
      options.config
        ? `no property ${id} in the latest run or the configuration`
        : `no property ${id} in the latest run`,
      'run `veritas spec list`',
    );

  return { property, approvals: loadApprovals(root).approvals.filter((a) => a.propertyId === id) };
}

async function gitUser(root: string): Promise<string> {
  const r = await runCommand('git', ['config', 'user.name'], { cwd: root, timeoutMs: 5000 });

  return r.exitCode === 0 ? r.stdout.trim() : '';
}

/**
 * Record a human decision on a property of the latest run or, with `options.config`, on a declared property of the
 * configuration (recorded for the version the declaration has now). The actor defaults to VERITAS_ACTOR, then git
 * user.name.
 */
export async function decideProperty(
  root: string,
  id: string,
  decision: 'accept' | 'reject',
  options: { reason: string; actor?: string } & PropertyListOptions,
): Promise<Approval> {
  const { property } = showProperty(root, id, options.config ? { config: options.config } : {});
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
