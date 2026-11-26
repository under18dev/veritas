import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  redact,
  resolveInsideRoot,
  runProjectTests,
  type TestRunOptions,
  type TestRunResult,
  type TestRunStatus,
} from '@under18dev/veritas-core';
import type { NodeTestReport } from './reporter.js';

/** What a test's full name joins the titles of its suites (and parent tests) and its own title with. */
export const NODE_TEST_SEPARATOR = ' > ';

/**
 * The reporter module Node.js loads: the compiled `reporter.js` next to this file, or, when this file runs from
 * source (the package's own tests), `reporter.ts`, which Node.js runs by stripping its types.
 */
export function reporterPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'reporter.js');

  return existsSync(compiled) ? compiled : path.join(here, 'reporter.ts');
}

/**
 * The real long form of a path, also for one that does not exist (yet): its nearest existing ancestor is resolved
 * and the rest appended (on Windows a temporary directory may be an 8.3 short name while Node.js reports the long
 * form).
 */
function longPath(p: string): string {
  const resolved = path.resolve(p);
  const rest: string[] = [];

  for (let current = resolved; ; ) {
    try {
      return path.join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);

      if (parent === current) return resolved;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function relativeKey(base: string, file: string): string {
  return path.relative(longPath(base), longPath(file)).split(path.sep).join('/');
}

function short(text: string, max = 300): string {
  const one = redact(text).replace(/\s+/g, ' ').trim();

  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/**
 * Read the report of `reporter.ts`: every test as `<file relative to cwd>::<full name>` (POSIX separators; the titles
 * of its suites and parent tests and its own title joined with ` > `), subtests (`t.test`) included under their
 * parent test. Skipped and todo tests count as skipped. A suite that passed is not a test and is left out; one that
 * failed by itself (its callback or a hook threw), not only through a failed test in it, is recorded as failed under
 * its own name. A file that failed outside any test (it did not load, or its process exited with an error) is
 * `<file>::(file)`, failed. A run reported as not successful without naming a failure is `(run)::(report)`, failed.
 */
export function parseNodeTestReport(cwd: string, report: unknown): Extract<TestRunResult, { status: 'ok' }> {
  const tests = new Map<string, TestRunStatus>();
  const failures: string[] = [];
  const parsed = report as Partial<NodeTestReport> | null;

  for (const entry of parsed?.tests ?? []) {
    const rel = entry.file ? relativeKey(cwd, entry.file) : '(unknown file)';
    const failed = entry.status === 'failed';

    if (entry.type === 'suite' && (!failed || entry.failureType === 'subtestsFailed')) continue;
    // Node.js reports a file that fails outside its tests as a top-level test named after the file.
    const fileLevel =
      entry.ancestors.length === 0 &&
      entry.file !== null &&
      (entry.name === rel || longPath(path.resolve(cwd, entry.name)) === longPath(entry.file));
    const key = fileLevel
      ? `${rel}::(file)`
      : `${rel}::${[...entry.ancestors, entry.name].join(NODE_TEST_SEPARATOR)}`;
    const status: TestRunStatus = failed ? 'failed' : entry.status === 'passed' ? 'passed' : 'skipped';

    // A test whose subtest failed fails too; it keeps the first failure, a later entry with its name (a test
    // registered twice) cannot turn it into a pass.
    if (tests.get(key) === 'failed') continue;
    tests.set(key, status);

    if (failed)
      failures.push(
        `${key}: ${short(entry.message ?? (fileLevel ? 'failed outside its tests' : (entry.failureType ?? 'failed')))}`,
      );
  }
  const explained = [...tests.values()].includes('failed');

  if (parsed?.success === false && !explained) {
    tests.set('(run)::(report)', 'failed');
    failures.push(
      '(run): node --test reported the run as not successful without naming a failing test or file',
    );
  }
  const values = [...tests.values()];

  return {
    status: 'ok',
    tests,
    failures,
    passed: values.filter((s) => s === 'passed').length,
    failed: values.filter((s) => s === 'failed').length,
  };
}

/** Characters `node --test` reads as a glob pattern in a file argument. */
const GLOB = /[*?[\]{}!]/;

/**
 * Run the project's tests once in `cwd` with Node's built-in test runner (`node --test`, this very Node.js), without a
 * shell, and read the report the reporter of this package writes. Without `files`, Node's default patterns select the
 * test files, from `cwd`.
 */
export async function runNodeTest(cwd: string, options: TestRunOptions): Promise<TestRunResult> {
  // File filters are positional arguments that Node.js reads as glob patterns: one that reads as an option, leaves
  // the directory or holds a pattern character is refused.
  const unsafe = options.files?.find(
    (f) => f === '' || f.startsWith('-') || path.isAbsolute(f) || f.includes('..') || GLOB.test(f),
  );

  if (unsafe !== undefined)
    return { status: 'error', detail: `invalid test file: ${JSON.stringify(unsafe)}` };
  const outName = path.join('.veritas', 'improve', `node-test-${options.label}.json`);
  let outFile: string;

  // Inside the project for real: in an isolated copy, code under test may have replaced `.veritas` with a link.
  try {
    outFile = resolveInsideRoot(cwd, outName);
    mkdirSync(path.dirname(outFile), { recursive: true });
    resolveInsideRoot(cwd, outName);
  } catch (error) {
    return {
      status: 'error',
      detail: `cannot write the node --test report inside the project: ${(error as Error).message}`,
    };
  }
  // A report left by an earlier run with the same label must not be read as this run's.
  rmSync(outFile, { force: true });
  const result = await runProjectTests(
    process.execPath,
    [
      '--test',
      `--test-reporter=${pathToFileURL(reporterPath()).href}`,
      `--test-reporter-destination=${outFile}`,
      ...(options.files ?? []),
    ],
    {
      label: 'node --test',
      cwd,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (result.spawnError)
    return { status: 'error', detail: `could not start node --test: ${result.spawnError}` };

  if (result.timedOut) return { status: 'error', detail: `node --test exceeded ${options.timeoutMs} ms` };

  if (options.signal?.aborted) return { status: 'error', detail: 'cancelled' };
  let report: unknown;

  try {
    report = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return {
      status: 'error',
      detail: `node --test wrote no report (exit ${result.exitCode}): ${short(result.stderr || result.stdout)}`,
    };
  }
  const parsed = parseNodeTestReport(cwd, report);

  // A nonzero exit is a failed run even when the report names no failure: it is never read as all passing.
  if (result.exitCode !== 0 && parsed.failed === 0) {
    parsed.tests.set('(run)::(exit)', 'failed');
    parsed.failures.push(
      `(run): node --test exited with ${result.exitCode ?? `signal ${result.signal}`} although its report names no failure: ${short(result.stderr || result.stdout)}`,
    );
    parsed.failed += 1;
  }

  return parsed;
}
