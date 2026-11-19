import { type Expr, type FunctionModel, type PropertyIR, VeritasError } from '@veritas/core';
import { checkIR } from '@veritas/solver-z3';

/** The IR identifier rule (same as the SMT-LIB backend). Anything else could break out of a Lean identifier. */
const IR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Theorem names are plain Lean identifiers. */
const THEOREM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export const MODEL_NAMESPACE = 'VeritasModel';
export const PROOF_NAMESPACE = 'VeritasProof';
/** Domains with at most this many points in total are also attempted by exhaustive `decide`. */
export const DECIDE_MAX_POINTS = 256n;

function checkName(name: string): string {
  if (!IR_NAME.test(name)) {
    throw new VeritasError(
      'user',
      'IR_INVALID_NAME',
      `invalid identifier in property IR: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** IR names are prefixed (no clash with Lean names or keywords) and quoted with «» (allows `$`). */
const fnName = (name: string) => `«f_${checkName(name)}»`;
const varName = (name: string) => `«v_${checkName(name)}»`;

function intLiteral(value: string | bigint): string {
  return `(${BigInt(value).toString()} : Int)`;
}

const ARITH: Record<string, string> = { '+': '+', '-': '-', '*': '*', div: '/', mod: '%' };
const COMPARE: Record<string, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠' };

/** Every IR expression becomes a Lean `Int` or `Bool` term; comparisons are `decide`d into `Bool`. */
export function exprToLean(expr: Expr): string {
  switch (expr.kind) {
    case 'var':
      return varName(expr.name);
    case 'int':
      return intLiteral(expr.value);
    case 'bool':
      return expr.value ? 'true' : 'false';
    case 'unary':
      return expr.op === 'not' ? `(!${exprToLean(expr.arg)})` : `(-${exprToLean(expr.arg)})`;
    case 'binary': {
      const l = exprToLean(expr.left);
      const r = exprToLean(expr.right);
      const arith = ARITH[expr.op];
      if (arith) return `(${l} ${arith} ${r})`;
      const cmp = COMPARE[expr.op];
      if (cmp) return `(decide (${l} ${cmp} ${r}))`;
      if (expr.op === 'and') return `(${l} && ${r})`;
      if (expr.op === 'or') return `(${l} || ${r})`;
      return `((!${l}) || ${r})`;
    }
    case 'ite':
      return `(if ${exprToLean(expr.cond)} then ${exprToLean(expr.whenTrue)} else ${exprToLean(expr.whenFalse)})`;
    case 'call':
      return expr.args.length === 0
        ? fnName(expr.fn)
        : `(${fnName(expr.fn)} ${expr.args.map(exprToLean).join(' ')})`;
  }
}

const LEAN_SORT = { int: 'Int', bool: 'Bool' } as const;

function calls(expr: Expr, out: string[] = []): string[] {
  if (expr.kind === 'call') {
    out.push(expr.fn);
    for (const a of expr.args) calls(a, out);
  } else if (expr.kind === 'unary') calls(expr.arg, out);
  else if (expr.kind === 'binary') {
    calls(expr.left, out);
    calls(expr.right, out);
  } else if (expr.kind === 'ite') {
    calls(expr.cond, out);
    calls(expr.whenTrue, out);
    calls(expr.whenFalse, out);
  }
  return out;
}

/** Callees before callers; `checkIR` has already rejected recursion. */
function ordered(functions: FunctionModel[]): FunctionModel[] {
  const byName = new Map(functions.map((f) => [f.name, f]));
  const done = new Set<string>();
  const out: FunctionModel[] = [];
  const visit = (f: FunctionModel) => {
    if (done.has(f.name)) return;
    done.add(f.name);
    for (const callee of calls(f.body ?? { kind: 'bool', value: true })) {
      const g = byName.get(callee);
      if (g) visit(g);
    }
    out.push(f);
  };
  functions.forEach(visit);
  return out;
}

function usesDivision(expr: Expr): boolean {
  switch (expr.kind) {
    case 'unary':
      return usesDivision(expr.arg);
    case 'binary':
      return expr.op === 'div' || expr.op === 'mod' || usesDivision(expr.left) || usesDivision(expr.right);
    case 'ite':
      return usesDivision(expr.cond) || usesDivision(expr.whenTrue) || usesDivision(expr.whenFalse);
    case 'call':
      return expr.args.some(usesDivision);
    default:
      return false;
  }
}

/** True when the IR divides anywhere (Lean's `x / 0 = 0` then differs from JavaScript). */
export function irUsesDivision(ir: PropertyIR): boolean {
  return (
    usesDivision(ir.body) ||
    ir.preconditions.some(usesDivision) ||
    ir.functions.some((f) => f.body !== null && usesDivision(f.body))
  );
}

export interface LeanStrategy {
  name: 'unfold-split-omega' | 'simp-split-omega' | 'decide-enumerate';
  /** Tactic script lines placed after `:= by`, already indented. */
  script: string[];
}

interface Prepared {
  ir: PropertyIR;
  theoremName: string;
  defs: string[];
  statement: string;
}

function prepare(ir: PropertyIR, theoremName: string): Prepared {
  if (!THEOREM_NAME.test(theoremName)) {
    throw new VeritasError(
      'user',
      'LEAN_INVALID_NAME',
      `invalid Lean theorem name: ${JSON.stringify(theoremName)}`,
    );
  }
  checkIR(ir);
  const defs: string[] = [];
  for (const f of ordered(ir.functions)) {
    if (f.body === null) {
      throw new VeritasError(
        'user',
        'IR_UNSUPPORTED',
        `function ${f.name} is opaque; the Lean backend needs a body for every function`,
      );
    }
    const params = f.params.map((p) => ` (${varName(p.name)} : ${LEAN_SORT[p.sort]})`).join('');
    defs.push(`def ${fnName(f.name)}${params} : ${LEAN_SORT[f.returns]} :=\n  ${exprToLean(f.body)}`);
  }
  const binders = ir.params.map((p) => `(${varName(p.name)} : ${LEAN_SORT[p.sort]})`);
  const hyps: string[] = [];
  for (const p of ir.params) {
    if (p.sort !== 'int') continue;
    hyps.push(
      `${intLiteral(p.domain.min)} ≤ ${varName(p.name)}`,
      `${varName(p.name)} ≤ ${intLiteral(p.domain.max)}`,
    );
  }
  for (const pre of ir.preconditions) hyps.push(`${exprToLean(pre)} = true`);
  const conclusion = `${exprToLean(ir.body)} = true`;
  const chain = [...hyps, conclusion].map((h) => `      ${h}`).join(' →\n');
  const statement = binders.length > 0 ? `    ∀ ${binders.join(' ')},\n${chain}` : chain;
  return { ir, theoremName, defs, statement };
}

function domainHypCount(ir: PropertyIR): number {
  return ir.params.filter((p) => p.sort === 'int').length * 2;
}

/** Deterministic tactic scripts, in the order they are attempted. No proof search beyond Lean's own tactics. */
export function leanProofStrategies(ir: PropertyIR): LeanStrategy[] {
  checkIR(ir);
  const defNames = ir.functions.map((f) => `${MODEL_NAMESPACE}.${fnName(f.name)}`);
  const vars = ir.params.map((p) => varName(p.name));
  const domainHyps = Array.from({ length: domainHypCount(ir) }, (_, i) => `h_${i}`);
  const preHyps = ir.preconditions.map((_, i) => `h_${domainHyps.length + i}`);
  const intros = [...vars, ...domainHyps, ...preHyps];
  const introLine = intros.length > 0 ? [`  intro ${intros.join(' ')}`] : [];
  const bools = ir.params.filter((p) => p.sort === 'bool').map((p) => varName(p.name));
  const casesLine = bools.length > 0 ? [`  ${bools.map((b) => `cases ${b}`).join(' <;> ')} <;> skip`] : [];
  const unfold = defNames.length > 0 ? [`  all_goals (try simp only [${defNames.join(', ')}])`] : [];
  const unfoldAt = defNames.length > 0 ? [`  all_goals (try simp only [${defNames.join(', ')}] at *)`] : [];

  const strategies: LeanStrategy[] = [
    {
      name: 'unfold-split-omega',
      script: [
        ...introLine,
        ...casesLine,
        ...unfold,
        "  all_goals ((repeat' split) <;> (try simp_all) <;> omega)",
      ],
    },
    {
      name: 'simp-split-omega',
      script: [
        ...introLine,
        ...casesLine,
        ...unfoldAt,
        '  all_goals (try simp at *)',
        "  all_goals ((repeat' split) <;> (try simp_all) <;> omega)",
      ],
    },
  ];

  let points = 1n;
  for (const p of ir.params) {
    points *= p.sort === 'bool' ? 2n : BigInt(p.domain.max) - BigInt(p.domain.min) + 1n;
  }
  if (points <= DECIDE_MAX_POINTS) {
    // Preconditions stay in the goal so `decide` evaluates them for every point.
    const lines =
      vars.length + domainHyps.length > 0 ? [`  intro ${[...vars, ...domainHyps].join(' ')}`] : [];
    const splits: string[] = bools.map((b) => `cases ${b}`);
    for (const p of ir.params) {
      if (p.sort !== 'int') continue;
      const lo = BigInt(p.domain.min);
      const hi = BigInt(p.domain.max);
      const values: string[] = [];
      for (let v = lo; v <= hi; v++) values.push(`${varName(p.name)} = ${intLiteral(v)}`);
      const h = `h_${checkName(p.name).replaceAll('$', '_')}_${splits.length}`;
      lines.push(`  have ${h} : ${values.join(' ∨ ')} := by omega`);
      splits.push(`rcases ${h} with ${values.map(() => 'rfl').join(' | ')}`);
    }
    lines.push(`  ${[...splits, 'decide'].join(' <;> ')}`);
    strategies.push({ name: 'decide-enumerate', script: lines });
  }
  return strategies;
}

/**
 * Lean 4 source for `forall params in their domains: preconditions -> body`, with the IR functions as
 * `def`s over `Int`/`Bool`. The proof is the given strategy (default: the first one).
 * Throws `VeritasError` for IR that `checkIR` rejects, opaque functions, or an invalid theorem name.
 */
export function irToLean(ir: PropertyIR, options: { theoremName: string; strategy?: LeanStrategy }): string {
  const prepared = prepare(ir, options.theoremName);
  const strategy = options.strategy ?? (leanProofStrategies(ir)[0] as LeanStrategy);
  return [
    '-- Generated by Veritas from a property IR. Deterministic; do not edit.',
    `namespace ${MODEL_NAMESPACE}`,
    '',
    ...prepared.defs.flatMap((d) => [d, '']),
    `end ${MODEL_NAMESPACE}`,
    '',
    `namespace ${PROOF_NAMESPACE}`,
    '',
    `open ${MODEL_NAMESPACE} in`,
    `theorem «${prepared.theoremName}» :`,
    `${prepared.statement} := by`,
    ...strategy.script,
    '',
    `end ${PROOF_NAMESPACE}`,
    '',
  ].join('\n');
}
