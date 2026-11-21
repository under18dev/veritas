import path from 'node:path';
import { unlinkedByInference } from '@under18dev/veritas-assessment';
import type { Mutant, TestCase, VeritasConfig } from '@under18dev/veritas-core';
import { isTestSupportPath, type TestInventory } from '@under18dev/veritas-test-inventory';

/** Mutants per source line the confirmation runs: one is enough to show a test observes the line. */
export const CONFIRMATION_MUTANTS_PER_LINE = 1;
/**
 * Share of mutation.timeoutMs after which the main run starts no new mutant when there are tests to check, instead of
 * mutator's usual 75%: what the main run leaves over is the check's time.
 */
export const MAIN_RUN_BUDGET_SHARE = 0.55;
/** The confirmation needs at least this much of mutation.timeoutMs left to start. */
export const MIN_CONFIRMATION_MS = 30_000;

export interface ConfirmationSelection {
  /** Tests static analysis could not link and the main run credited with no kill. */
  testIds: string[];
  /** Their test files, which are the only ones the confirmation runs. */
  testFiles: string[];
  /**
   * The only sources it mutates: for each test, the project files it calls into, or every project source its file
   * imports (transitively) when static analysis sees it call none.
   */
  sourceFiles: string[];
}

/**
 * The tests to confirm and what to run for them. A test qualifies when static analysis calls it disconnected only
 * because it found no link (it does assert, see `unlinkedByInference`), it is not skipped, and the main run's
 * mutants credit it with no kill. A test whose file imports no project source in scope cannot kill a mutant.
 */
export function selectConfirmation(
  inventory: Pick<TestInventory, 'tests' | 'files'>,
  mutants: readonly Mutant[],
  config: VeritasConfig,
  scope?: string[],
): ConfirmationSelection {
  const killers = new Set(mutants.flatMap((m) => m.killedBy));
  const { include, exclude, testInclude } = config.analysis;
  const matches = (file: string, globs: string[]) => globs.some((glob) => path.posix.matchesGlob(file, glob));
  const isSource = (file: string) =>
    matches(file, include) &&
    !matches(file, exclude) &&
    !matches(file, testInclude) &&
    !isTestSupportPath(file) &&
    (!scope?.length || matches(file, scope));
  const dependenciesOf = new Map(inventory.files.map((f) => [f.path, f.dependencies.filter(isSource)]));
  // The code a test exercises first is what it calls; mutants there are the ones it is likeliest to detect, so only
  // those files are mutated. A test static analysis sees calling nothing gets every source its file imports.
  const sourcesFor = (t: TestCase): string[] => {
    const imported = dependenciesOf.get(t.file) ?? [];
    const called = new Set(t.calledSymbols.map((s) => s.slice(0, s.lastIndexOf('#'))));
    const direct = imported.filter((f) => called.has(f));

    return direct.length > 0 ? direct : imported;
  };
  const tests = inventory.tests.filter(
    (t) =>
      unlinkedByInference(t) &&
      !t.modifiers.includes('skip') &&
      !t.modifiers.includes('todo') &&
      !killers.has(t.id) &&
      sourcesFor(t).length > 0,
  );

  return {
    testIds: tests.map((t) => t.id),
    testFiles: [...new Set(tests.map((t) => t.file))].sort(),
    sourceFiles: [...new Set(tests.flatMap(sourcesFor))].sort(),
  };
}

export interface MergedConfirmation {
  mutants: Mutant[];
  /** For each confirmed test, the main-run mutants it ran to a verdict in the confirmation. */
  ranBy: Record<string, string[]>;
  /** Confirmed tests that killed at least one mutant. */
  killedBy: string[];
  /**
   * Mutants the confirmation killed that the main run reports as survivors or as covered by no test, which
   * contradicts it; left as the main run has them.
   */
  inconsistent: string[];
  /** Mutants the main run left undecided (`pending`, `unknown`) that are killed now because the check killed them. */
  adopted: string[];
}

/**
 * Merge the confirmation's results for the confirmed tests into the main run's mutants. Only facts the narrower
 * run can establish are taken over: a kill by a confirmed test (a mutant the main run killed or left undecided,
 * such as one its time budget did not reach, becomes killed), and that a confirmed test ran a mutant the main run
 * decided. A survivor of the confirmation says nothing about tests it did not run, so it never changes a status.
 * A main-run survivor or uncovered mutant the confirmation killed (a flaky test, say) is reported, not merged.
 */
export function mergeConfirmation(
  mutants: readonly Mutant[],
  confirmation: readonly Mutant[],
  testIds: readonly string[],
): MergedConfirmation {
  const checked = new Set(testIds);
  const byId = new Map(confirmation.map((m) => [m.id, m]));
  const ranBy: Record<string, string[]> = {};
  const killedBy = new Set<string>();
  const inconsistent: string[] = [];
  const adopted: string[] = [];
  const undecided = new Set<Mutant['status']>(['pending', 'unknown']);
  const merged = mutants.map((m) => {
    const c = byId.get(m.id);

    if (!c || (c.status !== 'killed' && c.status !== 'survived')) return m;
    const killers = c.status === 'killed' ? c.killedBy.filter((t) => checked.has(t)) : [];
    const ran = [...new Set([...c.coveredBy, ...c.killedBy])].filter((t) => checked.has(t));

    if (c.status === 'killed' && (m.status === 'survived' || m.status === 'no_coverage')) {
      if (c.killedBy.length > 0) inconsistent.push(m.id);

      return m;
    }
    let next = m;

    if (c.status === 'killed' && undecided.has(m.status)) {
      adopted.push(m.id);
      next = {
        ...m,
        status: 'killed',
        killedBy: [...new Set([...m.killedBy, ...c.killedBy])],
        coveredBy: [...new Set([...m.coveredBy, ...c.coveredBy])],
        statusReason: `killed in the run that checked tests static analysis could not link (it was ${m.status} in the main run)`,
      };
    } else if (m.status === 'killed' || m.status === 'survived') {
      next = {
        ...m,
        killedBy: [...new Set([...m.killedBy, ...killers])],
        coveredBy: [...new Set([...m.coveredBy, ...ran])],
      };
    } else {
      return m;
    }

    for (const t of ran) ranBy[t] = [...(ranBy[t] ?? []), m.id];

    for (const t of killers) killedBy.add(t);

    return next;
  });

  return { mutants: merged, ranBy, killedBy: [...killedBy].sort(), inconsistent, adopted };
}
