import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { outOfMemory, runCommand, runContext } from '@under18dev/veritas-core';
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
  /**
   * Memory limit in MiB, defaulting to the run's `limits.memoryMb`: the JavaScript heap of the WebAssembly solver
   * process, or z3's own `-memory:` limit for the native binary.
   */
  memoryMb?: number;
  /** Test hook: the script the WebAssembly solver process runs (default: the bundled `wasm-worker`). */
  wasmScript?: string;
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

/** Below this the solver process cannot even start Z3. */
export const MIN_SOLVER_HEAP_MB = 256;

/** The solver process heap limit for a requested limit: never below `MIN_SOLVER_HEAP_MB`; undefined means no limit. */
export function solverHeapLimit(memoryMb: number | undefined): number | undefined {
  return memoryMb === undefined ? undefined : Math.max(MIN_SOLVER_HEAP_MB, Math.floor(memoryMb));
}

async function runWasm(smt: string, options: SolveOptions): Promise<SolverRun> {
  // Run next to this module; under tests this module is TypeScript, which Node 24+ runs natively.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const script = options.wasmScript ?? fileURLToPath(new URL(`./wasm-worker${ext}`, import.meta.url));
  // The solver process's JavaScript heap is capped at the run's memory limit (Z3's WebAssembly memory is separate
  // and bounded by the 32-bit address space); running out ends that process with an error, never a verdict.
  const memoryMb = solverHeapLimit(options.memoryMb ?? runContext()?.memoryMb);
  const result = await runCommand(
    process.execPath,
    [...(memoryMb ? [`--max-old-space-size=${memoryMb}`] : []), script],
    { cwd: process.cwd(), timeoutMs: options.timeoutMs, input: smt, signal: options.signal },
  );
  const base = {
    engine: 'z3-wasm' as const,
    engineVersion: 'unknown',
    model: {},
    reasonUnknown: null,
    output: '',
    durationMs: result.durationMs,
  };

  if (result.spawnError) return { ...base, verdict: 'error', error: result.spawnError };

  if (result.timedOut)
    return { ...base, verdict: 'timeout', error: `wall-clock limit of ${options.timeoutMs} ms exceeded` };

  if (options.signal?.aborted) return { ...base, verdict: 'cancelled', error: 'cancelled' };

  const line = result.stdout.trim().split('\n').pop() ?? '';
  let message: { ok?: boolean; output?: string; version?: string; error?: string } | undefined;

  try {
    message = JSON.parse(line);
  } catch {
    message = undefined;
  }

  if (!message || result.exitCode !== 0) {
    const reason = outOfMemory(result.stderr)
      ? `solver ran out of memory (limit ${memoryMb} MiB, limits.memoryMb)`
      : `solver process ended with ${result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`}${message?.error ? `: ${message.error}` : ''}`;

    return { ...base, verdict: 'error', error: reason };
  }

  if (!message.ok) return { ...base, verdict: 'error', error: message.error ?? 'solver failed' };
  const output = message.output ?? '';

  return { ...base, ...interpretOutput(output), engineVersion: message.version ?? 'unknown', output };
}

/** Arguments of the native z3 binary: SMT-LIB on stdin, and z3's own memory limit (MiB) when one is set. */
export function nativeZ3Args(memoryMb: number | undefined): string[] {
  return ['-in', '-smt2', ...(memoryMb ? [`-memory:${Math.floor(memoryMb)}`] : [])];
}

async function runNative(smt: string, options: SolveOptions): Promise<SolverRun> {
  const binary = options.nativeBinary ?? 'z3';
  const version = await runCommand(binary, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
  const engineVersion = version.exitCode === 0 ? version.stdout.trim() : 'unknown';
  const result = await runCommand(binary, nativeZ3Args(options.memoryMb ?? runContext()?.memoryMb), {
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
