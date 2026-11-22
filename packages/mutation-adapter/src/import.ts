import { realpathSync } from 'node:fs';
import {
  createRedactor,
  Mutant,
  type MutantStatus,
  resolveInsideRoot,
  stableId,
  toPosixRelative,
  VeritasError,
} from '@under18dev/veritas-core';
import { z } from 'zod';
import {
  compileTitleTemplate,
  joinTitles,
  literalTitle,
  matchesTitleTemplate,
  TemplateSet,
  type TitleTemplate,
} from './each-title.js';

export type ReportSource = 'mutator' | 'stryker' | 'mutation-testing-elements';

const Position = z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() });

/** The subset of the mutation-testing-elements report (schemaVersion 2) this adapter reads. */
export const MutationTestingReport = z.object({
  schemaVersion: z.string().regex(/^2(\.|$)/, 'expected a mutation-testing-elements schemaVersion 2 report'),
  files: z.record(
    z.string(),
    z.object({
      source: z.string().optional(),
      mutants: z.array(
        z.object({
          id: z.string().min(1),
          mutatorName: z.string(),
          replacement: z.string().optional(),
          location: z.object({ start: Position, end: Position }),
          status: z.string(),
          statusReason: z.string().optional(),
          killedBy: z.array(z.string()).optional(),
          coveredBy: z.array(z.string()).optional(),
          duration: z.number().nonnegative().optional(),
        }),
      ),
    }),
  ),
  testFiles: z
    .record(z.string(), z.object({ tests: z.array(z.object({ id: z.string(), name: z.string() })) }))
    .optional(),
  framework: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});
export type MutationTestingReport = z.infer<typeof MutationTestingReport>;

const STATUS_MAP: Record<string, MutantStatus> = {
  Killed: 'killed',
  Survived: 'survived',
  NoCoverage: 'no_coverage',
  Timeout: 'timeout',
  CompileError: 'compile_error',
  RuntimeError: 'runtime_error',
  Ignored: 'ignored',
  Pending: 'pending',
};

/** Marker mutator puts in `statusReason` for mutants only a spawned child process may reach. */
export const CHILD_PROCESS_MARKER = 'possibly reached in a child process';

/**
 * Split a mutator test id (`<file>#<full name>`) into the parts test-inventory hashes. The runner joins suite titles
 * and the test title with `separator` (Vitest's ` > `, the default), so a title that itself contains the separator is
 * split too. With `projectPrefix` (Vitest, whose multi-project runs prefix names with `[name] `) a leading bracketed
 * label is dropped. Jest joins titles with a space, which makes this split a guess for any title with a space:
 * `ImportOptions.testIds` resolves such names exactly instead.
 */
export function mutatorTestRef(
  name: string,
  separator = ' > ',
  projectPrefix = true,
): { file: string; suitePath: string[]; name: string } {
  const { file, full } = mutatorTestName(name, projectPrefix);
  const parts = full.split(separator);
  const testName = parts.pop() ?? '';

  return { file, suitePath: parts, name: testName };
}

/**
 * The file and the full test name of a mutator test id (`<file>#<full name>`); with `projectPrefix`, without a
 * leading `[project] ` label.
 */
export function mutatorTestName(name: string, projectPrefix = true): { file: string; full: string } {
  const hash = name.indexOf('#');
  const file = hash < 0 ? '' : name.slice(0, hash).replaceAll('\\', '/');
  const literal = hash < 0 ? name : name.slice(hash + 1);

  return { file, full: projectPrefix ? literal.replace(/^\[[^\]]*\] /, '') : literal };
}

/**
 * Test ids by `<file>#<full name>`: a `Map` from `testIdsByFullName`, or anything with the same `get`. A name mapped
 * to null belongs to more than one inventoried test. `resolve`, when present, decides instead, from the keys of every
 * reading of one name (with and without a `[project] ` label), as a `TestNameIndex` does to match the names of
 * table-driven tests to their templates. Null from either means the name may belong to more than one test.
 */
export interface TestNameLookup {
  get(key: string): string | null | undefined;
  resolve?(keys: readonly string[]): string | null | undefined;
  /** Every test name of the report, given before any is resolved (see `TestNameIndex.observe`). */
  observe?(names: Iterable<string>): void;
}

/**
 * The test id test-inventory assigns to the test behind a mutator test name. With `testIds` (keyed by
 * `<file>#<full name>`), the name is looked up as written and, with `projectPrefix`, without a leading `[project] `
 * label (so a title that starts with brackets is not cut): by `testIds.resolve` when it has one, otherwise exactly,
 * the first reading that is known winning. Otherwise the id comes from the name split with `separator`. A name that
 * may belong to more than one inventoried test gets an id of its own that matches none of them, so no kill is
 * credited to a test that may not have run.
 */
export function mutatorTestId(
  name: string,
  separator = ' > ',
  testIds?: TestNameLookup,
  projectPrefix = true,
): string {
  if (testIds !== undefined) {
    const keys = (projectPrefix ? [false, true] : [false]).map((strip) => {
      const { file, full } = mutatorTestName(name, strip);

      return `${file}#${full}`;
    });
    const known = testIds.resolve
      ? testIds.resolve(keys)
      : keys.map((key) => testIds.get(key)).find((id) => id !== undefined);

    if (known !== undefined) {
      if (known !== null) return known;
      const { file, full } = mutatorTestName(name, false);

      return stableId('T', { file, ambiguous: full });
    }
  }

  return stableId('T', mutatorTestRef(name, separator, projectPrefix));
}

/**
 * An inventoried test as name resolution needs it: `modifiers` tells table-driven tests (`each`) apart, and
 * `granularity` and `inexactName` the tests whose full name static analysis could not read exactly.
 */
export interface NamedTest {
  id: string;
  file: string;
  suitePath: readonly string[];
  name: string;
  modifiers?: readonly string[];
  granularity?: 'test' | 'suite';
  inexactName?: 'dynamic_title' | 'dynamic_suite' | 'registered_in_function';
  /** The test is registered on a condition, so it may not have run (or, in a loop, may have run more than once). */
  conditional?: true;
  /**
   * Positions in `[...suitePath, name]` of the titles the runner formats for each row; the others are reported as
   * written. When a table-driven test has none recorded (an older inventory), every title is read as a template.
   */
  tableTitles?: readonly number[];
  /** Options of the test or an enclosing suite could not be read, so they may focus it. */
  optionsUnknown?: true;
}

/** A test file as name resolution needs it: whether it may register tests static analysis did not see. */
export interface NamedTestFile {
  path: string;
  inexactNames?: 'open_collection' | 'imported_registrations' | 'imported_open_module';
}

/** Why static analysis could not read the full name of every test a file runs. */
export type InexactReason = NonNullable<NamedTest['inexactName'] | NamedTestFile['inexactNames']>;

/**
 * The lookup `mutatorTestId` resolves names with: each test's id by `<file>#<full name>`, the full name joined with
 * `separator`, and null for a full name that more than one test has.
 */
export function testIdsByFullName(
  tests: readonly NamedTest[],
  separator: string,
): Map<string, string | null> {
  const ids = new Map<string, string | null>();

  for (const test of tests) {
    const key = `${test.file}#${[...test.suitePath, test.name].join(separator)}`;
    const seen = ids.get(key);
    ids.set(key, seen === undefined || seen === test.id ? test.id : null);
  }

  return ids;
}

/** Why a name was credited to no test: what else it could belong to. */
export type WithheldReason =
  | { kind: 'templates' }
  | { kind: 'exact_and_template' }
  /** The only test with the name is skipped or a todo, so it cannot have run under it. */
  | { kind: 'skipped_exact' }
  | { kind: 'inexact_file'; because: InexactReason };

/** mutator's suffix for the second and later tests of a run with one full name (`case 1#2`). */
const DUPLICATE = /^(.*)#([2-9]|[1-9]\d+)$/s;

/** `<file>#<full name>` without mutator's duplicate suffix; undefined when it has none. */
function withoutDuplicateSuffix(key: string): string | undefined {
  const hash = key.indexOf('#');
  const match = hash < 0 ? null : DUPLICATE.exec(key.slice(hash + 1));

  return match ? `${key.slice(0, hash)}#${match[1]}` : undefined;
}

/**
 * Test ids by full name (as `testIdsByFullName`), plus the templates of table-driven tests: a test with the `each`
 * modifier (its own `.each`/`.for`, or an enclosing `describe.each`) whose full name has placeholders matches the
 * names the runner formats from it, in the same file.
 *
 * A kill is never credited to a test other than the one the runner named, so a name is credited to no test (null)
 * and kept in `withheld` with the reason when it may belong to more than one:
 * - it fits the templates of two tests;
 * - one test has it exactly and another test may have run under it too (`exact_and_template`): the name fits that
 *   test's template and mutator reported it more than once, the exact test may not have run (skipped, a todo,
 *   registered on a condition, or next to a `.only` in its file), or the template fits it title by title. Vitest
 *   joins titles with ` > `, so a template's placeholders are kept within one title for this; with any other
 *   separator (Jest's space) titles cannot be told apart, and any fit counts;
 * - it fits a template, or mutator reported it more than once, in a file where static analysis could not read the
 *   full name of every test (a title or suite title that is not a literal, a test registered inside a function, or a
 *   call that may register tests, see `NamedTestFile`), since the runner may have named such a test.
 *
 * mutator numbers the second and later tests that share a full name (`case 1#2`; see `observe`). A name with such a
 * suffix is resolved through the name it shares as well, but only when mutator also reported that name and more than
 * one run of a test could have had it: two tests fit it, a test that fits it is table-driven or registered in a loop
 * or on a condition, or its file has tests static analysis could not name. Otherwise `#2` is part of the title.
 */
export class TestNameIndex implements TestNameLookup {
  private readonly exact: Map<string, string | null>;
  /** The templates of each file's table-driven tests, indexed by their literal prefix. */
  private readonly templates = new Map<string, TemplateSet<{ id: string; segments: TitleTemplate[] }>>();
  /** Tests that may run more than once under one name: table-driven, or registered in a loop or on a condition. */
  private readonly repeatable = new Set<string>();
  /** Every name mutator reported (see `observe`). */
  private readonly observed = new Set<string>();
  /** Files whose tests static analysis could not all name exactly, and why (the first reason found). */
  private readonly inexact = new Map<string, InexactReason>();
  /** Tests that may not have run: skipped, todo, conditional, or without `.only` in a file that has one. */
  private readonly mayNotRun = new Set<string>();
  /** Tests known not to run: `skip` or `todo`, their own or an enclosing suite's. */
  private readonly skipped = new Set<string>();
  /** Names (`<file>#<full name>`) more than one test of the run had, by mutator's numbered copies of them. */
  private readonly duplicated = new Set<string>();
  private readonly resolved = new Map<string, string | null | undefined>();
  /** Names (`<file>#<full name>`, as the runner reports them) credited to no test, and why. */
  readonly withheld = new Map<string, WithheldReason>();

  constructor(
    tests: readonly NamedTest[],
    private readonly separator: string,
    files: readonly NamedTestFile[] = [],
  ) {
    this.exact = testIdsByFullName(tests, separator);
    const onlyFiles = new Set(
      tests.filter((test) => test.modifiers?.includes('only')).map((test) => test.file),
    );
    // Files with a focused test that surely runs: the runner runs only the focused tests of such a file. Not a file
    // with a test registered on a condition, which includes options static analysis cannot read: that test may be
    // focused too.
    /**
     * Whether a test may or may not run: registered on a condition, or both focused and skipped (`{ skip: true,
     * only: true }`, which Vitest runs and focuses on, while an enclosing `describe.skip` still skips it).
     */
    const uncertain = (test: NamedTest) =>
      test.conditional === true ||
      ((test.modifiers?.includes('only') ?? false) &&
        (test.modifiers?.some((modifier) => modifier === 'skip' || modifier === 'todo') ?? false));
    const conditionalFiles = new Set(tests.filter(uncertain).map((test) => test.file));
    const focusedFiles = new Set(
      tests
        .filter(
          (test) =>
            test.modifiers?.includes('only') &&
            !uncertain(test) &&
            // Registered at collection level: a `.only` inside a function runs only if the function is called.
            test.inexactName === undefined &&
            !conditionalFiles.has(test.file) &&
            !test.modifiers.some((modifier) => modifier === 'skip' || modifier === 'todo'),
        )
        .map((test) => test.file),
    );

    for (const test of tests) {
      const inexact = test.inexactName ?? (test.granularity === 'suite' ? 'dynamic_title' : undefined);

      if (inexact !== undefined && !this.inexact.has(test.file)) this.inexact.set(test.file, inexact);

      // `skip` and `todo` (its own, `xit`, or an enclosing `describe.skip`) are known not to run; `skipIf`,
      // `runIf` and other conditions are not known either way.
      const focused = test.modifiers?.includes('only') ?? false;
      // Skipped or a todo, and not focused, never runs, whatever its table or condition; unfocused next to a focused
      // test that surely runs, unless it may run anyway.
      const skipped =
        ((test.modifiers?.some((modifier) => modifier === 'skip' || modifier === 'todo') ?? false) &&
          !focused &&
          !test.optionsUnknown) ||
        (!uncertain(test) && focusedFiles.has(test.file) && !focused);

      if (skipped) this.skipped.add(test.id);

      if (uncertain(test) || skipped || (onlyFiles.has(test.file) && !test.modifiers?.includes('only')))
        this.mayNotRun.add(test.id);

      if (uncertain(test)) this.repeatable.add(test.id);

      // A skipped table-driven test ran no row, so no reported name is its.
      if (!test.modifiers?.includes('each') || skipped) continue;
      this.repeatable.add(test.id);
      const titles = [...test.suitePath, test.name];
      // Only the titles the runner formats have placeholders; a `%s` in a plain suite title is text.
      const formatted = test.tableTitles ? new Set(test.tableTitles) : undefined;
      const segments = titles.map((title, k) =>
        formatted === undefined || formatted.has(k) ? compileTitleTemplate(title) : literalTitle(title),
      );
      const set = this.templates.get(test.file) ?? new TemplateSet();
      // Kept even without placeholders: a title with escapes only (`100%% sure`) is reported changed (`100% sure`).
      set.add(joinTitles(segments, separator), { id: test.id, segments });
      this.templates.set(test.file, set);
    }

    for (const file of files)
      if (file.inexactNames !== undefined && !this.inexact.has(file.path))
        this.inexact.set(file.path, file.inexactNames);
  }

  /**
   * Take note of every test name of the run (mutator's `testFiles` and the names it credits), before resolving any:
   * a name with mutator's duplicate suffix shows that its unnumbered name belongs to more than one test of the run.
   */
  observe(names: Iterable<string>): void {
    for (const reported of names) {
      // The file part as `mutatorTestId` reads it (`test\\a.test.ts` is `test/a.test.ts`).
      const { file, full } = mutatorTestName(reported, false);
      const name = `${file}#${full}`;
      this.observed.add(name);
      const base = withoutDuplicateSuffix(name);

      if (base !== undefined) this.duplicated.add(base);
    }
  }

  get(key: string): string | null | undefined {
    return this.exact.get(key);
  }

  resolve(keys: readonly string[]): string | null | undefined {
    const cacheKey = keys.join('\n');

    if (this.resolved.has(cacheKey)) return this.resolved.get(cacheKey);
    const id = this.decide(keys);
    this.resolved.set(cacheKey, id);

    return id;
  }

  private exactOf(keys: readonly string[]): string | null | undefined {
    return keys.map((key) => this.exact.get(key)).find((id) => id !== undefined);
  }

  /** The tests whose templates fit a name; with `byTitle`, only those that fit it title by title. */
  private fitting(keys: readonly string[], into: Set<string>, byTitle = false): void {
    for (const key of new Set(keys)) {
      const hash = key.indexOf('#');
      const full = key.slice(hash + 1);
      const titles = byTitle ? full.split(this.separator) : [];

      // A name that fits title by title fits the joined template too, so only those are checked further.
      for (const { id, segments } of this.templates.get(hash < 0 ? '' : key.slice(0, hash))?.matching(full) ??
        [])
        if (
          !byTitle ||
          (titles.length === segments.length &&
            segments.every((segment, k) => matchesTitleTemplate(segment, titles[k] ?? '')))
        )
          into.add(id);
    }
  }

  /** Whether more than one run of a test may have had a name the tests `ids` fit, in `file`. */
  private repeats(ids: ReadonlySet<string>, file: string): boolean {
    return ids.size > 1 || [...ids].some((id) => this.repeatable.has(id)) || this.inexact.has(file);
  }

  private decide(keys: readonly string[]): string | null | undefined {
    const name = keys[0] ?? '';
    const hash = name.indexOf('#');
    const file = hash < 0 ? '' : name.slice(0, hash);
    let lookup = keys;
    let exact = this.exactOf(keys);
    const candidates = new Set<string>();
    this.fitting(keys, candidates);
    let duplicate =
      this.duplicated.has(name) &&
      (exact === null || this.repeats(new Set([...candidates, ...(exact ? [exact] : [])]), file));

    // The name may be mutator's numbered copy of a name it also reported (`works#2`), even when a test has it as its
    // title: then both readings may hold.
    const bases = keys.map(withoutDuplicateSuffix);

    if (bases.every((base) => base !== undefined) && this.observed.has(bases[0] ?? '')) {
      const viaBase = new Set<string>();
      const baseExact = this.exactOf(bases);
      this.fitting(bases, viaBase);

      if (baseExact !== undefined && baseExact !== null) viaBase.add(baseExact);

      if (baseExact === null || (viaBase.size > 0 && this.repeats(viaBase, file))) {
        if (exact !== undefined) {
          // A title that ends in `#2`, and a second run of the shorter name: which one ran is not known.
          if (exact === null || baseExact === null || [...viaBase].some((id) => id !== exact)) {
            this.withheld.set(name, { kind: 'exact_and_template' });

            return null;
          }
        } else {
          if (baseExact === null) return null;

          if (baseExact !== undefined) viaBase.delete(baseExact);
          exact = baseExact;
          duplicate = true;
          lookup = bases;

          for (const id of viaBase) candidates.add(id);
        }
      }
    }

    if (exact === null) return null;

    // A skipped test did not run: a name it has exactly that a running template fits is the template's, and one no
    // running template fits came from a test static analysis did not see.
    if (exact !== undefined && this.skipped.has(exact)) {
      if (![...candidates].some((id) => id !== exact)) {
        this.withheld.set(name, { kind: 'skipped_exact' });

        return null;
      }
      exact = undefined;
    }
    const because = this.inexact.get(file);
    let reason: WithheldReason | undefined;

    if (exact !== undefined) {
      candidates.delete(exact);
      let shared = candidates.size > 0 && (duplicate || this.mayNotRun.has(exact));

      if (candidates.size > 0 && !shared) {
        if (this.separator !== ' > ') shared = true;
        else {
          const byTitle = new Set<string>();
          this.fitting(lookup, byTitle, true);
          byTitle.delete(exact);
          shared = byTitle.size > 0;
        }
      }

      if (shared) reason = { kind: 'exact_and_template' };
      else if (because !== undefined && duplicate) reason = { kind: 'inexact_file', because };
      else return exact;
    } else if (candidates.size === 0) return undefined;
    else if (because !== undefined) reason = { kind: 'inexact_file', because };
    else if (candidates.size > 1) reason = { kind: 'templates' };
    else return [...candidates][0];

    this.withheld.set(name, reason);

    return null;
  }
}

export interface ImportOptions {
  root: string;
  source: ReportSource;
  /** Keys of mutants mutator flags as reachable only from a child process (agent report `childProcess`). */
  childProcessKeys?: ReadonlySet<string>;
  /** What the test runner puts between suite titles and the test title in a full name (default Vitest's ` > `). */
  fullNameSeparator?: string;
  /** mutator may prefix test names with a `[project] ` label for this runner (default true, as for Vitest). */
  projectPrefix?: boolean;
  /**
   * Test ids of the inventoried tests by `<file>#<full name>`, to resolve mutator test names exactly; null for a full
   * name more than one test has (see `testIdsByFullName`); a `TestNameIndex` also matches the names of table-driven
   * tests to their templates.
   */
  testIds?: TestNameLookup;
}

/**
 * Normalize a mutation-testing-elements report into core mutants. Survivors stay `survived`:
 * equivalence is never inferred here.
 */
export function importMutationReport(json: unknown, options: ImportOptions): Mutant[] {
  // Secret environment values read once for the whole report, not for every field of every mutant.
  const redact = createRedactor();
  const parsed = MutationTestingReport.safeParse(json);

  if (!parsed.success) {
    throw new VeritasError(
      'tool',
      'MUTATION_REPORT_INVALID',
      `not a mutation-testing-elements report: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const report = parsed.data;
  const realRoot = realpathSync(options.root);
  const testNames = new Map<string, string>();

  for (const [file, { tests }] of Object.entries(report.testFiles ?? {})) {
    for (const t of tests) testNames.set(t.id, options.source === 'mutator' ? t.id : `${file}#${t.name}`);
  }
  if (options.source === 'mutator' && options.testIds?.observe) {
    const names = new Set(testNames.keys());

    for (const entry of Object.values(report.files))
      for (const m of entry.mutants)
        for (const id of [...(m.killedBy ?? []), ...(m.coveredBy ?? [])]) names.add(id);
    options.testIds.observe(names);
  }
  const testRef = (id: string): string => {
    if (options.source === 'mutator')
      return mutatorTestId(id, options.fullNameSeparator, options.testIds, options.projectPrefix ?? true);
    const raw = testNames.get(id) ?? id;

    // Raw refs are exposed as-is, so redact them; long ones are hashed (the hash reveals nothing).
    return raw.length <= 200 ? redact(raw) : stableId('TR', raw);
  };

  const mutants: Mutant[] = [];

  for (const fileKey of Object.keys(report.files).sort()) {
    const entry = report.files[fileKey];

    if (!entry) continue;
    const file = toPosixRelative(realRoot, resolveInsideRoot(realRoot, fileKey));

    for (const m of entry.mutants) {
      const { status, statusReason } = mapStatus(
        m.status,
        m.statusReason,
        options.childProcessKeys?.has(m.id),
      );
      mutants.push(
        Mutant.parse({
          id: stableId('M', { file, key: m.id }),
          backendKey: m.id,
          location: {
            file,
            range: {
              start: m.location.start.line,
              end: Math.max(m.location.start.line, m.location.end.line),
            },
          },
          // Every string taken from the report is untrusted and may carry secrets from the source.
          operator: redact(m.mutatorName),
          original: entry.source === undefined ? '' : redact(sliceSource(entry.source, m.location)),
          replacement: redact(m.replacement ?? ''),
          status,
          ...(statusReason === undefined ? {} : { statusReason: redact(statusReason) }),
          killedBy: unique((m.killedBy ?? []).map(testRef)),
          coveredBy: unique((m.coveredBy ?? []).map(testRef)),
          propertyIds: [],
          relevance: 'unknown',
          ...(m.duration === undefined ? {} : { durationMs: m.duration }),
          reproduction: redact(reproductionFor(options.source, realRoot, file, m.id, m.location)),
        }),
      );
    }
  }

  return mutants;
}

function mapStatus(
  raw: string,
  reason: string | undefined,
  childProcessFlag: boolean | undefined,
): { status: MutantStatus; statusReason?: string } {
  const status = Object.hasOwn(STATUS_MAP, raw) ? STATUS_MAP[raw] : undefined;

  if (status === undefined) {
    return {
      status: 'unknown',
      statusReason: [`unrecognized backend status: ${raw}`, reason].filter(Boolean).join('; '),
    };
  }
  const undetected = status === 'survived' || status === 'no_coverage';

  if (undetected && (childProcessFlag || reason?.includes(CHILD_PROCESS_MARKER))) {
    return { status: 'unknown', statusReason: reason ?? `${CHILD_PROCESS_MARKER} (backend status ${raw})` };
  }

  return reason === undefined ? { status } : { status, statusReason: reason };
}

/** Text between two 1-based (line, column) positions; the end column is exclusive. */
function sliceSource(
  source: string,
  loc: { start: { line: number; column: number }; end: { line: number; column: number } },
): string {
  const lines = source.split('\n');
  const offset = (line: number, column: number): number | undefined => {
    if (line > lines.length) return undefined;
    let at = 0;

    for (let i = 0; i < line - 1; i++) at += (lines[i]?.length ?? 0) + 1;

    return at + Math.max(0, column - 1);
  };
  const start = offset(loc.start.line, loc.start.column);
  const end = offset(loc.end.line, loc.end.column);

  if (start === undefined || end === undefined || end < start) return '';

  return source.slice(start, end);
}

/**
 * POSIX-shell quoting for display of reproduction commands. The rule is the same on every OS:
 * anything outside `[A-Za-z0-9_./:=@%+-]` (backslashes, spaces, quotes...) is single-quoted.
 */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function reproductionFor(
  source: ReportSource,
  root: string,
  file: string,
  key: string,
  loc: { start: { line: number; column: number }; end: { line: number; column: number } },
): string {
  if (source === 'mutator') return ['mutator', '--root', root, '--only', key].map(shellQuote).join(' ');

  if (source === 'stryker') {
    const range = `${file}:${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;

    return ['npx', 'stryker', 'run', '--mutate', range].map(shellQuote).join(' ');
  }

  return `unavailable: report from an unidentified backend (mutant ${key} in ${file})`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
