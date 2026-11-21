import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  redact,
  runProjectTests,
  type TestRunOptions,
  type TestRunResult,
  type TestRunStatus,
} from '@under18dev/veritas-core';

/** The parts of Jest's `--json` report that are read. */
interface JsonReport {
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

function longPath(p: string): string {
  try {
    return realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function short(text: string, max = 300): string {
  const one = redact(text).replace(/\s+/g, ' ').trim();

  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/**
 * Read Jest's `--json` report: every test as `<file relative to cwd>::<full name>` (Jest's `fullName`, the ancestor
 * titles and the title joined with a space), and a file that failed without any test result as `<file>::(file)`.
 * Jest's `pending`, `todo`, `skipped`, `disabled` and `focused` count as skipped.
 */
export function parseJestReport(cwd: string, report: unknown): Extract<TestRunResult, { status: 'ok' }> {
  const tests = new Map<string, TestRunStatus>();
  const failures: string[] = [];
  // Compare real long paths: on Windows the temp directory may be an 8.3 short name while Jest reports the long form.
  const base = longPath(cwd);

  for (const file of (report as JsonReport | null)?.testResults ?? []) {
    const rel = path
      .relative(base, longPath(file.name ?? ''))
      .split(path.sep)
      .join('/');
    const assertions = file.assertionResults ?? [];

    if (assertions.length === 0 && file.status === 'failed') {
      tests.set(`${rel}::(file)`, 'failed');
      failures.push(`${rel}: ${short(file.message ?? 'failed to load')}`);
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
  const outDir = path.join(cwd, '.veritas', 'improve');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `jest-${options.label}.json`);
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

  return parseJestReport(cwd, report);
}
