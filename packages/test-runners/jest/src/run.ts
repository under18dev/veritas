import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  redact,
  resolveInsideRoot,
  runProjectTests,
  type TestRunOptions,
  type TestRunResult,
  type TestRunStatus,
} from '@under18dev/veritas-core';

/** The parts of Jest's `--json` report that are read. */
interface JsonReport {
  success?: boolean;
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: {
      ancestorTitles?: string[];
      fullName?: string;
      title?: string;
      status?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/**
 * The real long form of a path, also for one that does not exist (yet): its nearest existing ancestor is resolved
 * and the rest appended. On Windows a temporary directory may be an 8.3 short name (RUNNER~1) while Jest reports the
 * long form, and comparing the two would make every relative path wrong.
 */
export function longPath(p: string): string {
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

/** `file` relative to `base` with `/` separators, as results are keyed on every platform. */
export function relativeKey(base: string, file: string): string {
  return path.relative(longPath(base), longPath(file)).split(path.sep).join('/');
}

function short(text: string, max = 300): string {
  const one = redact(text).replace(/\s+/g, ' ').trim();

  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/**
 * Read Jest's `--json` report: every test as `<file relative to cwd>::<full name>` (POSIX separators; Jest's
 * `fullName`, the ancestor titles and the title joined with a space). A file Jest marks failed beyond its tests (it
 * did not load, or a hook such as `afterAll` threw while every test passed) is `<file>::(file)`, failed. A report
 * that says the run did not succeed without naming a failure gets `(run)::(report)`, failed. Jest's `pending`,
 * `todo`, `skipped`, `disabled` and `focused` count as skipped.
 */
export function parseJestReport(cwd: string, report: unknown): Extract<TestRunResult, { status: 'ok' }> {
  const tests = new Map<string, TestRunStatus>();
  const failures: string[] = [];
  const parsed = report as JsonReport | null;

  for (const file of parsed?.testResults ?? []) {
    const rel = relativeKey(cwd, file.name ?? '');
    const assertions = file.assertionResults ?? [];
    const testFailed = assertions.some((a) => a.status === 'failed');

    // A failed file without a failed test failed outside its tests: it did not load, or a hook threw.
    if (file.status === 'failed' && !testFailed) {
      tests.set(`${rel}::(file)`, 'failed');
      failures.push(
        `${rel}: ${short(file.message || (assertions.length === 0 ? 'failed to load' : 'failed outside its tests'))}`,
      );
    }

    for (const a of assertions) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? '?'].join(' ');
      const key = `${rel}::${name}`;
      const status: TestRunStatus =
        a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      tests.set(key, status);

      if (status === 'failed') failures.push(`${key}: ${short(a.failureMessages?.[0] ?? 'failed')}`);
    }
  }
  const explained = [...tests.values()].includes('failed');

  if (parsed?.success === false && !explained) {
    tests.set('(run)::(report)', 'failed');
    failures.push('(run): Jest reported the run as not successful without naming a failing test or file');
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

/**
 * Run the project's own Jest once in `cwd` with `--json`, without a shell. Jest is started the way @mizchi/mutator
 * starts it, under `node --experimental-vm-modules`, so native ESM projects load; CommonJS projects run as usual.
 */
export async function runJest(cwd: string, options: TestRunOptions): Promise<TestRunResult> {
  const bin = path.join(cwd, 'node_modules', 'jest', 'bin', 'jest.js');

  if (!existsSync(bin)) return { status: 'error', detail: 'jest is not installed in the project' };
  // File filters are paths (--runTestsByPath): one that reads as an option or leaves the directory is refused.
  const unsafe = options.files?.find(
    (f) => f === '' || f.startsWith('-') || path.isAbsolute(f) || f.includes('..'),
  );

  if (unsafe !== undefined)
    return { status: 'error', detail: `invalid test file: ${JSON.stringify(unsafe)}` };
  const outName = path.join('.veritas', 'improve', `jest-${options.label}.json`);
  let outFile: string;

  // Inside the project for real: in an isolated copy, code under test may have replaced `.veritas` with a link.
  try {
    outFile = resolveInsideRoot(cwd, outName);
    mkdirSync(path.dirname(outFile), { recursive: true });
    resolveInsideRoot(cwd, outName);
  } catch (error) {
    return {
      status: 'error',
      detail: `cannot write the jest report inside the project: ${(error as Error).message}`,
    };
  }
  // A report left by an earlier run with the same label must not be read as this run's.
  rmSync(outFile, { force: true });
  const result = await runProjectTests(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      bin,
      '--ci',
      '--json',
      `--outputFile=${outFile}`,
      '--watchman=false',
      ...(options.files?.length ? ['--runTestsByPath', ...options.files] : []),
    ],
    {
      label: 'jest',
      cwd,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (result.spawnError) return { status: 'error', detail: `could not start jest: ${result.spawnError}` };

  if (result.timedOut) return { status: 'error', detail: `jest exceeded ${options.timeoutMs} ms` };

  if (options.signal?.aborted) return { status: 'error', detail: 'cancelled' };
  let report: unknown;

  try {
    report = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return {
      status: 'error',
      detail: `jest wrote no JSON report (exit ${result.exitCode}): ${short(result.stderr || result.stdout)}`,
    };
  }

  const parsed = parseJestReport(cwd, report);

  // A nonzero exit is a failed run even when the report names no failure (an open handle, a crash after it was
  // written): it is never read as all passing.
  if (result.exitCode !== 0 && parsed.failed === 0) {
    parsed.tests.set('(run)::(exit)', 'failed');
    parsed.failures.push(
      `(run): jest exited with ${result.exitCode ?? `signal ${result.signal}`} although its report names no failure: ${short(result.stderr || result.stdout)}`,
    );
    parsed.failed += 1;
  }

  return parsed;
}
