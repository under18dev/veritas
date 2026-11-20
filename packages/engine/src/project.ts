import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type ArtifactMeta,
  listRuns,
  loadConfig,
  RUNS_DIR,
  readEnvelope,
  resolveInsideRoot,
  stableId,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import { ARTIFACTS, type ArtifactData, type ArtifactName } from './artifacts.js';

export interface OpenOptions {
  allowCodeConfig?: boolean;
}

export async function openProject(
  root: string,
  options: OpenOptions = {},
): Promise<{ root: string; config: VeritasConfig; configHash: string }> {
  const loaded = await loadConfig(root, options);

  return { root, config: loaded.config, configHash: loaded.hash };
}

/** Most recent run that contains the given artifact, or null. */
export function latestRunWith(root: string, artifact: ArtifactName): string | null {
  for (const runId of listRuns(root)) {
    if (existsSync(path.join(root, RUNS_DIR, runId, ARTIFACTS[artifact].file))) return runId;
  }

  return null;
}

export function readArtifact<N extends ArtifactName>(
  root: string,
  runId: string,
  name: N,
): { meta: ArtifactMeta; data: ArtifactData<N> } {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId))
    throw new VeritasError('user', 'RUN_ID_INVALID', `invalid run id: ${runId}`);
  const file = resolveInsideRoot(root, path.join(RUNS_DIR, runId, ARTIFACTS[name].file));

  if (!existsSync(file)) {
    throw new VeritasError(
      'user',
      'ARTIFACT_MISSING',
      `run ${runId} has no ${ARTIFACTS[name].file}`,
      'run the stage that produces it',
    );
  }

  return readEnvelope(file, ARTIFACTS[name].schema) as { meta: ArtifactMeta; data: ArtifactData<N> };
}

/** Read an artifact from the latest run that has it. */
export function readLatest<N extends ArtifactName>(
  root: string,
  name: N,
): { runId: string; meta: ArtifactMeta; data: ArtifactData<N> } {
  const runId = latestRunWith(root, name);

  if (!runId) {
    throw new VeritasError(
      'user',
      'NO_RUN',
      `no run has produced ${ARTIFACTS[name].file} yet`,
      'run `veritas run` or the matching stage first',
    );
  }

  return { runId, ...readArtifact(root, runId, name) };
}

/** Deterministic default seed for a property: a signed 32-bit integer derived from its id. */
export function defaultSeed(propertyId: string): number {
  return Number.parseInt(stableId('S', propertyId).slice(2, 10), 16) | 0;
}
