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
import { compileTitleTemplate, matchesTitleTemplate, type TitleTemplate } from './each-title.js';

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
}

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
  | { kind: 'inexact_file'; because: NonNullable<NamedTest['inexactName']> };

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
 * and kept in `withheld` with the reason when it may belong to more than one: when it fits the templates of two
 * tests; when one test has it exactly and it also fits the template of another (`case 1` and `case %s`); and when it
 * fits a template in a file where static analysis could not read the full name of some test (a title or a suite
 * title that is not a literal, or a test registered inside a function), since the runner may have named that test.
 *
 * mutator numbers the second and later tests that share a full name (`case 1#2`; see `observe`). Such a name is
 * resolved through the name it shares as well, and in a file where static analysis could not read every full name
 * it is credited to no test even when one test has it exactly, since the other test of that name may be one whose
 * name was not read.
 */
export class TestNameIndex implements TestNameLookup {
  private readonly exact: Map<string, string | null>;
  private readonly templates = new Map<string, { id: string; template: TitleTemplate }[]>();
  /** Files with a test whose full name is not known exactly, and why (the first such test). */
  private readonly inexact = new Map<string, NonNullable<NamedTest['inexactName']>>();
  /** Names (`<file>#<full name>`) more than one test of the run had, by mutator's numbered copies of them. */
  private readonly duplicated = new Set<string>();
  private readonly resolved = new Map<string, string | null | undefined>();
  /** Names (`<file>#<full name>`, as the runner reports them) credited to no test, and why. */
  readonly withheld = new Map<string, WithheldReason>();

  constructor(tests: readonly NamedTest[], separator: string) {
    this.exact = testIdsByFullName(tests, separator);

    for (const test of tests) {
      const inexact = test.inexactName ?? (test.granularity === 'suite' ? 'dynamic_title' : undefined);

      if (inexact !== undefined && !this.inexact.has(test.file)) this.inexact.set(test.file, inexact);

      if (!test.modifiers?.includes('each')) continue;
      const template = compileTitleTemplate([...test.suitePath, test.name].join(separator));

      if (template === undefined) continue;
      const list = this.templates.get(test.file) ?? [];
      list.push({ id: test.id, template });
      this.templates.set(test.file, list);
    }
  }

  /**
   * Take note of every test name of the run (mutator's `testFiles` and the names it credits), before resolving any:
   * a name with mutator's duplicate suffix shows that its unnumbered name belongs to more than one test of the run.
   */
  observe(names: Iterable<string>): void {
    for (const name of names) {
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

  private fitting(keys: readonly string[], into: Set<string>): void {
    for (const key of keys) {
      const hash = key.indexOf('#');
      const full = key.slice(hash + 1);

      for (const { id, template } of this.templates.get(hash < 0 ? '' : key.slice(0, hash)) ?? [])
        if (matchesTitleTemplate(template, full)) into.add(id);
    }
  }

  private decide(keys: readonly string[]): string | null | undefined {
    const name = keys[0] ?? '';
    let exact = this.exactOf(keys);
    const candidates = new Set<string>();
    this.fitting(keys, candidates);
    let duplicate = this.duplicated.has(name);

    if (exact === undefined) {
      // Not a title as written: it may be mutator's numbered copy of a name another test of the run has.
      const bases = keys.map(withoutDuplicateSuffix);

      if (bases.every((base) => base !== undefined)) {
        const viaBase = new Set<string>();
        exact = this.exactOf(bases);
        this.fitting(bases, viaBase);
        duplicate = exact !== undefined || viaBase.size > 0;

        for (const id of viaBase) candidates.add(id);
      }
    }

    if (exact === null) return null;

    if (exact !== undefined) candidates.add(exact);

    if (candidates.size === 0) return undefined;
    const hash = name.indexOf('#');
    const because = this.inexact.get(hash < 0 ? '' : name.slice(0, hash));
    let reason: WithheldReason | undefined;

    if (candidates.size > 1)
      reason =
        exact !== undefined
          ? { kind: 'exact_and_template' }
          : because !== undefined
            ? { kind: 'inexact_file', because }
            : { kind: 'templates' };
    else if (because !== undefined && (exact === undefined || duplicate))
      reason = { kind: 'inexact_file', because };

    if (reason === undefined) return [...candidates][0];
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
