import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { runCommand } from '@under18dev/veritas-core';
import { parseGetValue, parseSExprs, type SExpr } from './sexpr.js';

export type SolverEngine = 'z3-wasm' | 'z3-native';
export type SolverVerdict = 'sat' | 'unsat' | 'unknown' | 'timeout' | 'error' | 'cancelled';

export interface SolverRun {
  engine: SolverEngine;
  engineVersion: string;
  verdict: SolverVerdict;
  /** Assignment for `sat` results; empty otherwise. */
  model: Record<string, string | boolean>;
  reasonUnknown: string | null;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface SolveOptions {
  engine?: SolverEngine;
  /** Hard wall-clock limit. The SMT input should also carry a soft `:timeout`. */
  timeoutMs: number;
  signal?: AbortSignal;
  nativeBinary?: string;
}

/**
 * Interpret raw solver output strictly. Only a first line of exactly `sat`, `unsat` or `unknown` is accepted;
 * anything else is `error`. An `unknown` with reason `timeout`/`canceled` becomes `timeout`.
 */
export function interpretOutput(
  output: string,
): Pick<SolverRun, 'verdict' | 'model' | 'reasonUnknown' | 'error'> {
  let exprs: SExpr[];
  try {
    exprs = parseSExprs(output);
  } catch (error) {
    return {
      verdict: 'error',
      model: {},
      reasonUnknown: null,
      error: `unparsable solver output: ${(error as Error).message}`,
    };
  }
  const head = exprs[0];
  // `(get-value ...)` after unsat/unknown legitimately fails with "model is not available"; any other error is fatal.
  const solverError = exprs.find(
    (e) =>
      Array.isArray(e) &&
      e[0] === 'error' &&
      !(head !== 'sat' && typeof e[1] === 'string' && /model is not available/.test(e[1])),
  );
  if (head !== 'sat' && head !== 'unsat' && head !== 'unknown') {
    return {
      verdict: 'error',
      model: {},
      reasonUnknown: null,
      error: `unexpected solver output: ${output.slice(0, 300)}`,
    };
  }
  if (solverError) {
    return {
      verdict: 'error',
      model: {},
      reasonUnknown: null,
      error: `solver reported: ${JSON.stringify(solverError)}`,
    };
  }
  const reasonExpr = exprs.find((e) => Array.isArray(e) && e[0] === ':reason-unknown');
  const reasonUnknown =
    Array.isArray(reasonExpr) && typeof reasonExpr[1] === 'string'
      ? reasonExpr[1].replace(/^"|"$/g, '')
      : null;
  if (head === 'unknown') {
    const timedOut = reasonUnknown !== null && /timeout|canceled|cancelled|resource/i.test(reasonUnknown);
    return { verdict: timedOut ? 'timeout' : 'unknown', model: {}, reasonUnknown, error: null };
  }
  if (head === 'unsat') return { verdict: 'unsat', model: {}, reasonUnknown: null, error: null };
  const valueList = exprs.slice(1).find((e) => Array.isArray(e) && Array.isArray(e[0]));
  try {
    return {
      verdict: 'sat',
      model: valueList ? parseGetValue(valueList) : {},
      reasonUnknown: null,
      error: null,
    };
  } catch (error) {
    return {
      verdict: 'error',
      model: {},
      reasonUnknown: null,
      error: `cannot read model: ${(error as Error).message}`,
    };
  }
}

function runWasm(smt: string, options: SolveOptions): Promise<SolverRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Load the worker next to this module; under tests this module is TypeScript, which Node 24+ runs natively.
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./wasm-worker${ext}`, import.meta.url), { workerData: { smt } });
    let settled = false;
    const done = (run: Omit<SolverRun, 'engine' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      resolve({ engine: 'z3-wasm', durationMs: Date.now() - started, ...run });
    };
    const base = { engineVersion: 'unknown', model: {}, reasonUnknown: null, output: '' };
    const timer = setTimeout(
      () =>
        done({ ...base, verdict: 'timeout', error: `wall-clock limit of ${options.timeoutMs} ms exceeded` }),
      options.timeoutMs,
    );
    const onAbort = () => done({ ...base, verdict: 'cancelled', error: 'cancelled' });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: { ok: boolean; output?: string; version?: string; error?: string }) => {
      if (!msg.ok) return done({ ...base, verdict: 'error', error: msg.error ?? 'solver failed' });
      const output = msg.output ?? '';
      done({ ...interpretOutput(output), engineVersion: msg.version ?? 'unknown', output });
    });
    worker.once('error', (error: Error) => done({ ...base, verdict: 'error', error: error.message }));
    worker.once('exit', (code) =>
      done({ ...base, verdict: 'error', error: `solver worker exited with code ${code}` }),
    );
  });
}

async function runNative(smt: string, options: SolveOptions): Promise<SolverRun> {
  const binary = options.nativeBinary ?? 'z3';
  const version = await runCommand(binary, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
  const engineVersion = version.exitCode === 0 ? version.stdout.trim() : 'unknown';
  const result = await runCommand(binary, ['-in', '-smt2'], {
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs,
    input: smt,
    signal: options.signal,
  });
  const base = {
    engine: 'z3-native' as const,
    engineVersion,
    output: result.stdout,
    durationMs: result.durationMs,
  };
  if (result.spawnError)
    return { ...base, verdict: 'error', model: {}, reasonUnknown: null, error: result.spawnError };
  if (result.timedOut) {
    return {
      ...base,
      verdict: 'timeout',
      model: {},
      reasonUnknown: null,
      error: `wall-clock limit of ${options.timeoutMs} ms exceeded`,
    };
  }
  if (options.signal?.aborted)
    return { ...base, verdict: 'cancelled', model: {}, reasonUnknown: null, error: 'cancelled' };
  return { ...base, ...interpretOutput(result.stdout) };
}

/** Run an SMT-LIB 2 script through Z3. Never infers a verdict that the solver did not print. */
export function solveSmtLib(smt: string, options: SolveOptions): Promise<SolverRun> {
  return (options.engine ?? 'z3-wasm') === 'z3-native' ? runNative(smt, options) : runWasm(smt, options);
}

/** Version of the solver build `engine` would run, or null when it cannot be determined. */
export async function solverEngineVersion(
  engine: SolverEngine = 'z3-wasm',
  nativeBinary = 'z3',
): Promise<string | null> {
  if (engine === 'z3-wasm') {
    try {
      const pkg = createRequire(import.meta.url)('z3-solver/package.json') as { version?: string };
      return pkg.version ? `z3-solver ${pkg.version}` : null;
    } catch {
      return null;
    }
  }
  const version = await runCommand(nativeBinary, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
  return version.exitCode === 0 ? version.stdout.trim() || null : null;
}
