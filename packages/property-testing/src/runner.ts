// Executed in a child Node.js process under the permission model (one process per property).
// Reads a JSON job from stdin, imports fast-check, the IR interpreter and the bound modules, checks the
// property with fast-check and prints one marked JSON line. Must stay erasable TypeScript (type stripping).
import { pathToFileURL } from 'node:url';
import type { Expr, FunctionModel, PropertyIR } from '@veritas/core';
import type * as FastCheck from 'fast-check';

type IRValue = bigint | boolean;
type Input = Record<string, number | boolean>;
type Encoded = { t: string; v?: string | boolean };
type Failure = { reason: string; javascript?: Encoded; expected?: string | boolean };
type Outcome =
  | { kind: 'ok' }
  | { kind: 'falsified'; failure: Failure }
  | { kind: 'model_error'; error: string };

interface Job {
  nonce: string;
  fastCheck: string;
  interpret: string;
  ir: PropertyIR;
  bindings: { modelName: string; modulePath: string; exportName: string }[];
  boundaries: Record<string, (string | boolean)[]>;
  seed: number;
  numRuns: number;
  path: string | null;
}

/** A bound JavaScript function produced a result that falsifies the property for this input. */
class Falsified extends Error {
  failure: Failure;
  constructor(failure: Failure) {
    super(failure.reason);
    this.failure = failure;
  }
}

const write = process.stdout.write.bind(process.stdout);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input) as Job;
const emit = (payload: Record<string, unknown>) =>
  write(`\n@@veritas-pbt:${job.nonce}@@${JSON.stringify(payload)}\n`);

function encode(value: unknown): Encoded {
  if (typeof value === 'number') return { t: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'bigint') return { t: 'bigint', v: value.toString() };
  if (value === undefined) return { t: 'undefined' };
  if (value === null) return { t: 'null' };
  return { t: 'other', v: Object.prototype.toString.call(value) };
}

const plain = (v: IRValue): string | boolean => (typeof v === 'bigint' ? v.toString() : v);

async function main(): Promise<void> {
  const fc = (await import(pathToFileURL(job.fastCheck).href)) as typeof FastCheck;
  const { evaluate, toLiteral } = (await import(pathToFileURL(job.interpret).href)) as {
    evaluate: (expr: Expr, env: Map<string, IRValue>, functions: Map<string, FunctionModel>) => IRValue;
    toLiteral: (v: IRValue) => Expr;
  };
  const { ir } = job;
  const table = new Map(ir.functions.map((f) => [f.name, f]));
  const bound = new Map<string, { model: FunctionModel; fn: (...args: unknown[]) => unknown }>();
  for (const binding of job.bindings) {
    const model = table.get(binding.modelName);
    if (!model) throw new Error(`binding ${binding.modelName} has no function model in the IR`);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(binding.modulePath).href)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`cannot import ${binding.modulePath}: ${describe(error)}`);
    }
    const fn = mod[binding.exportName];
    if (typeof fn !== 'function') throw new Error(`export ${binding.exportName} is not a function`);
    bound.set(binding.modelName, { model, fn: fn as (...args: unknown[]) => unknown });
  }

  // Subtrees without bound calls are evaluated by the formal-core interpreter unchanged.
  const usesJs = new Map<Expr, boolean>();
  const hasBound = (expr: Expr, depth = 0): boolean => {
    const cached = usesJs.get(expr);
    if (cached !== undefined) return cached;
    if (depth > 200) throw new Error('IR nesting too deep');
    let result = false;
    if (expr.kind === 'unary') result = hasBound(expr.arg, depth + 1);
    else if (expr.kind === 'binary')
      result = hasBound(expr.left, depth + 1) || hasBound(expr.right, depth + 1);
    else if (expr.kind === 'ite')
      result = [expr.cond, expr.whenTrue, expr.whenFalse].some((e) => hasBound(e, depth + 1));
    else if (expr.kind === 'call') {
      const body = table.get(expr.fn)?.body;
      result =
        bound.has(expr.fn) ||
        expr.args.some((a) => hasBound(a, depth + 1)) ||
        (body ? hasBound(body, depth + 1) : false);
    }
    usesJs.set(expr, result);
    return result;
  };

  // Most recent bound-call result and the last falsified comparison against one (for failure reports).
  const last: { js: Encoded | null; mismatch: Failure | null } = { js: null, mismatch: null };

  const callJs = (name: string, args: IRValue[]): IRValue => {
    const target = bound.get(name) as { model: FunctionModel; fn: (...args: unknown[]) => unknown };
    const jsArgs = args.map((a) => {
      if (typeof a === 'boolean') return a;
      const n = Number(a);
      if (!Number.isSafeInteger(n) || BigInt(n) !== a) {
        throw new Error(`argument ${a} to ${name} is outside the safe-integer range`);
      }
      return n;
    });
    let raw: unknown;
    try {
      raw = target.fn(...jsArgs);
    } catch (error) {
      throw new Falsified({ reason: 'threw', javascript: { t: 'throw', v: describe(error) } });
    }
    last.js = encode(raw);
    if (target.model.returns === 'bool') {
      if (typeof raw !== 'boolean')
        throw new Falsified({ reason: 'non_boolean_result', javascript: encode(raw) });
      return raw;
    }
    // -0 is a safe integer and compares equal to 0; it is read as 0 (documented in the result schema).
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
      throw new Falsified({ reason: 'non_integer_result', javascript: encode(raw) });
    }
    return BigInt(raw);
  };

  const run = (expr: Expr, env: Map<string, IRValue>): IRValue => {
    if (!hasBound(expr)) return evaluate(expr, env, table);
    switch (expr.kind) {
      case 'unary':
        return evaluate({ ...expr, arg: toLiteral(run(expr.arg, env)) }, env, table);
      case 'ite':
        return run(expr.cond, env) ? run(expr.whenTrue, env) : run(expr.whenFalse, env);
      case 'call': {
        const args = expr.args.map((a) => run(a, env));
        if (bound.has(expr.fn)) return callJs(expr.fn, args);
        const fn = table.get(expr.fn);
        if (!fn?.body) throw new Error(`opaque function ${expr.fn} cannot be evaluated`);
        return run(fn.body, new Map(fn.params.map((p, i) => [p.name, args[i] as IRValue])));
      }
      case 'binary': {
        if (expr.op === 'and') return Boolean(run(expr.left, env)) && Boolean(run(expr.right, env));
        if (expr.op === 'or') return Boolean(run(expr.left, env)) || Boolean(run(expr.right, env));
        if (expr.op === 'implies') return !run(expr.left, env) || Boolean(run(expr.right, env));
        const l = run(expr.left, env);
        const leftJs = expr.left.kind === 'call' && bound.has(expr.left.fn) ? last.js : null;
        const r = run(expr.right, env);
        const rightJs = expr.right.kind === 'call' && bound.has(expr.right.fn) ? last.js : null;
        const value = evaluate({ ...expr, left: toLiteral(l), right: toLiteral(r) }, env, table);
        if (value === false && leftJs) {
          last.mismatch = { reason: 'property_violated', javascript: leftJs, expected: plain(r) };
        } else if (value === false && rightJs) {
          last.mismatch = { reason: 'property_violated', javascript: rightJs, expected: plain(l) };
        }
        return value;
      }
      default:
        return evaluate(expr, env, table);
    }
  };

  const assess = (values: Input): Outcome => {
    const env = new Map<string, IRValue>(
      ir.params.map((p) => {
        const v = values[p.name] as number | boolean;
        return [p.name, p.sort === 'int' ? BigInt(v as number) : (v as boolean)];
      }),
    );
    try {
      for (const pre of ir.preconditions) if (!run(pre, env)) return { kind: 'ok' };
      last.mismatch = null;
      if (run(ir.body, env)) return { kind: 'ok' };
      return { kind: 'falsified', failure: last.mismatch ?? { reason: 'property_violated' } };
    } catch (error) {
      if (error instanceof Falsified) return { kind: 'falsified', failure: error.failure };
      return { kind: 'model_error', error: describe(error) };
    }
  };

  const preconditionHolds = (values: Input): boolean => {
    const env = new Map<string, IRValue>(
      ir.params.map((p) => {
        const v = values[p.name] as number | boolean;
        return [p.name, p.sort === 'int' ? BigInt(v as number) : (v as boolean)];
      }),
    );
    try {
      return ir.preconditions.every((pre) => Boolean(run(pre, env)));
    } catch {
      // Evaluated again (and reported) by assess().
      return true;
    }
  };

  const arbitraries: Record<string, FastCheck.Arbitrary<number | boolean>> = {};
  for (const p of ir.params) {
    if (p.sort === 'bool') {
      arbitraries[p.name] = fc.boolean();
      continue;
    }
    const base = fc.integer({ min: Number(p.domain.min), max: Number(p.domain.max) });
    const extras = (job.boundaries[p.name] ?? []).map(Number);
    arbitraries[p.name] = extras.length > 0 ? fc.oneof(base, fc.constantFrom(...extras)) : base;
  }

  const pre: (condition: boolean) => void = fc.pre;
  const observed = new Map<string, Outcome>();
  let original: Input | null = null;
  const property = fc.property(fc.record(arbitraries), (values) => {
    if (ir.preconditions.length > 0) pre(preconditionHolds(values));
    const outcome = assess(values);
    observed.set(JSON.stringify(values), outcome);
    if (outcome.kind === 'ok') return true;
    original ??= { ...values };
    return false;
  });
  const details = fc.check(property, {
    seed: job.seed,
    numRuns: job.numRuns,
    ...(job.path ? { path: job.path } : {}),
  });
  const shrunk = details.counterexample ? (details.counterexample[0] as Input) : null;
  const outcome = shrunk ? (observed.get(JSON.stringify(shrunk)) ?? assess(shrunk)) : null;
  const asStrings = (v: Input | null) =>
    v
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' ? String(x) : x]))
      : null;
  emit({
    ok: true,
    failed: details.failed,
    runsExecuted: details.numRuns,
    shrinks: details.numShrinks,
    path: details.counterexamplePath,
    counterexample: asStrings(shrunk),
    original: asStrings(original),
    failure: outcome?.kind === 'falsified' ? outcome.failure : null,
    modelError: outcome?.kind === 'model_error' ? outcome.error : null,
    error:
      details.failed && !shrunk
        ? details.errorInstance
          ? describe(details.errorInstance)
          : 'fast-check failed without a counterexample'
        : null,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${error.message}`;
  }
  return String(error);
}

try {
  await main();
} catch (error) {
  emit({ ok: false, error: describe(error) });
}
