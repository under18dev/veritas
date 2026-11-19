/**
 * The Veritas Node API. It calls the same functions as the CLI and writes the same artifacts under
 * `.veritas/runs/<run-id>/`; nothing here spawns the CLI.
 */

export {
  ExitCode,
  type Finding,
  type FormalClaim,
  initProject,
  loadConfig,
  type Mutant,
  type Property,
  type Run,
  runDoctor,
  type TestAssessment,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
export * from '@under18dev/veritas-engine';
export {
  applyImprovement,
  type PlanOutcome,
  type PlanResult,
  planImprovement,
} from '@under18dev/veritas-improvement';
export { buildProgram, main } from './program.js';
