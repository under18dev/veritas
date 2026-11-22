import { type Expr, type FunctionModel, type PropertyIR, VeritasError } from '@under18dev/veritas-core';
import { checkIR } from '@under18dev/veritas-solver-z3';

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

/** `expr` with the variables named in `values` replaced by the given expressions. */
function substituteVars(expr: Expr, values: ReadonlyMap<string, Expr>): Expr {
  switch (expr.kind) {
    case 'var':
      return values.get(expr.name) ?? expr;
    case 'unary':
      return { ...expr, arg: substituteVars(expr.arg, values) };
    case 'binary':
      return { ...expr, left: substituteVars(expr.left, values), right: substituteVars(expr.right, values) };
    case 'ite':
      return {
        ...expr,
        cond: substituteVars(expr.cond, values),
        whenTrue: substituteVars(expr.whenTrue, values),
        whenFalse: substituteVars(expr.whenFalse, values),
      };
    case 'call':
      return { ...expr, args: expr.args.map((a) => substituteVars(a, values)) };
    default:
      return expr;
  }
}

type Call = Extract<Expr, { kind: 'call' }>;

/** Distinct calls in `expr` whose arguments contain no call, keyed by their Lean text. */
function innermostCalls(expr: Expr, out: Map<string, Call> = new Map()): Map<string, Call> {
  if (expr.kind === 'call') {
    if (expr.args.some((a) => calls(a).length > 0)) for (const a of expr.args) innermostCalls(a, out);
    else out.set(exprToLean(expr), expr);
  } else if (expr.kind === 'unary') innermostCalls(expr.arg, out);
  else if (expr.kind === 'binary') {
    innermostCalls(expr.left, out);
    innermostCalls(expr.right, out);
  } else if (expr.kind === 'ite') {
    innermostCalls(expr.cond, out);
    innermostCalls(expr.whenTrue, out);
    innermostCalls(expr.whenFalse, out);
  }

  return out;
}

/**
 * The functions the property body calls, and the innermost calls their bodies make once those are unfolded (with
 * the arguments of the body's calls in place of their parameters). Null when there is no such inner call, or when
 * the calls cannot be abstracted as written: a call among the body's call arguments, or an inner call to a function
 * the body also calls, would be unfolded too.
 */
function abstractableCalls(ir: PropertyIR): { unfolded: string[]; inner: Call[] } | null {
  const byName = new Map(ir.functions.map((f) => [f.name, f]));
  const direct = [...new Set(calls(ir.body))];
  const inner = new Map<string, Call>();
  let nested = false;

  const visit = (expr: Expr) => {
    if (expr.kind === 'call') {
      const f = byName.get(expr.fn);

      if (expr.args.some((a) => calls(a).length > 0)) nested = true;
      else if (f?.body) {
        const values = new Map<string, Expr>(f.params.map((p, i) => [p.name, expr.args[i] as Expr]));
        innermostCalls(substituteVars(f.body, values), inner);
      }
    } else if (expr.kind === 'unary') visit(expr.arg);
    else if (expr.kind === 'binary') {
      visit(expr.left);
      visit(expr.right);
    } else if (expr.kind === 'ite') {
      visit(expr.cond);
      visit(expr.whenTrue);
      visit(expr.whenFalse);
    }
  };
  visit(ir.body);
  const innerCalls = [...inner.values()];

  if (nested || innerCalls.length === 0 || innerCalls.some((c) => direct.includes(c.fn))) return null;

  return { unfolded: direct, inner: innerCalls };
}

/** The functions `name` calls, directly or through others, with itself. */
function reachable(ir: PropertyIR, name: string): string[] {
  const byName = new Map(ir.functions.map((f) => [f.name, f]));
  const out = new Set<string>();
  const visit = (fn: string) => {
    if (out.has(fn)) return;
    out.add(fn);

    for (const callee of calls(byName.get(fn)?.body ?? { kind: 'bool', value: true })) visit(callee);
  };
  visit(name);

  return [...out];
}

export interface LeanStrategy {
  name:
    | 'abstract-calls-split'
    | 'unfold-split-omega'
    | 'simp-split-omega'
    | 'decide-enumerate'
    | 'name-int-calls-cases';
  /** Tactic script lines placed after `:= by`, already indented. */
  script: string[];
  /** Lemmas the script uses, proved in the same file before the theorem (no axioms beyond Lean's own). */
  lemmas?: string[];
  /** `set_option ... in` lines placed right before the theorem (only options the project check allows). */
  options?: string[];
}

/** Rewrites an equation on an `if` into the two cases, so that `omega` can read what is left of a decision list. */
const ITE_EQ_LEMMA = [
  'theorem veritas_ite_eq {α : Type} {P : Prop} [Decidable P] {a b c : α} :',
  '    ((if P then a else b) = c) = ((P ∧ a = c) ∨ (¬P ∧ b = c)) := by',
  '  by_cases h : P <;> simp [h]',
];

/**
 * Lean's elaboration budget for the named-calls strategy (eight times the default). Splitting many booleans one at
 * a time is more work than the default allows, but the budget stays bounded and deterministic.
 */
const NAMED_CALLS_HEARTBEATS = 1_600_000;

/** Bool parameters above which splitting all of them up front (2^n goals) is not attempted first. */
const UPFRONT_CASES_MAX_BOOLS = 8;

const qualified = (name: string) => `${MODEL_NAMESPACE}.${fnName(name)}`;

function mapExpr(expr: Expr, f: (e: Expr) => Expr): Expr {
  switch (expr.kind) {
    case 'unary':
      return { ...expr, arg: f(expr.arg) };
    case 'binary':
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case 'ite':
      return { ...expr, cond: f(expr.cond), whenTrue: f(expr.whenTrue), whenFalse: f(expr.whenFalse) };
    case 'call':
      return { ...expr, args: expr.args.map(f) };
    default:
      return expr;
  }
}

function varsOf(expr: Expr, out: Set<string> = new Set()): Set<string> {
  if (expr.kind === 'var') out.add(expr.name);
  else
    mapExpr(expr, (e) => {
      varsOf(e, out);

      return e;
    });

  return out;
}

/** The distinct integer literals at the leaves of a tree of `if`s, or null when a leaf is anything else. */
function literalLeaves(expr: Expr): bigint[] | null {
  const out = new Set<bigint>();
  const visit = (e: Expr): boolean => {
    if (e.kind === 'ite') return visit(e.whenTrue) && visit(e.whenFalse);

    if (e.kind !== 'int') return false;
    out.add(BigInt(e.value));

    return true;
  };

  return visit(expr) && expr.kind === 'ite' ? [...out] : null;
}

/** True when `expr` has an `if` and every condition reads only the given variables (and no call). */
function itesOnlyOver(expr: Expr, allowed: ReadonlySet<string>): boolean {
  let found = false;
  let ok = true;
  const visit = (e: Expr): Expr => {
    if (e.kind === 'ite') {
      found = true;

      if (calls(e.cond).length > 0 || [...varsOf(e.cond)].some((v) => !allowed.has(v))) ok = false;
    }

    return mapExpr(e, visit);
  };
  visit(expr);

  return found && ok;
}

/** The largest term (in IR nodes) the named-calls strategy inlines; beyond it the strategy is not offered. */
const NAMED_CALLS_MAX_TERM = 20_000;

function children(expr: Expr): Expr[] {
  switch (expr.kind) {
    case 'unary':
      return [expr.arg];
    case 'binary':
      return [expr.left, expr.right];
    case 'ite':
      return [expr.cond, expr.whenTrue, expr.whenFalse];
    case 'call':
      return expr.args;
    default:
      return [];
  }
}

/**
 * Size of `expr` once its boolean calls are inlined, computed without building it, so that a chain of helpers that
 * each call the previous one several times is turned down before anything is expanded. Every node and every
 * function is measured once, and sizes saturate just above `limit`, so the work is linear in the IR and the result
 * is at most `limit + 1`.
 */
function inlinedSize(ir: PropertyIR, expr: Expr, limit: number = NAMED_CALLS_MAX_TERM): number {
  const byName = new Map(ir.functions.map((f) => [f.name, f]));
  const over = limit + 1;
  const nodes = new WeakMap<Expr, number>();
  const functions = new Map<string, number>();
  const add = (a: number, b: number) => Math.min(over, a + b);
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : Math.min(over, a * b));
  const multMemo = new Map<string, number>();
  const occMemo = new WeakMap<Expr, Map<string, number>>();
  /** Copies of the variable `name` in `e` once its boolean calls are inlined (saturating). */
  const occurrencesIn = (e: Expr, name: string): number => {
    let perName = occMemo.get(e);

    if (!perName) {
      perName = new Map();
      occMemo.set(e, perName);
    }
    const known = perName.get(name);

    if (known !== undefined) return known;
    let total = 0;
    const f = e.kind === 'call' ? byName.get(e.fn) : undefined;

    if (e.kind === 'var') total = e.name === name ? 1 : 0;
    else if (e.kind === 'call' && f?.returns === 'bool' && f.body) {
      for (let i = 0; i < e.args.length && total < over; i++) {
        const inArg = occurrencesIn(e.args[i] as Expr, name);

        if (inArg > 0) total = add(total, mul(inArg, multiplicity(f, f.params[i]?.name ?? '')));
      }
    } else for (const c of children(e)) total = add(total, occurrencesIn(c, name));
    perName.set(name, total);

    return total;
  };
  /** Copies of parameter `param` in the inlined body of `f`. */
  const multiplicity = (f: FunctionModel, param: string): number => {
    const key = `${f.name}\u0000${param}`;
    let m = multMemo.get(key);

    if (m === undefined) {
      m = occurrencesIn(f.body as Expr, param);
      multMemo.set(key, m);
    }

    return m;
  };
  const size = (e: Expr): number => {
    const known = nodes.get(e);

    if (known !== undefined) return known;
    const f = e.kind === 'call' ? byName.get(e.fn) : undefined;
    let total: number;

    if (e.kind === 'call' && f?.returns === 'bool' && f.body) {
      const body = f.body;
      let own = functions.get(f.name);

      if (own === undefined) {
        own = size(body);
        functions.set(f.name, own);
      }
      total = own;

      // Each copy of a parameter in the inlined body becomes a copy of the argument.
      for (let i = 0; i < e.args.length && total < over; i++) {
        const count = multiplicity(f, f.params[i]?.name ?? '');

        if (count > 0) total = add(total, mul(size(e.args[i] as Expr), count));
      }
    } else {
      total = 1;

      for (const c of children(e)) {
        if (total >= over) break;
        total = add(total, size(c));
      }
    }
    nodes.set(e, total);

    return total;
  };

  return size(expr);
}

/**
 * Whether the named-calls strategy applies: some function returns an integer, every function has a body (opaque
 * ones are left to the model check, which rejects them), and inlining the boolean helpers stays small.
 */
function namedIntCallsApplies(ir: PropertyIR): boolean {
  if (!ir.functions.some((f) => f.returns === 'int') || ir.functions.some((f) => f.body === null))
    return false;

  return [ir.body, ...ir.functions.filter((f) => f.returns === 'int').map((f) => f.body as Expr)].every(
    (e) => inlinedSize(ir, e) <= NAMED_CALLS_MAX_TERM,
  );
}

/** Generation of the named-calls script stopped at a budget: the strategy is abandoned without an attempt. */
class ScriptTooLarge extends Error {}

/** At most this many named call results, and this many bytes of script, before the strategy is abandoned. */
const NAMED_CALLS_MAX_RESULTS = 2_000;
const NAMED_CALLS_MAX_SCRIPT_BYTES = 1_000_000;

/**
 * Names the result of every call to an integer-valued function (`r_k`, with `hr_k : call = r_k`), unfolds each
 * such function only in its own equation, and inlines the boolean-valued functions. A helper whose result is
 * used several times (a code mapped by another decision list) is then one variable instead of a copy of its
 * whole decision tree per use. The equations of functions that only branch on such named results are split; the
 * boolean parameters are then split one at a time, simplifying after each split so that decided branches close
 * early; what remains is a linear integer problem for `omega`.
 */
function namedIntCallsScript(ir: PropertyIR, introLine: string[], bools: string[]): string[] {
  const byName = new Map(ir.functions.map((f) => [f.name, f]));
  const returnsOf = (fn: string) => byName.get(fn)?.returns;
  const boolDefs = ir.functions.filter((f) => f.returns === 'bool').map((f) => qualified(f.name));
  const lines = [...introLine];
  let bytes = 0;
  let work = 0;
  const push = (...more: string[]) => {
    for (const l of more) bytes += l.length + 1;

    if (bytes > NAMED_CALLS_MAX_SCRIPT_BYTES) throw new ScriptTooLarge();
    lines.push(...more);
  };
  const named = new Map<string, { h: string; ref: Expr }>();
  const namedVars = new Set<string>();
  const splits: string[] = [];
  const copies: string[] = [];
  /** Every named result with its unfolded definition (`hr_k`) and what that definition reduced to. */
  const defs: { r: string; name: string; def: string; reduced: Expr }[] = [];

  const inlineBool = (expr: Expr): Expr => {
    if (++work > NAMED_CALLS_MAX_TERM * 10) throw new ScriptTooLarge();
    const e = mapExpr(expr, inlineBool);

    if (e.kind !== 'call' || returnsOf(e.fn) !== 'bool') return e;
    const f = byName.get(e.fn) as FunctionModel;
    const values = new Map<string, Expr>(f.params.map((p, i) => [p.name, e.args[i] as Expr]));

    return inlineBool(substituteVars(f.body as Expr, values));
  };

  /** `expr` (already with boolean calls inlined) with every integer call replaced by its name. */
  const nameCalls = (expr: Expr, loc: string): Expr => {
    const e = mapExpr(expr, (a) => nameCalls(a, loc));

    if (e.kind !== 'call' || returnsOf(e.fn) !== 'int') return e;
    const key = exprToLean(e);
    let entry = named.get(key);

    if (!entry) {
      if (named.size >= NAMED_CALLS_MAX_RESULTS) throw new ScriptTooLarge();
      const k = named.size;
      const name = `r$${k}`;
      const r = varName(name);
      // `hc_k` stays `call = r_k` to rewrite later uses of the call; `hr_k` is unfolded into the definition.
      entry = { h: `hc_${k}`, ref: { kind: 'var', name } };
      named.set(key, entry);
      namedVars.add(name);
      copies.push(entry.h);
      const def = `hr_${k}`;
      const f = byName.get(e.fn) as FunctionModel;
      push(
        `  obtain ⟨${r}, ${entry.h}, ${def}⟩ : ∃ ${r}, ${key} = ${r} ∧ ${key} = ${r} := ⟨_, rfl, rfl⟩`,
        `  try simp only [${entry.h}]${loc}`,
        `  simp only [${qualified(f.name)}] at ${def}`,
      );
      const values = new Map<string, Expr>(f.params.map((p, i) => [p.name, e.args[i] as Expr]));
      const reduced = place(substituteVars(f.body as Expr, values), ` at ${def}`);

      defs.push({ r, name, def, reduced });

      if (itesOnlyOver(reduced, namedVars)) splits.push(def);
    } else push(`  try simp only [${entry.h}]${loc}`);

    return entry.ref;
  };

  const place = (expr: Expr, loc: string): Expr => {
    if (boolDefs.length > 0 && calls(expr).some((fn) => returnsOf(fn) === 'bool'))
      push(`  try simp only [${boolDefs.join(', ')}]${loc}`);

    return nameCalls(inlineBool(expr), loc);
  };

  place(ir.body, '');
  // Left in place, `subst_vars` would put every call back.
  push(`  clear ${copies.join(' ')}`);

  const finish = ['  all_goals (try simp only [veritas_ite_eq] at *)', '  all_goals omega'];

  if (splits.length <= 1) {
    // One code mapped from named results: its few cases give each branch a known code to prune against.
    for (const h of splits) push(`  all_goals (repeat' (split at ${h}))`);
    push(
      '  all_goals (try simp only [decide_eq_true_eq] at *)',
      '  all_goals (try subst_vars)',
      ...bools.map((b) => `  all_goals (cases ${b} <;> try simp at *)`),
      ...finish,
    );
  } else {
    // Several: splitting each multiplies the branches. Instead, a named result is replaced by its value as soon
    // as the split booleans reduce its definition to one of its literal cases, inner results first, so that the
    // results built on it reduce in turn.
    for (const d of defs) if (d.reduced.kind === 'var') push(`  subst ${d.r}`);
    const resolvable = defs
      .map((d) => ({ ...d, leaves: literalLeaves(d.reduced) }))
      .filter((d): d is typeof d & { leaves: bigint[] } => d.leaves !== null);
    const done = new Set<string>();
    const steps: string[] = [];

    while (done.size < resolvable.length) {
      const ready = resolvable.filter(
        (d) =>
          !done.has(d.name) &&
          [...varsOf(d.reduced)].every(
            (v) => !namedVars.has(v) || done.has(v) || !resolvable.some((o) => o.name === v),
          ),
      );
      const next = ready.length > 0 ? ready : resolvable.filter((d) => !done.has(d.name));

      for (const d of next) {
        done.add(d.name);
        const alts = d.leaves.flatMap((v) => [
          `(obtain rfl : ${intLiteral(v)} = ${d.r} := ${d.def})`,
          `(obtain rfl : ${d.r} = ${intLiteral(v)} := ${d.def})`,
        ]);
        steps.push(`(try (first | ${alts.join(' | ')}))`, '(try simp at *)');
      }
    }
    for (const b of bools) {
      push(`  all_goals (cases ${b} <;> try simp at *)`);

      if (steps.length > 0) push(`  all_goals (${steps.join(' <;> ')})`);
    }
    push(...finish);
  }

  return lines;
}

/**
 * The named-calls strategy, or null when it does not apply. Its script is only generated when an attempt reads it,
 * so a proof found by an earlier strategy never pays for it.
 */
function namedIntCallsStrategy(ir: PropertyIR, introLine: string[], bools: string[]): LeanStrategy | null {
  if (!namedIntCallsApplies(ir)) return null;
  let script: string[] | undefined;

  return {
    name: 'name-int-calls-cases',
    // Empty when generation hits a budget; `proveWithLean` then skips the strategy without running Lean.
    get script() {
      if (script === undefined) {
        try {
          script = namedIntCallsScript(ir, introLine, bools);
        } catch (error) {
          if (!(error instanceof ScriptTooLarge)) throw error;
          script = [];
        }
      }

      return script;
    },
    lemmas: ITE_EQ_LEMMA,
    options: [`set_option maxHeartbeats ${NAMED_CALLS_HEARTBEATS} in`],
  };
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
    // Record fields are plain Int/Bool parameters. Arrays are not: slots beyond the length are not part of the
    // JavaScript value, and the bounds obligation is only checked by the SMT backend.
    if (f.jsParams?.some((p) => p.kind === 'array') || f.outOfBounds?.length) {
      throw new VeritasError(
        'user',
        'IR_UNSUPPORTED',
        `function ${f.name} takes an array; the Lean backend covers integer, boolean and record parameters only`,
      );
    }

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

  // Unfolding everything copies a helper's whole decision tree into every place its result is used, and
  // splitting those copies one by one can exhaust Lean's budget long before the cases meet. Instead, unfold only
  // what the body calls, name each innermost call's result (`r_k`), split that call's definition into its cases
  // and substitute the value of each case. Tried first whenever the functions the body calls call others.
  const abstractable = abstractableCalls(ir);

  if (abstractable) {
    const all = (names: string[]) => names.map((n) => `${MODEL_NAMESPACE}.${fnName(n)}`).join(', ');
    const lines = [...introLine, `  simp only [${all(abstractable.unfolded)}]`];
    const hyps: string[] = [];

    abstractable.inner.forEach((call, k) => {
      const r = `r_${k}`;
      const h = `hr_${k}`;
      hyps.push(h);
      lines.push(
        `  obtain ⟨${r}, ${h}⟩ : ∃ ${r}, ${exprToLean(call)} = ${r} := ⟨_, rfl⟩`,
        `  simp only [${h}]`,
        `  try simp only [${all(reachable(ir, call.fn))}] at ${h}`,
      );
    });
    lines.push(
      ...casesLine,
      `  all_goals (repeat' (first ${hyps.map((h) => `| (split at ${h})`).join(' ')}))`,
      ...hyps.map((h) => `  all_goals (try subst ${h})`),
      `  all_goals (try simp_all [${all(ir.functions.map((f) => f.name))}])`,
      '  all_goals omega',
    );
    strategies.unshift({ name: 'abstract-calls-split', script: lines });
  }

  // With many boolean parameters the strategies above start from 2^n goals; naming the integer calls and
  // splitting one boolean at a time is then tried first.
  const named = namedIntCallsStrategy(ir, introLine, bools);

  if (named) {
    if (bools.length > UPFRONT_CASES_MAX_BOOLS) strategies.unshift(named);
    else strategies.push(named);
  }

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
 * Checks that the IR translates to a Lean model (the same checks as `irToLean`) without generating any proof
 * script. Throws `VeritasError` otherwise.
 */
export function checkLeanModel(ir: PropertyIR, theoremName: string): void {
  prepare(ir, theoremName);
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
    ...(strategy.lemmas ? [...strategy.lemmas, ''] : []),
    ...(strategy.options ?? []),
    `open ${MODEL_NAMESPACE} in`,
    `theorem «${prepared.theoremName}» :`,
    `${prepared.statement} := by`,
    ...strategy.script,
    '',
    `end ${PROOF_NAMESPACE}`,
    '',
  ].join('\n');
}
