export type Op = '<' | '<=' | '>' | '>=' | '==';

/** An integer predicate on one variable as a closed interval [lo, hi] (null = unbounded), or a point. */
export interface Interval {
  lo: bigint | null;
  hi: bigint | null;
}

/** Normalize `x op v` over the integers, e.g. `x > 1000` becomes [1001, +inf). */
export function toInterval(op: Op, value: string): Interval {
  const v = BigInt(value);

  switch (op) {
    case '>':
      return { lo: v + 1n, hi: null };
    case '>=':
      return { lo: v, hi: null };
    case '<':
      return { lo: null, hi: v - 1n };
    case '<=':
      return { lo: null, hi: v };
    case '==':
      return { lo: v, hi: v };
  }
}

export function sameInterval(a: Interval, b: Interval): boolean {
  return a.lo === b.lo && a.hi === b.hi;
}

/** The complement of a one-sided interval, so `if (x < 1000) return 0` agrees with `x >= 1000`. */
export function complement(i: Interval): Interval | null {
  if (i.lo !== null && i.hi === null) return { lo: null, hi: i.lo - 1n };

  if (i.lo === null && i.hi !== null) return { lo: i.hi + 1n, hi: null };

  return null;
}

const FLIP: Record<string, Op> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '===': '==' };

/** Code comparison operators normalized to the parameter's side (`1000 < x` is `x > 1000`). */
export function normalizeComparison(op: string, paramOnLeft: boolean): Op | null {
  const base: Record<string, Op> = { '<': '<', '<=': '<=', '>': '>', '>=': '>=', '===': '==', '==': '==' };
  const o = base[op];

  if (!o) return null;

  return paramOnLeft ? o : (FLIP[o] as Op);
}

export function describe(param: string, op: Op, value: string): string {
  return `${param} ${op} ${value}`;
}
