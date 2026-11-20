import type { RunStore } from './artifacts/store.js';
import type { VeritasConfig } from './config/schema.js';
import { VeritasError } from './exit-codes.js';
import { logEvent } from './run-context.js';
import type { StageName, StageResult, UsageCounters } from './schema/run.js';
import type { StageStatus } from './schema/status.js';

export interface StageContext {
  root: string;
  config: VeritasConfig;
  store: RunStore;
  signal: AbortSignal;
  /** Results of earlier stages in the same run, keyed by stage name. */
  outputs: Map<StageName, unknown>;
  log: (message: string) => void;
}

export interface StageOutcome<T = unknown> {
  status: StageStatus;
  output?: T;
  artifacts?: string[];
  messages?: string[];
  usage?: Partial<UsageCounters>;
}

export interface Stage<T = unknown> {
  name: StageName;
  /** Stages listed here must have run (in any status) before this one. */
  dependsOn: StageName[];
  run(ctx: StageContext): Promise<StageOutcome<T>>;
}

export const emptyUsage = (): UsageCounters => ({ llmTokens: 0, solverMs: 0, mutants: 0, testRuns: 0 });

export function addUsage(a: UsageCounters, b: Partial<UsageCounters>): UsageCounters {
  return {
    llmTokens: a.llmTokens + (b.llmTokens ?? 0),
    solverMs: a.solverMs + (b.solverMs ?? 0),
    mutants: a.mutants + (b.mutants ?? 0),
    testRuns: a.testRuns + (b.testRuns ?? 0),
  };
}

/**
 * Runs stages in order. A thrown error becomes an `error` stage result instead of aborting silently;
 * a stage never reports `succeeded` on behalf of another. Dependents of a failed stage are `skipped`.
 */
export async function runStages(stages: Stage[], ctx: Omit<StageContext, 'outputs'>): Promise<StageResult[]> {
  const outputs = new Map<StageName, unknown>();
  const results: StageResult[] = [];
  const statusOf = new Map<StageName, StageStatus>();
  for (const stage of stages) {
    const started = new Date();
    let outcome: StageOutcome;
    const blocked = stage.dependsOn.filter((d) => {
      const s = statusOf.get(d);
      return s === undefined || s === 'error' || s === 'cancelled' || s === 'failed' || s === 'timeout';
    });
    if (ctx.signal.aborted) {
      outcome = { status: 'cancelled', messages: ['run cancelled before this stage started'] };
    } else if (blocked.length > 0) {
      outcome = {
        status: 'skipped',
        messages: [`skipped: prerequisite stage(s) not usable: ${blocked.join(', ')}`],
      };
    } else {
      logEvent('debug', `stage ${stage.name} started`, { event: 'stage', stage: stage.name, at: 'start' });
      try {
        outcome = await stage.run({ ...ctx, outputs });
        if (outcome.output !== undefined) outputs.set(stage.name, outcome.output);
      } catch (error) {
        const message =
          error instanceof VeritasError
            ? `${error.code}: ${error.message}`
            : `unexpected error: ${(error as Error).message}`;
        outcome = { status: ctx.signal.aborted ? 'cancelled' : 'error', messages: [message] };
      }
    }
    const finished = new Date();
    logEvent(
      'debug',
      `stage ${stage.name} ${outcome.status} in ${finished.getTime() - started.getTime()} ms`,
      {
        event: 'stage',
        stage: stage.name,
        at: 'end',
        status: outcome.status,
        durationMs: finished.getTime() - started.getTime(),
      },
    );
    statusOf.set(stage.name, outcome.status);
    results.push({
      stage: stage.name,
      status: outcome.status,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      artifacts: outcome.artifacts ?? [],
      messages: outcome.messages ?? [],
      usage: addUsage(emptyUsage(), outcome.usage ?? {}),
    });
  }
  return results;
}
