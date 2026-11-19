import {
  type ClaimKind,
  callInSandbox,
  type EncodedValue,
  type Expr,
  type FormalClaim,
  type FunctionModel,
  type PropertyIR,
  type RunStore,
  stableId,
  type VerificationStatus,
} from '@veritas/core';
import {
  conformanceQuery,
  type SolverEngine,
  type SolverRun,
  safeRangeQuery,
  solveSmtLib,
} from '@veritas/solver-z3';
import { z } from 'zod';
import { callModel, type IRValue } from './interpret.js';

/** Connects an IR function model to the real JavaScript export it models, so results can be replayed. */
export interface Binding {
  modelName: string;
  /** Absolute path of the module inside the project root. */
  modulePath: string;
  exportName: string;
}

export interface ProveOptions {
  kind: ClaimKind;
  propertyId: string;
  ir: PropertyIR;
  root: string;
  bindings: Binding[];
  timeoutMs: number;
  engine?: SolverEngine;
  store?: RunStore;
  signal?: AbortSignal;
  mutantId?: string;
  /** Extra assumptions recorded on the claim, e.g. which specification reading was formalized. */
  assumptions?: string[];
}

export interface ProveResult {
  claim: FormalClaim;
  solver: SolverRun;
  replay: ReplayRecord[];
}

export interface ReplayRecord {
  purpose: 'counterexample' | 'differential';
  input: Record<string, string | boolean>;
  modelName: string;
  model: string | boolean | null;
  javascript: EncodedValue | null;
  agrees: boolean | null;
  note?: string;
}

export const BASE_ASSUMPTIONS = [
  'integers are mathematical integers restricted to the stated domains',
  'functions are pure and terminate',
  'the IR models the TypeScript source of each bound function; agreement is checked by replay, not proven',
];

export const SEMANTIC_GAPS = [
  'JavaScript numbers are IEEE-754 doubles; agreement with the integer model holds only while every intermediate value is a safe integer',
  'inputs outside the stated domains, non-integer numbers, NaN, Infinity and -0 are not covered',
];

function encodeInput(value: string | boolean): EncodedValue {
  return typeof value === 'boolean' ? { t: 'boolean', v: value } : { t: 'number', v: value };
}

function irValue(value: string | boolean): IRValue {
  return typeof value === 'boolean' ? value : BigInt(value);
}

function sameValue(model: IRValue, js: EncodedValue): boolean {
  if (typeof model === 'boolean') return js.t === 'boolean' && js.v === model;
  return js.t === 'number' && js.v === model.toString();
}

/** Replay inputs through the IR interpreter and the real export in the sandbox, per binding. */
async function replay(
  purpose: ReplayRecord['purpose'],
  inputs: Record<string, string | boolean>[],
  options: ProveOptions,
): Promise<ReplayRecord[]> {
  const records: ReplayRecord[] = [];
  const functions = options.ir.functions;
  for (const binding of options.bindings) {
    const model = functions.find((f) => f.name === binding.modelName);
    if (!model?.body) continue;
    const argLists = inputs.map((input) => model.params.map((p) => input[p.name] ?? null));
    const runnable = argLists.filter((args) => args.every((a) => a !== null)) as (string | boolean)[][];
    if (runnable.length === 0) continue;
    const sandbox = await callInSandbox({
      root: options.root,
      modulePath: binding.modulePath,
      exportName: binding.exportName,
      calls: runnable.map((args) => args.map(encodeInput)),
      timeoutMs: Math.max(5_000, options.timeoutMs),
      signal: options.signal,
    });
    runnable.forEach((args, i) => {
      const input = Object.fromEntries(model.params.map((p, j) => [p.name, args[j] as string | boolean]));
      let modelValue: IRValue | null = null;
      try {
        modelValue = callModel(model, args.map(irValue), functions);
      } catch {
        modelValue = null;
      }
      const js = sandbox.status === 'ok' ? (sandbox.results[i] ?? null) : null;
      records.push({
        purpose,
        input,
        modelName: model.name,
        model:
          modelValue === null ? null : typeof modelValue === 'bigint' ? modelValue.toString() : modelValue,
        javascript: js,
        agrees: js === null || modelValue === null ? null : sameValue(modelValue, js),
        ...(sandbox.status !== 'ok' ? { note: `sandbox ${sandbox.status}: ${sandbox.error}` } : {}),
      });
    });
  }
  return records;
}

function collectLiterals(expr: Expr, out: Set<bigint>): void {
  if (expr.kind === 'int') out.add(BigInt(expr.value));
  else if (expr.kind === 'unary') collectLiterals(expr.arg, out);
  else if (expr.kind === 'binary') {
    collectLiterals(expr.left, out);
    collectLiterals(expr.right, out);
  } else if (expr.kind === 'ite') {
    collectLiterals(expr.cond, out);
    collectLiterals(expr.whenTrue, out);
    collectLiterals(expr.whenFalse, out);
  } else if (expr.kind === 'call') expr.args.forEach((a) => collectLiterals(a, out));
}

/** Boundary samples per parameter: domain ends, 0, ±1 and every literal ±1, clipped to the domain. */
export function differentialInputs(
  ir: PropertyIR,
  functions: FunctionModel[] = ir.functions,
  max = 64,
): Record<string, string | boolean>[] {
  const literals = new Set<bigint>([0n, 1n, -1n]);
  for (const f of functions) if (f.body) collectLiterals(f.body, literals);
  collectLiterals(ir.body, literals);
  const perParam = ir.params.map((p) => {
    if (p.sort === 'bool') return [true, false];
    const lo = BigInt(p.domain.min);
    const hi = BigInt(p.domain.max);
    const values = new Set<bigint>([lo, hi]);
    for (const l of literals) for (const d of [-1n, 0n, 1n]) values.add(l + d);
    return [...values]
      .filter((v) => v >= lo && v <= hi)
      .sort((a, b) => (a < b ? -1 : 1))
      .map((v) => v.toString());
  });
  const out: Record<string, string | boolean>[] = [];
  const build = (i: number, acc: Record<string, string | boolean>) => {
    if (out.length >= max) return;
    if (i === ir.params.length) {
      out.push({ ...acc });
      return;
    }
    for (const v of perParam[i] ?? []) build(i + 1, { ...acc, [(ir.params[i] as { name: string }).name]: v });
  };
  build(0, {});
  return out;
}

const VERDICT_STATUS: Record<SolverRun['verdict'], VerificationStatus> = {
  sat: 'counterexample_found',
  unsat: 'proven_within_model',
  unknown: 'unknown',
  timeout: 'timeout',
  error: 'error',
  cancelled: 'unknown',
};

/**
 * Check `forall params in domain: preconditions => body` with Z3 and validate the result against JavaScript.
 * - sat: the counterexample is replayed; disagreement between model and JavaScript gives `semantic_mismatch`.
 * - unsat: valid only within the model; the safe-integer obligation and a differential replay must pass,
 *   otherwise `semantic_mismatch` (or `unknown` if the obligation itself is undecided).
 */
export async function proveProperty(options: ProveOptions): Promise<ProveResult> {
  const claimId = stableId('C', {
    kind: options.kind,
    propertyId: options.propertyId,
    ir: options.ir,
    mutant: options.mutantId,
  });
  const smt = conformanceQuery(options.ir, options.timeoutMs);
  const solver = await solveSmtLib(smt, {
    timeoutMs: options.timeoutMs * 2 + 5_000,
    engine: options.engine,
    signal: options.signal,
  });
  const inputArtifact = options.store?.writeText(`proofs/${claimId}.smt2`, smt);
  const outputArtifact = options.store?.writeText(
    `proofs/${claimId}.out`,
    `; engine ${solver.engine} ${solver.engineVersion}; verdict ${solver.verdict}; ${solver.durationMs} ms\n${solver.output}${solver.error ? `\n; error: ${solver.error}\n` : ''}`,
  );

  let status = VERDICT_STATUS[solver.verdict];
  let semanticValidation: FormalClaim['semanticValidation'] = 'not_attempted';
  const assumptions = [...BASE_ASSUMPTIONS, ...(options.assumptions ?? [])];
  const semanticGaps = [...SEMANTIC_GAPS];
  if (solver.verdict === 'cancelled') assumptions.push('solver run was cancelled');
  const replays: ReplayRecord[] = [];

  if (solver.verdict === 'sat') {
    replays.push(...(await replay('counterexample', [solver.model], options)));
    const checked = replays.filter((r) => r.agrees !== null);
    if (replays.some((r) => r.agrees === false)) {
      status = 'semantic_mismatch';
      semanticValidation = 'mismatch';
    } else if (checked.length > 0) {
      semanticValidation = 'confirmed';
    }
  }

  if (solver.verdict === 'unsat') {
    const rangeSmt = safeRangeQuery(options.ir, options.timeoutMs);
    if (rangeSmt) {
      const range = await solveSmtLib(rangeSmt, {
        timeoutMs: options.timeoutMs * 2 + 5_000,
        engine: options.engine,
        signal: options.signal,
      });
      options.store?.writeText(`proofs/${claimId}.safe-range.smt2`, rangeSmt);
      options.store?.writeText(
        `proofs/${claimId}.safe-range.out`,
        `; verdict ${range.verdict}\n${range.output}`,
      );
      if (range.verdict === 'sat') {
        status = 'semantic_mismatch';
        semanticGaps.push(
          `an intermediate value leaves the safe-integer range for input ${JSON.stringify(range.model)}`,
        );
      } else if (range.verdict !== 'unsat') {
        status = 'unknown';
        semanticGaps.push(`the safe-integer obligation was not decided (${range.verdict})`);
      } else {
        assumptions.push('every intermediate integer stays in the safe-integer range (checked by solver)');
      }
    }
    if (status === 'proven_within_model') {
      replays.push(...(await replay('differential', differentialInputs(options.ir), options)));
      const checked = replays.filter((r) => r.agrees !== null);
      if (replays.some((r) => r.agrees === false)) {
        status = 'semantic_mismatch';
        semanticValidation = 'mismatch';
      } else if (checked.length > 0) {
        semanticValidation = 'confirmed';
        assumptions.push(
          `model and JavaScript agree on ${checked.length} boundary input(s) (sampled, not proven)`,
        );
      }
    }
  }

  const counterexample =
    status === 'counterexample_found' || (status === 'semantic_mismatch' && solver.verdict === 'sat')
      ? solver.model
      : undefined;
  const claim: FormalClaim = {
    id: claimId,
    propertyId: options.propertyId,
    kind: options.kind,
    status,
    engine: solver.engine,
    engineVersion: solver.engineVersion,
    assurance: status === 'proven_within_model' ? 'smt_bounded' : 'none',
    modelId: stableId('M', options.ir.functions),
    assumptions,
    scope: {
      params: options.ir.params,
      preconditions: options.ir.preconditions,
      statement: 'forall params within their domains: preconditions imply body',
    },
    semanticGaps,
    ...(inputArtifact ? { solverInputArtifact: inputArtifact } : {}),
    ...(outputArtifact ? { solverOutputArtifact: outputArtifact } : {}),
    ...(counterexample ? { counterexample } : {}),
    reproduction: inputArtifact
      ? `z3 -smt2 ${inputArtifact}`
      : 'rerun with an artifact store to save the solver input',
    semanticValidation,
    durationMs: solver.durationMs,
    ...(options.mutantId ? { mutantId: options.mutantId } : {}),
  };
  if (options.store) options.store.write(`proofs/${claimId}.replay.json`, ReplayLog, replays);
  return { claim, solver, replay: replays };
}

const ReplayLog = z.array(
  z.object({
    purpose: z.enum(['counterexample', 'differential']),
    input: z.record(z.string(), z.union([z.string(), z.boolean()])),
    modelName: z.string(),
    model: z.union([z.string(), z.boolean()]).nullable(),
    javascript: z.unknown(),
    agrees: z.boolean().nullable(),
    note: z.string().optional(),
  }),
);
