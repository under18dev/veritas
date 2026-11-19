import type { StageName } from '@under18dev/veritas-core';
import { PROFILE_STAGES, type Profile, type RunOptions, type RunSummary, runVeritas } from './run.js';

/** Options of the per-stage API: everything `runVeritas` takes except the command name and stage list. */
export type StageOptions = Omit<RunOptions, 'command' | 'stages'>;

/**
 * The stages each command runs, dependencies first. The CLI, MCP server and these functions share this table,
 * so `veritas analyze` and `analyze()` run the same stages and write the same artifacts.
 */
export const COMMAND_STAGES = {
  discover: ['discover'],
  analyze: ['index', 'discover', 'spec', 'map', 'assess'],
  mutate: ['index', 'discover', 'spec', 'map', 'mutate', 'assess'],
  prove: ['index', 'discover', 'spec', 'map', 'prove', 'assess', 'report'],
} as const satisfies Record<string, readonly StageName[]>;

const stages = (command: keyof typeof COMMAND_STAGES): StageName[] => [...COMMAND_STAGES[command]];

/** Collect specification evidence (`veritas discover`). */
export function discover(options: StageOptions): Promise<RunSummary> {
  return runVeritas({ ...options, command: 'discover', stages: stages('discover') });
}

/** Index code and tests, map them to properties and assess the tests (`veritas analyze`). Runs no project code. */
export function analyze(options: StageOptions): Promise<RunSummary> {
  return runVeritas({ offline: true, ...options, command: 'analyze', stages: stages('analyze') });
}

/** Run mutation testing and relate mutants to properties (`veritas mutate`). */
export function mutate(options: StageOptions): Promise<RunSummary> {
  return runVeritas({ offline: true, ...options, command: 'mutate', stages: stages('mutate') });
}

/** Verify formalized properties with Z3 or Lean (`veritas prove`). */
export function prove(options: StageOptions): Promise<RunSummary> {
  return runVeritas({ offline: true, ...options, command: 'prove', stages: stages('prove') });
}

/** Run the whole pipeline for a profile (`veritas run`). */
export function run(options: StageOptions & { profile?: Profile }): Promise<RunSummary> {
  const profile = options.profile ?? 'standard';
  return runVeritas({ ...options, profile, command: 'run', stages: [...PROFILE_STAGES[profile]] });
}
