import type { TestRunnerProvider } from '@under18dev/veritas-core';

/**
 * Why `improve --apply` cannot run for the project at `root`, or null when it can: applying measures the added tests
 * by mutation testing before and after the patch, and mutator cannot run this project's tests (the Node.js test
 * runner, or a Jest project its integration does not handle).
 */
export function applyUnavailableReason(root: string, testRunner: TestRunnerProvider): string | null {
  const reason =
    testRunner.mutation.unsupportedReason(root) ??
    (testRunner.mutation.mutatorRunner === null
      ? `@mizchi/mutator cannot run ${testRunner.displayName} tests`
      : null);

  return reason === null
    ? null
    : `improve --apply is not available for this project: it measures the added tests by mutation testing, which is unsupported here (${reason}); review the planned tests and add them yourself`;
}
