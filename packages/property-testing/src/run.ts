import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Expr,
  PropertyIR,
  type RunStore,
  resolveInsideRoot,
  runCommand,
  sandboxRefusal,
  sandboxRuntime,
  stableId,
} from '@under18dev/veritas-core';
import { type Binding, differentialInputs } from '@under18dev/veritas-formal-core';
import { type PbtFailure, type PbtInput, PbtResult, type PbtStatus, type PbtTrust } from './schema.js';

export interface RunPropertyTestOptions {
  root: string;
  propertyId: string;
  ir: PropertyIR;
  bindings: Binding[];
  /** fast-check seed (32-bit integer). A random one is chosen and recorded when omitted. */
  seed?: number;
  numRuns: number;
  timeoutMs: number;
  /** Set for properties derived from inferred (not accepted) specifications. */
  experimental: boolean;
  store?: RunStore;
  signal?: AbortSignal;
  /** Run project code even where network access cannot be blocked (sandbox.allowNetworkWithoutIsolation). */
  allowNetworkWithoutIsolation?: boolean;
}

export interface ReplayOptions {
  root: string;
  ir: PropertyIR;
  bindings: Binding[];
  timeoutMs: number;
  signal?: AbortSignal;
}

const SAFE = 9007199254740991n;
const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, `runner${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`);

/** Locate an installed package by walking up `node_modules` directories (Node resolution order). */
function findPackage(name: string, from: string): { link: string; real: string } | null {
  let dir = from;
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json')))
        return { link: candidate, real: realpathSync(candidate) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface Toolchain {
  fastCheckEntry: string;
  interpret: string;
  readPaths: string[];
}

let toolchain: Toolchain | undefined;

/** fast-check (and its dependencies) and the formal-core interpreter, as files the sandbox may read. */
function locateToolchain(): Toolchain {
  if (toolchain) return toolchain;
  const fastCheck = findPackage('fast-check', here);
  if (!fastCheck) throw new Error('fast-check is not installed next to @under18dev/veritas-property-testing');
  const manifest = JSON.parse(readFileSync(path.join(fastCheck.real, 'package.json'), 'utf8')) as {
    exports?: { '.'?: { import?: { default?: string } } };
    dependencies?: Record<string, string>;
  };
  const entry = manifest.exports?.['.']?.import?.default;
  if (!entry) throw new Error('cannot locate the fast-check ESM entry point');
  const readPaths = new Set<string>([fastCheck.real]);
  const pending = [fastCheck.real];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const deps = (
      JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies;
    for (const dep of Object.keys(deps ?? {})) {
      const found = findPackage(dep, dir);
      if (!found) throw new Error(`fast-check dependency ${dep} is not installed`);
      // Resolution stats the link path before following it to the real directory.
      readPaths.add(found.link);
      if (!readPaths.has(found.real)) {
        readPaths.add(found.real);
        pending.push(found.real);
      }
    }
  }
  const formalCore = findPackage('@under18dev/veritas-formal-core', here);
  const interpret = formalCore ? path.join(formalCore.real, 'dist', 'interpret.js') : null;
  if (!interpret || !existsSync(interpret)) {
    throw new Error(
      'cannot locate the @under18dev/veritas-formal-core interpreter (dist/interpret.js); build it first',
    );
  }
  toolchain = { fastCheckEntry: path.join(fastCheck.real, entry), interpret, readPaths: [...readPaths] };
  return toolchain;
}

function walk(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  if (expr.kind === 'unary') walk(expr.arg, visit);
  else if (expr.kind === 'binary') {
    walk(expr.left, visit);
    walk(expr.right, visit);
  } else if (expr.kind === 'ite') {
    walk(expr.cond, visit);
    walk(expr.whenTrue, visit);
    walk(expr.whenFalse, visit);
  } else if (expr.kind === 'call') for (const a of expr.args) walk(a, visit);
}

/** Problems that make the property impossible to run as stated; never silently worked around. */
function validate(ir: PropertyIR, bindings: Binding[]): string | null {
  for (const p of ir.params) {
    if (p.sort !== 'int') continue;
    const lo = BigInt(p.domain.min);
    const hi = BigInt(p.domain.max);
    if (lo < -SAFE || hi > SAFE) return `domain of ${p.name} leaves the safe-integer range`;
  }
  const functions = new Map(ir.functions.map((f) => [f.name, f]));
  const boundNames = new Set<string>();
  for (const b of bindings) {
    const model = functions.get(b.modelName);
    if (!model) return `binding ${b.modelName} has no function model in the IR`;
    if (boundNames.has(b.modelName)) return `model ${b.modelName} is bound twice`;
    boundNames.add(b.modelName);
  }
  const roots = [ir.body, ...ir.preconditions, ...ir.functions.flatMap((f) => (f.body ? [f.body] : []))];
  for (const root of roots) {
    let problem: string | null = null;
    walk(root, (e) => {
      if (problem || e.kind !== 'call') return;
      const fn = functions.get(e.fn);
      if (!fn) problem = `call to unknown function ${e.fn}`;
      else if (!fn.body && !boundNames.has(e.fn)) problem = `function ${e.fn} is opaque and not bound`;
      else if (fn.params.length !== e.args.length)
        problem = `call to ${e.fn} has the wrong number of arguments`;
    });
    if (problem) return problem;
  }
  return null;
}

/** Boundary values per integer parameter (domain ends, 0, ±1 and IR literals ±1), mixed into generation. */
export function boundaryValues(ir: PropertyIR): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of ir.params) {
    if (p.sort !== 'int') continue;
    const values = differentialInputs({ ...ir, params: [p] }, ir.functions, 256).map((i) => i[p.name]);
    out[p.name] = values.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

function relativeBindings(root: string, bindings: Binding[]) {
  return bindings.map((b) => ({
    modelName: b.modelName,
    module: path.relative(root, b.modulePath).split(path.sep).join('/'),
    exportName: b.exportName,
  }));
}

function pbtId(options: {
  root: string;
  propertyId: string;
  ir: PropertyIR;
  bindings: Binding[];
  seed: number;
  numRuns: number;
  experimental: boolean;
}): string {
  return stableId('PBT', {
    propertyId: options.propertyId,
    ir: options.ir,
    bindings: relativeBindings(options.root, options.bindings),
    seed: options.seed,
    numRuns: options.numRuns,
    experimental: options.experimental,
  });
}

function replayCommand(id: string, seed: number, replayPath: string | null): string {
  return `veritas test replay ${id} --seed ${seed}${replayPath ? ` --path ${replayPath}` : ''}`;
}

interface RunnerOutput {
  ok: boolean;
  error?: string | null;
  failed?: boolean;
  runsExecuted?: number;
  shrinks?: number;
  path?: string | null;
  counterexample?: PbtInput | null;
  original?: PbtInput | null;
  failure?: PbtFailure | null;
  modelError?: string | null;
}

/** Parse the runner's marked result line; anything else on stdout came from the code under test. */
function parseOutput(stdout: string, nonce: string): RunnerOutput | null {
  const marker = `@@veritas-pbt:${nonce}@@`;
  const line = stdout.split('\n').find((l) => l.startsWith(marker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(marker.length)) as RunnerOutput;
  } catch {
    return null;
  }
}

async function execute(
  options: RunPropertyTestOptions & { replayPath: string | null; reject?: string },
  seed: number,
): Promise<PbtResult> {
  const started = Date.now();
  const id = pbtId({ ...options, seed });
  const base = {
    id,
    propertyId: options.propertyId,
    seed,
    numRuns: options.numRuns,
    runsExecuted: null,
    counterexample: null,
    originalCounterexample: null,
    shrinks: 0,
    path: null,
    failure: null,
    domains: options.ir.params,
    experimental: options.experimental,
    replayCommand: replayCommand(id, seed, null),
    error: null,
  };
  const finish = (status: PbtStatus, fields: Partial<PbtResult> = {}): PbtResult => {
    const trust: PbtTrust =
      status === 'passed' ? 'empirically_supported' : status === 'counterexample' ? 'falsified' : 'unknown';
    const result = PbtResult.parse({
      ...base,
      ...fields,
      status,
      trust,
      durationMs: fields.durationMs ?? Date.now() - started,
    });
    options.store?.write(`pbt/${id}.json`, PbtResult, result);
    return result;
  };

  if (options.signal?.aborted) return finish('cancelled', { error: 'aborted before the run started' });
  const problem = options.reject ?? validate(options.ir, options.bindings);
  if (problem) return finish('error', { error: problem });

  let root: string;
  let bindings: Binding[];
  let tools: Toolchain;
  try {
    root = realpathSync(options.root);
    // Real paths: the permission model compares real locations (e.g. /var vs /private/var on macOS).
    bindings = options.bindings.map((b) => ({
      ...b,
      modulePath: realpathSync(resolveInsideRoot(root, b.modulePath)),
    }));
    tools = locateToolchain();
  } catch (error) {
    return finish('error', { error: (error as Error).message });
  }

  const sandbox = sandboxRuntime();
  const refusal = sandboxRefusal(sandbox, options.allowNetworkWithoutIsolation);
  if (refusal) return finish('error', { error: refusal });
  const nonce = randomBytes(16).toString('hex');
  const args = [
    '--permission',
    `--allow-fs-read=${root}`,
    `--allow-fs-read=${RUNNER}`,
    `--allow-fs-read=${tools.interpret}`,
    ...tools.readPaths.map((p) => `--allow-fs-read=${p}`),
    '--disallow-code-generation-from-strings',
    '--disable-warning=ExperimentalWarning',
    RUNNER,
  ];
  const result = await runCommand(sandbox.node, args, {
    cwd: root,
    timeoutMs: options.timeoutMs,
    input: JSON.stringify({
      nonce,
      fastCheck: tools.fastCheckEntry,
      interpret: tools.interpret,
      ir: options.ir,
      bindings,
      boundaries: boundaryValues(options.ir),
      seed,
      numRuns: options.numRuns,
      path: options.replayPath,
    }),
    signal: options.signal,
    envAllowlist: ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP'],
  });
  const durationMs = result.durationMs;
  if (options.signal?.aborted) return finish('cancelled', { durationMs, error: 'run was cancelled' });
  if (result.timedOut) {
    return finish('timeout', { durationMs, error: `property run exceeded ${options.timeoutMs} ms` });
  }
  if (result.spawnError) return finish('error', { durationMs, error: result.spawnError });
  const output = parseOutput(result.stdout, nonce);
  if (!output) {
    const detail = result.stderr.split('\n').find((l) => /Error/.test(l)) ?? result.stderr.slice(0, 500);
    return finish('error', {
      durationMs,
      error: `property runner failed (exit ${result.exitCode}): ${detail.trim()}`,
    });
  }
  if (!output.ok) return finish('error', { durationMs, error: output.error ?? 'property runner failed' });
  const runFields = {
    durationMs,
    runsExecuted: output.runsExecuted ?? null,
    shrinks: output.shrinks ?? 0,
  };
  if (!output.failed) return finish('passed', runFields);
  const failing = {
    ...runFields,
    counterexample: output.counterexample ?? null,
    originalCounterexample: output.original ?? null,
    path: output.path ?? null,
    replayCommand: replayCommand(id, seed, output.path ?? null),
  };
  if (output.error || !output.counterexample) {
    return finish('error', {
      ...failing,
      error: output.error ?? 'fast-check failed without a counterexample',
    });
  }
  if (output.modelError) {
    return finish('error', {
      ...failing,
      failure: { reason: 'model_error' },
      error: `the property IR could not be evaluated: ${output.modelError}`,
    });
  }
  return finish('counterexample', { ...failing, failure: output.failure ?? { reason: 'property_violated' } });
}

/**
 * Check a property with fast-check in a permission-model child process (read-only access to the project,
 * fast-check and the interpreter; no writes, child processes or code generation from strings).
 * A passing run is `empirically_supported` for the sampled inputs only; it is never a proof.
 */
export async function runPropertyTest(options: RunPropertyTestOptions): Promise<PbtResult> {
  const parsed = PropertyIR.safeParse(options.ir);
  if (!parsed.success) throw new TypeError(`invalid property IR: ${parsed.error.message}`);
  if (!Number.isInteger(options.numRuns) || options.numRuns < 1) {
    throw new TypeError('numRuns must be a positive integer');
  }
  if (
    options.seed !== undefined &&
    (!Number.isInteger(options.seed) || Math.abs(options.seed) > 0x7fffffff)
  ) {
    throw new TypeError('seed must be a 32-bit integer');
  }
  const seed = options.seed ?? randomInt(-0x7fffffff, 0x7fffffff);
  return execute({ ...options, replayPath: null }, seed);
}

/**
 * Re-run a recorded result with its seed, run count and replay path. The domains must match the record,
 * otherwise the replay is an `error` rather than a run of a different property.
 */
export async function replayPropertyTest(record: PbtResult, options: ReplayOptions): Promise<PbtResult> {
  const stored = PbtResult.parse(record);
  const parsed = PropertyIR.safeParse(options.ir);
  if (!parsed.success) throw new TypeError(`invalid property IR: ${parsed.error.message}`);
  const common = {
    root: options.root,
    propertyId: stored.propertyId,
    ir: options.ir,
    bindings: options.bindings,
    numRuns: stored.numRuns,
    timeoutMs: options.timeoutMs,
    experimental: stored.experimental,
    signal: options.signal,
  };
  const domainsDiffer = JSON.stringify(stored.domains) !== JSON.stringify(options.ir.params);
  return execute(
    {
      ...common,
      replayPath: stored.path,
      reject: domainsDiffer ? 'the IR parameter domains differ from the recorded run' : undefined,
    },
    stored.seed,
  );
}
