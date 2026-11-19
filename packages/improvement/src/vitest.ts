import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redact, runCommand } from '@veritas/core';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export type VitestRun =
  | {
      status: 'ok';
      /** `<relative file>::<full test name>` -> status. A file that fails to load is `<file>::(file)`. */
      tests: Map<string, TestStatus>;
      failures: string[];
      passed: number;
      failed: number;
    }
  | { status: 'error'; detail: string };

interface JsonReport {
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[];
  }[];
}

function short(text: string, max = 300): string {
  const one = redact(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/** Run the project's own Vitest once in `cwd` with the JSON reporter, without a shell. */
export async function runVitest(
  cwd: string,
  options: { timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<VitestRun> {
  const bin = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(bin)) return { status: 'error', detail: 'vitest is not installed in the project' };
  const outDir = path.join(cwd, '.veritas', 'improve');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `vitest-${options.label}.json`);
  const result = await runCommand(
    process.execPath,
    [bin, 'run', '--reporter=json', `--outputFile=${outFile}`],
    {
      cwd,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.spawnError) return { status: 'error', detail: `could not start vitest: ${result.spawnError}` };
  if (result.timedOut) return { status: 'error', detail: `vitest exceeded ${options.timeoutMs} ms` };
  if (options.signal?.aborted) return { status: 'error', detail: 'cancelled' };
  let report: JsonReport;
  try {
    report = JSON.parse(readFileSync(outFile, 'utf8')) as JsonReport;
  } catch {
    return {
      status: 'error',
      detail: `vitest wrote no JSON report (exit ${result.exitCode}): ${short(result.stderr || result.stdout)}`,
    };
  }
  const tests = new Map<string, TestStatus>();
  const failures: string[] = [];
  for (const file of report.testResults ?? []) {
    const rel = path
      .relative(cwd, file.name ?? '')
      .split(path.sep)
      .join('/');
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.status === 'failed') {
      tests.set(`${rel}::(file)`, 'failed');
      failures.push(`${rel}: ${short(file.message ?? 'failed to load')}`);
    }
    for (const a of assertions) {
      const key = `${rel}::${a.fullName ?? a.title ?? '?'}`;
      const status: TestStatus =
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
