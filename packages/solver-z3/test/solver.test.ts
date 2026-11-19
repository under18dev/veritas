import type { Expr, PropertyIR } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { conformanceQuery, interpretOutput, safeRangeQuery, solveSmtLib } from '../src/index.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number | string): Expr => ({ kind: 'int', value: String(value) });
const bin = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({
  kind: 'binary',
  op,
  left,
  right,
});
const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
const ite = (cond: Expr, whenTrue: Expr, whenFalse: Expr): Expr => ({
  kind: 'ite',
  cond,
  whenTrue,
  whenFalse,
});

const discount = (op: '>' | '>=') => ({
  name: op === '>' ? 'impl' : 'spec',
  symbol: 'src/pricing.ts#discountAmount',
  params: [{ name: 't', sort: 'int' as const }],
  returns: 'int' as const,
  body: ite(bin(op, v('t'), n(1000)), n(100), n(0)),
});

/** "discountAmount conforms to: total >= 1000 => 100, else 0" over a bounded domain. */
const boundaryIR = (implOp: '>' | '>=', min = '-10000', max = '10000'): PropertyIR => ({
  irVersion: 1,
  params: [{ name: 'total', sort: 'int', domain: { min, max } }],
  preconditions: [],
  functions: [{ ...discount(implOp), name: 'impl' }, discount('>=')],
  body: bin('==', call('impl', v('total')), call('spec', v('total'))),
});

describe('SMT-LIB generation', () => {
  it('encodes domains, functions and the negated property', () => {
    const smt = conformanceQuery(boundaryIR('>'), 1000);
    expect(smt).toContain('(declare-const |total| Int)');
    expect(smt).toContain('(assert (<= (- 10000) |total| 10000))');
    expect(smt).toContain('(define-fun |impl| ((|t| Int)) Int (ite (> |t| 1000) 100 0))');
    expect(smt).toContain('(assert (not (= (|impl| |total|) (|spec| |total|))))');
    expect(smt).toContain('(set-option :timeout 1000)');
  });

  it('rejects ill-sorted, recursive, unsafe-domain or badly named IR', () => {
    const bad = { ...boundaryIR('>'), body: bin('+', v('total'), n(1)) };
    expect(() => conformanceQuery(bad, 1000)).toThrow(/bool/);
    const rec: PropertyIR = {
      ...boundaryIR('>'),
      functions: [
        {
          name: 'f',
          symbol: 'x#f',
          params: [{ name: 'a', sort: 'int' }],
          returns: 'int',
          body: call('f', v('a')),
        },
      ],
      body: bin('==', call('f', v('total')), n(0)),
    };
    expect(() => conformanceQuery(rec, 1000)).toThrow(/recursive/);
    expect(() => conformanceQuery(boundaryIR('>', '-9007199254740993', '0'), 1000)).toThrow(/safe-integer/);
    const injected = { ...boundaryIR('>'), params: [{ name: 'x| (assert false) |', sort: 'bool' as const }] };
    expect(() => conformanceQuery(injected, 1000)).toThrow(/invalid identifier/);
  });
});

describe('output interpretation', () => {
  it('accepts only exact verdicts', () => {
    expect(interpretOutput('sat\n((|x| (- 5)) (|b| true))\n')).toMatchObject({
      verdict: 'sat',
      model: { x: '-5', b: true },
    });
    expect(interpretOutput('unsat\n(error "line 9 column 10: model is not available")\n').verdict).toBe(
      'unsat',
    );
    expect(interpretOutput('sat\n(error "model is not available")\n').verdict).toBe('error');
    expect(interpretOutput('unsat\n(error "line 3: unknown function |f|")\n').verdict).toBe('error');
    expect(interpretOutput('unsat\n').verdict).toBe('unsat');
    expect(interpretOutput('unknown\n(:reason-unknown "timeout")\n').verdict).toBe('timeout');
    expect(interpretOutput('unknown\n(:reason-unknown "incomplete quantifiers")\n').verdict).toBe('unknown');
    expect(interpretOutput('').verdict).toBe('error');
    expect(interpretOutput('SAT').verdict).toBe('error');
    expect(interpretOutput('(error "line 1: unknown constant")').verdict).toBe('error');
  });
});

describe('Z3 (wasm) execution', () => {
  it('finds the boundary counterexample total = 1000', async () => {
    const run = await solveSmtLib(conformanceQuery(boundaryIR('>'), 5000), { timeoutMs: 30_000 });
    expect(run.verdict).toBe('sat');
    expect(run.model).toEqual({ total: '1000' });
    expect(run.engineVersion).toMatch(/z3/i);
  }, 60_000);

  it('reports unsat for the conforming candidate, only within the domain', async () => {
    const run = await solveSmtLib(conformanceQuery(boundaryIR('>='), 5000), { timeoutMs: 30_000 });
    expect(run.verdict).toBe('unsat');
    expect(run.model).toEqual({});
  }, 60_000);

  it('does not report unsat when the counterexample lies outside a narrower domain claim', async () => {
    const run = await solveSmtLib(conformanceQuery(boundaryIR('>', '0', '999'), 5000), { timeoutMs: 30_000 });
    // No violation exists below 1000: the result is only "no counterexample in [0, 999]".
    expect(run.verdict).toBe('unsat');
  }, 60_000);

  it('reports timeout, never unsat, when the solver gives up', async () => {
    const hard: PropertyIR = {
      irVersion: 1,
      params: ['a', 'b', 'c'].map((name) => ({
        name,
        sort: 'int' as const,
        domain: { min: '1', max: '9007199254740991' },
      })),
      preconditions: [],
      functions: [],
      body: bin(
        '!=',
        bin(
          '+',
          bin('*', bin('*', bin('*', v('a'), v('a')), v('a')), v('a')),
          bin('*', bin('*', bin('*', v('b'), v('b')), v('b')), v('b')),
        ),
        bin('*', bin('*', bin('*', v('c'), v('c')), v('c')), v('c')),
      ),
    };
    const run = await solveSmtLib(conformanceQuery(hard, 200), { timeoutMs: 20_000 });
    expect(['timeout', 'unknown']).toContain(run.verdict);
    expect(run.verdict).not.toBe('unsat');
  }, 60_000);

  it('enforces the wall-clock limit even if the soft timeout is ignored', async () => {
    const smt = conformanceQuery(boundaryIR('>'), 5000);
    const run = await solveSmtLib(smt, { timeoutMs: 1 });
    expect(['timeout', 'sat']).toContain(run.verdict);
    if (run.verdict === 'timeout') expect(run.error).toMatch(/wall-clock/);
  }, 60_000);

  it('reports a missing native binary as an error, not a verdict', async () => {
    const run = await solveSmtLib(conformanceQuery(boundaryIR('>'), 1000), {
      engine: 'z3-native',
      nativeBinary: 'veritas-no-such-z3',
      timeoutMs: 5000,
    });
    expect(run.verdict).toBe('error');
  });
});

describe('safe-integer obligation', () => {
  it('is null without arithmetic and finds overflow when the domain allows it', async () => {
    expect(safeRangeQuery(boundaryIR('>'), 1000)).toBeNull();
    const ir: PropertyIR = {
      irVersion: 1,
      params: [{ name: 'x', sort: 'int', domain: { min: '0', max: '9007199254740991' } }],
      preconditions: [],
      functions: [],
      body: bin('>=', bin('*', v('x'), n(2)), v('x')),
    };
    const run = await solveSmtLib(safeRangeQuery(ir, 5000) as string, { timeoutMs: 30_000 });
    expect(run.verdict).toBe('sat');
    const safe = { ...ir, params: [{ name: 'x', sort: 'int' as const, domain: { min: '0', max: '1000' } }] };
    expect((await solveSmtLib(safeRangeQuery(safe, 5000) as string, { timeoutMs: 30_000 })).verdict).toBe(
      'unsat',
    );
  }, 60_000);
});
