import path from 'node:path';
import { listRuns, parseSymbolId, VeritasError } from '@under18dev/veritas-core';
import { type PbtResult, replayPropertyTest } from '@under18dev/veritas-property-testing';
import { openProject, readArtifact } from './project.js';

export interface PbtReplay {
  runId: string;
  recorded: PbtResult;
  replayed: PbtResult;
  /** Same status and the same (shrunk) counterexample as the recorded run. */
  reproduced: boolean;
}

/**
 * Re-run a recorded property-based test (`veritas test replay <id>`) with its seed, run count and fast-check
 * replay path, against the property IR recorded in the same run.
 */
export async function replayPbt(
  root: string,
  resultId: string,
  options: { runId?: string; signal?: AbortSignal } = {},
): Promise<PbtReplay> {
  const { config } = await openProject(root);
  const runs = options.runId ? [options.runId] : listRuns(root);

  for (const runId of runs) {
    let results: PbtResult[];

    try {
      results = readArtifact(root, runId, 'pbt').data;
    } catch (error) {
      if (options.runId || !(error instanceof VeritasError) || error.code !== 'ARTIFACT_MISSING') throw error;
      continue;
    }
    const recorded = results.find((r) => r.id === resultId);

    if (!recorded) continue;
    const property = readArtifact(root, runId, 'properties').data.properties.find(
      (p) => p.id === recorded.propertyId,
    );
    const symbol = property?.targetSymbols[0];

    if (!property?.ir || !symbol)
      throw new VeritasError(
        'tool',
        'PBT_PROPERTY_MISSING',
        `run ${runId} has no formalized ${recorded.propertyId}`,
      );
    const { file, name } = parseSymbolId(symbol);
    const replayed = await replayPropertyTest(recorded, {
      root,
      ir: property.ir,
      bindings: [{ modelName: name, modulePath: path.join(root, file), exportName: name }],
      timeoutMs: Math.max(30_000, config.formal.maxSolverMs),
      allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const reproduced =
      replayed.status === recorded.status &&
      JSON.stringify(replayed.counterexample) === JSON.stringify(recorded.counterexample);

    return { runId, recorded, replayed, reproduced };
  }
  throw new VeritasError(
    'user',
    'PBT_RESULT_NOT_FOUND',
    `no property-based test result ${resultId}${options.runId ? ` in ${options.runId}` : ''}`,
    'the ids are in pbt.json of a deep run and in the replay command of a counterexample finding',
  );
}
