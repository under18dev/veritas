import type { BundledTools } from '@under18dev/veritas-core';
import { bundledMutatorVersion } from '@under18dev/veritas-mutation-adapter';
import { bundledFastCheckVersion } from '@under18dev/veritas-property-testing';
import { bundledZ3SolverVersion } from '@under18dev/veritas-solver-z3';

/** The tools this installation brings, as the packages that run them resolve them; for `runDoctor`. */
export function bundledTools(): BundledTools {
  return {
    '@mizchi/mutator': bundledMutatorVersion(),
    'fast-check': bundledFastCheckVersion(),
    'z3-solver': bundledZ3SolverVersion(),
  };
}
