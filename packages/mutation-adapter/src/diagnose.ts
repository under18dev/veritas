import { statSync } from 'node:fs';
import path from 'node:path';
import { resolveInsideRoot } from '@under18dev/veritas-core';

/** Terminal color and cursor sequences, which Vite and oxc print even into a pipe. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** A stack frame line. */
const STACK_FRAME = /^\s+at /;
/** Lines that usually say what went wrong, kept first when an output has to be shortened. */
const INFORMATIVE =
  /\[[A-Z][A-Z_]*\]|\b\w*Error\b|^\s*(Plugin|File):|\bin \S+\.[cm]?[jt]sx? at \d|^tests fail without mutants/;
/** `MUTATOR 123: /abs/a.test.ts: message`, what NODE_DEBUG=mutator prints for a test file that failed to load. */
const DEBUG_LINE = /^MUTATOR \d+: (.+?\.[cm]?[jt]sx?): (.*)$/;
/** Lines that continue the error message of a debug line, before its stack trace. */
const DEBUG_DETAIL = /^(\s|$|\[[A-Z][A-Z_]*\]|\S*Error\b|Plugin:|File:|-\s)/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * A bounded excerpt of an error output for a message: without colors, stack frames, blank and repeated lines.
 * When it is too long, the first line and the informative lines (`[PARSE_ERROR] …`, `Error: …`, `File: …`) are
 * kept, in their order, and the text is cut at the end: the head of an error says what it is.
 */
export function errorExcerpt(text: string, maxLines = 15, maxChars = 2000): string {
  const seen = new Set<string>();
  const lines = stripAnsi(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (line.trim() === '' || STACK_FRAME.test(line) || seen.has(line)) return false;
      seen.add(line);

      return true;
    });
  let kept = lines;

  if (lines.length > maxLines) {
    const picked = new Set<number>([0]);

    for (let i = 0; i < lines.length && picked.size < maxLines; i++)
      if (INFORMATIVE.test(lines[i] as string)) picked.add(i);

    for (let i = 0; i < lines.length && picked.size < maxLines; i++) picked.add(i);
    kept = [...picked].sort((a, b) => a - b).map((i) => lines[i] as string);
  }
  const excerpt = kept.length > 0 ? kept.join('\n') : stripAnsi(text).trim();

  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars)}…` : excerpt;
}

interface DebugBlock {
  file: string;
  message: string;
  /** The lines after the debug line up to its stack trace. */
  detail: string[];
}

/** Split stderr into mutator's own output and the debug blocks NODE_DEBUG=mutator interleaves with it. */
function splitDebug(stderr: string): { own: string; blocks: DebugBlock[] } {
  const own: string[] = [];
  const blocks: DebugBlock[] = [];
  let block: DebugBlock | null = null;
  let sawStack = false;

  for (const line of stripAnsi(stderr).split('\n')) {
    const debug = DEBUG_LINE.exec(line);

    if (debug || /^MUTATOR \d+: /.test(line)) {
      block = { file: debug?.[1] ?? '', message: debug?.[2] ?? line, detail: [] };
      blocks.push(block);
      sawStack = false;
      continue;
    }

    if (block) {
      if (STACK_FRAME.test(line)) {
        sawStack = true;
        continue;
      }

      if (!sawStack && DEBUG_DETAIL.test(line)) {
        block.detail.push(line);
        continue;
      }
      block = null;
    }
    own.push(line);
  }

  return { own: own.join('\n'), blocks };
}

/** mutator's own output, without the debug lines and the error messages and stack traces that follow them. */
export function withoutDebug(stderr: string): string {
  return splitDebug(stderr).own;
}

/**
 * What a failed baseline says: mutator's summary (which tests fail), then the first reason a test file failed to
 * load, which mutator prints only on its debug channel and which is usually the cause (`Cannot find module …`,
 * or a transform error with the file and position it names).
 */
export function baselineFailure(stderr: string, root: string): string {
  const { own, blocks } = splitDebug(stderr);
  const summary = errorExcerpt(own);
  const first = blocks.find((b) => b.file !== '');

  if (!first) return summary;
  // Project-relative with `/`, as the other paths in the detail.
  const file = (path.isAbsolute(first.file) ? path.relative(root, first.file) : first.file)
    .split(path.sep)
    .join('/');
  const message = first.message.length > 300 ? `${first.message.slice(0, 300)}…` : first.message;
  const detail = errorExcerpt(
    first.detail.filter((line) => line.trim() !== `Error: ${first.message}`.trim()).join('\n'),
    6,
    600,
  );

  return `${summary}\nfirst error: ${file}: ${message}${detail === '' ? '' : `\n${detail.replace(/^[ \t]*/gm, '  ')}`}`;
}

/** A transform or parse error from the bundler, as opposed to a failing assertion. */
const TRANSFORM_ERROR = /Transform failed|\[PARSE_ERROR\]|^\s*Plugin: \S+/m;
/** `in src/a.ts at 10..14`, the location oxc prints for a parse error (relative to the working directory). */
const PARSE_LOCATION = /^\s*-?\s*in (\S+?) at \d+\.\.\d+\s*$/gm;
/** `File: /abs/src/a.ts:12:3`, the file Vite names for an error raised by a plugin. */
const PLUGIN_FILE = /^\s*File: (.+?)\s*$/gm;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Characters that would make the path a wider glob when passed to mutator's `--exclude`. */
const GLOB_CHARS = /[*?[\]{}()!\\]/;

/**
 * True for a glob or path relative to the project root that cannot be read as a CLI option: what mutator's
 * `--include` and `--exclude` accept from Veritas.
 */
export function isRelativeGlob(glob: string): boolean {
  return (
    glob !== '' &&
    !glob.startsWith('-') &&
    !glob.includes('\0') &&
    !path.isAbsolute(glob) &&
    !/^[A-Za-z]:/.test(glob) &&
    !glob.split(/[\\/]/).includes('..')
  );
}

/** At most `max` items joined with commas, then how many more there are. */
export function listSome(items: readonly string[], max = 5): string {
  return items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ');
}

/**
 * Project source files that mutator's instrumented copy broke: the bundler failed to transform or parse them
 * (`[PARSE_ERROR] … in src/a.ts at 10..14`, or `Plugin: vite:oxc` with `File: <root>/src/a.ts`). Only existing,
 * non-test files inside the root that mutator would instrument (matching `include` and not `exclude`, when given)
 * are returned, project-relative with `/`. An ordinary test failure returns none.
 */
export function instrumentationFailures(
  stderr: string,
  root: string,
  options: {
    testInclude?: readonly string[];
    testFiles?: readonly string[];
    /** Source globs mutator instruments; files outside them were never instrumented. */
    include?: readonly string[];
    exclude?: readonly string[];
  } = {},
): string[] {
  const text = stripAnsi(stderr);

  if (!TRANSFORM_ERROR.test(text)) return [];
  const candidates = [...text.matchAll(PARSE_LOCATION)].map((m) => m[1] as string);

  if (/^\s*Plugin: \S+/m.test(text))
    candidates.push(...[...text.matchAll(PLUGIN_FILE)].map((m) => m[1] as string));
  const files = new Set<string>();
  const matches = (file: string, globs: readonly string[]) =>
    globs.some((glob) => path.posix.matchesGlob(file, glob));

  for (const candidate of candidates) {
    const file = candidate.replace(/\?.*$/, '').replace(/(:\d+){1,2}$/, '');
    const relative = (path.isAbsolute(file) ? path.relative(root, file) : path.normalize(file))
      .split(path.sep)
      .join('/');

    if (
      !isRelativeGlob(relative) ||
      GLOB_CHARS.test(relative) ||
      relative.split('/').includes('node_modules') ||
      TEST_FILE.test(relative) ||
      options.testFiles?.includes(relative) ||
      (options.testInclude !== undefined && matches(relative, options.testInclude)) ||
      (options.include !== undefined && !matches(relative, options.include)) ||
      (options.exclude !== undefined && matches(relative, options.exclude))
    )
      continue;

    try {
      if (statSync(resolveInsideRoot(root, relative)).isFile()) files.add(relative);
    } catch {
      // Missing, or a link leaving the root: never excluded.
    }
  }

  return [...files].sort();
}

/** The first parse or transform error line, such as `[PARSE_ERROR] HTML comments are not allowed in modules`. */
export function transformErrorLine(stderr: string): string {
  const text = stripAnsi(stderr);
  const line = /\[[A-Z][A-Z_]*\][^\n]*/.exec(text)?.[0] ?? /Transform failed[^\n]*/.exec(text)?.[0];
  const plugin = /^\s*Plugin: (\S+)/m.exec(text)?.[1];

  return [line?.trim(), plugin && `plugin ${plugin}`].filter(Boolean).join(', ') || 'transform error';
}

/** `dry run finished in 21.4s`: mutator ran the tests without mutants. */
const DRY_RUN_FINISHED = /^dry run finished in [\d.]+s/m;
/** `tests fail without mutants: ...`: the baseline failed, so no mutant is going to run. */
const BASELINE_FAILED = /^tests fail without mutants/m;
/**
 * `120 mutants, 100 to run (3 do not type-check)` and `estimated mutant execution: ~2m ...`: mutator printed its
 * plan, which comes after it type-checked the mutants (when it does) and before it runs the first one.
 */
const MUTANTS_PLANNED = /^(?:\d+ mutants, \d+ to run|estimated mutant execution:)/m;
/**
 * `[1538/12577] Killed   src/a.ts:3 ...`, printed when a mutant finishes, or `progress: 1538/12577, ...`, printed
 * every 15 seconds during a large run.
 */
const MUTANT_FINISHED = /^(?:\[\d+\/\d+\] |progress: \d+\/\d+)/m;
/** `time budget of 450s exhausted: 11039 mutants not run`. */
const BUDGET_EXHAUSTED = /^time budget of (\d+)s exhausted: (\d+) mutants not run/m;

/**
 * How far a mutation run got, read from mutator's progress output on stderr: whether the baseline (dry run)
 * finished or failed, whether mutator printed its plan of mutants to run (past type-checking them), and whether
 * any mutant had finished (or a progress line was printed).
 */
export function mutatorProgress(stderr: string): {
  pastBaseline: boolean;
  baselineFailed: boolean;
  mutantsPlanned: boolean;
  mutantFinished: boolean;
} {
  const text = withoutDebug(stderr);

  return {
    pastBaseline: DRY_RUN_FINISHED.test(text),
    baselineFailed: BASELINE_FAILED.test(text),
    mutantsPlanned: MUTANTS_PLANNED.test(text),
    mutantFinished: MUTANT_FINISHED.test(text),
  };
}

/** The time budget and the number of mutants mutator did not run when its `--time-budget` ran out, or null. */
export function timeBudgetExhausted(stderr: string): { seconds: number; notRun: number } | null {
  const match = BUDGET_EXHAUSTED.exec(withoutDebug(stderr));

  return match ? { seconds: Number(match[1]), notRun: Number(match[2]) } : null;
}

/** `dry run: 3/12 test files, 40 source files`: of the 12 test files the runner config selects, 3 ran now. */
const DRY_RUN_FILES = /^dry run: \d+\/(\d+) test files/m;

/**
 * How many test files the test runner config selected, from mutator's progress line, or null when it printed none.
 * The report cannot tell: it lists only the tests that covered or killed a mutant.
 */
export function selectedTestFileCount(stderr: string): number | null {
  const match = DRY_RUN_FILES.exec(withoutDebug(stderr));

  return match ? Number(match[1]) : null;
}
