import { realpathSync } from 'node:fs';
import {
  Mutant,
  type MutantStatus,
  redact,
  resolveInsideRoot,
  stableId,
  toPosixRelative,
  VeritasError,
} from '@veritas/core';
import { z } from 'zod';

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
 * Split a mutator test id (`<file>#<vitest fullName>`) into the parts test-inventory hashes.
 * Vitest joins suite names with ` > `, so a test or suite name that itself contains ` > ` is split too;
 * a multi-project prefix (`[name] `) is dropped.
 */
export function mutatorTestRef(name: string): { file: string; suitePath: string[]; name: string } {
  const hash = name.indexOf('#');
  const file = hash < 0 ? '' : name.slice(0, hash).replaceAll('\\', '/');
  const full = (hash < 0 ? name : name.slice(hash + 1)).replace(/^\[[^\]]*\] /, '');
  const parts = full.split(' > ');
  const testName = parts.pop() ?? '';
  return { file, suitePath: parts, name: testName };
}

/** The test id test-inventory assigns to the test behind a mutator test name. */
export function mutatorTestId(name: string): string {
  return stableId('T', mutatorTestRef(name));
}

export interface ImportOptions {
  root: string;
  source: ReportSource;
  /** Keys of mutants mutator flags as reachable only from a child process (agent report `childProcess`). */
  childProcessKeys?: ReadonlySet<string>;
}

/**
 * Normalize a mutation-testing-elements report into core mutants. Survivors stay `survived`:
 * equivalence is never inferred here.
 */
export function importMutationReport(json: unknown, options: ImportOptions): Mutant[] {
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
  const testRef = (id: string): string => {
    if (options.source === 'mutator') return mutatorTestId(id);
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
