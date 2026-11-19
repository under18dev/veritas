import { stableId } from '@under18dev/veritas-core';
import type {
  BehaviorCandidate,
  CandidateBasis,
  CodeIndex,
  ComparisonOperator,
  FunctionInfo,
} from './schema.js';

/** Flip a comparison so the parameter reads on the left: `1000 < total` becomes `total > 1000`. */
const FLIPPED: Record<ComparisonOperator, ComparisonOperator> = {
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
  '===': '===',
  '!==': '!==',
  '==': '==',
  '!=': '!=',
};

/** Name pairs that suggest a round trip; a candidate needs both functions and matching types. */
const ROUND_TRIP_PAIRS: [RegExp, string][] = [
  [/^encode(.*)$/, 'decode$1'],
  [/^serialize(.*)$/, 'deserialize$1'],
  [/^stringify(.*)$/, 'parse$1'],
  [/^format(.*)$/, 'parse$1'],
  [/^compress(.*)$/, 'decompress$1'],
  [/^encrypt(.*)$/, 'decrypt$1'],
  [/^marshal(.*)$/, 'unmarshal$1'],
  [/^escape(.*)$/, 'unescape$1'],
  [/^pack(.*)$/, 'unpack$1'],
  [/^to(.+)$/, 'from$1'],
];

const IDEMPOTENT_NAME = /^(normalize|sanitize|canonicali[sz]e|trim|dedupe|unique|sort|clamp|abs|slugify)/i;

/** Names of binary operations that are usually symmetric; a candidate also needs two same-typed params. */
const COMMUTATIVE_NAME =
  /^(add|sum|plus|multiply|times|max|min|gcd|lcm|merge|union|intersect(ion)?|equals?|isEqual|same|distance|hypot|overlaps?)$/i;

/**
 * Propose behaviour candidates from code alone. Every candidate is `inferred`: it is a question
 * to check against a specification, never a specification. Templates are only proposed with
 * concrete evidence in the index.
 */
export function inferBehaviorCandidates(index: CodeIndex): BehaviorCandidate[] {
  const out: BehaviorCandidate[] = [];
  const exported = index.functions.filter((f) => f.exported);
  for (const fn of exported) {
    const notes = commonNotes(fn);
    const seen = new Set<string>();
    const add = (key: string, candidate: Omit<BehaviorCandidate, 'id' | 'symbol' | 'origin' | 'notes'>) => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: stableId('cand', { symbol: fn.symbol, template: candidate.template, key }),
        symbol: fn.symbol,
        origin: 'inferred',
        ...candidate,
        notes: [...notes],
      });
    };

    for (const c of fn.comparisons) {
      if (c.param === null) continue;
      const paramOnLeft = stripParens(c.left) === c.param;
      const operator = paramOnLeft ? c.operator : FLIPPED[c.operator];
      const other = paramOnLeft ? c.right : c.left;
      const at = `line ${c.location.range?.start}`;
      if (c.literal !== null) {
        const basis: CandidateBasis[] = ['implementation'];
        if (fn.jsdoc && new RegExp(`(^|[^\\d])${escapeRegExp(c.literal)}([^\\d]|$)`).test(fn.jsdoc)) {
          basis.push('comment');
        }
        // Callers that compare against the same value before calling corroborate the boundary.
        const literal = c.literal;
        const callers = index.functions.filter(
          (other) =>
            other !== fn &&
            other.calls.includes(fn.symbol) &&
            other.comparisons.some((oc) => oc.literal === literal),
        );
        if (callers.length) basis.push('usage');
        add(`boundary:${c.param}:${operator}:${c.literal}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour may change at ${c.param} ${operator} ${c.literal} (${at}); check ${c.param} = ${c.literal} and its neighbours${callers.length ? `; ${callers.map((f) => f.name).join(', ')} also compare${callers.length === 1 ? 's' : ''} against ${c.literal} before calling it` : ''}`,
          boundary: { param: c.param, operator, value: c.literal },
          basis,
        });
      } else {
        add(`relation:${c.param}:${operator}:${other}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour may change where ${c.param} ${operator} ${other} flips (${at}); check equal and adjacent values`,
          basis: ['implementation'],
        });
      }
    }

    for (const p of fn.params) {
      const parts = unionParts(p.type);
      const base = parts.filter((t) => t !== 'undefined' && t !== 'null');
      if (p.optional || parts.includes('undefined')) {
        add(`undefined:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour when ${p.name} is undefined`,
          basis: ['type'],
        });
      }
      if (parts.includes('null')) {
        add(`null:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour when ${p.name} is null`,
          basis: ['type'],
        });
      }
      if (base.length === 1 && base[0] === 'string') {
        add(`empty-string:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour when ${p.name} is the empty string`,
          basis: ['type'],
        });
      }
      if (base.length === 1 && isArrayType(base[0] as string)) {
        add(`empty-array:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour when ${p.name} is an empty array`,
          basis: ['type'],
        });
      }
      if (base.length > 0 && base.every(isNumericType)) {
        add(`negative:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour for negative ${p.name} (and zero)`,
          basis: ['type'],
        });
      }
      if (base.length > 0 && base.every((t) => t === 'number')) {
        // `number` admits fractions, NaN, ±Infinity, -0 and values beyond the safe integer range.
        add(`non-integer:${p.name}`, {
          template: 'boundary',
          description: `${fn.name}: behaviour for non-integer, NaN, ±Infinity and unsafe-integer values of ${p.name}`,
          basis: ['type'],
        });
      }
      if (base.length === 1 && isArrayType(base[0] as string) && fn.purity === 'pure') {
        add(`order:${p.name}`, {
          template: 'custom',
          description: `${fn.name}: whether the result depends on the order of ${p.name}; check a reordered ${p.name} and duplicate elements`,
          basis: ['type'],
        });
      }
    }

    if (fn.numericKinds.includes('division')) {
      add('division', {
        template: 'boundary',
        description: `${fn.name}: division can give a fraction, or ±Infinity/NaN for a zero divisor; check divisors of 0 and values that do not divide evenly`,
        basis: ['implementation'],
      });
    }

    const [first, second] = fn.params;
    if (
      fn.params.length === 2 &&
      first &&
      second &&
      first.type === second.type &&
      fn.purity === 'pure' &&
      COMMUTATIVE_NAME.test(fn.name.split('.').pop() ?? '')
    ) {
      add('commutativity', {
        template: 'commutativity',
        description: `${fn.name}(${first.name}, ${second.name}) equals ${fn.name}(${second.name}, ${first.name})`,
        basis: ['name', 'type'],
      });
    }

    for (const t of fn.throws) {
      const line = t.location.range?.start ?? 0;
      const guard = fn.branches
        .filter((b) => (b.location.range?.start ?? 0) <= line && (b.location.range?.end ?? 0) >= line)
        .sort((a, b) => span(a.location) - span(b.location))[0];
      const basis: CandidateBasis[] = ['implementation'];
      if (fn.jsdoc && /@throws|\bthrows?\b/i.test(fn.jsdoc)) basis.push('comment');
      add(`throws:${line}:${t.expression}`, {
        template: 'exception_condition',
        description: guard
          ? `${fn.name}: throws ${t.expression} when ${guard.condition} (line ${line})`
          : `${fn.name}: throws ${t.expression} (line ${line})`,
        basis,
      });
    }

    const partner = roundTripPartner(fn, exported);
    if (partner) {
      add(`round-trip:${partner.symbol}`, {
        template: 'round_trip',
        description: `${partner.name}(${fn.name}(x)) returns x for ${fn.params[0]?.type} inputs`,
        basis: ['name', 'type'],
      });
    }

    if (
      fn.params.length === 1 &&
      fn.params[0]?.type === fn.returnType &&
      IDEMPOTENT_NAME.test(fn.name.split('.').pop() ?? '') &&
      fn.purity === 'pure'
    ) {
      add('idempotence', {
        template: 'idempotence',
        description: `${fn.name}(${fn.name}(x)) equals ${fn.name}(x)`,
        basis: ['name', 'type'],
      });
    }
  }
  return out;
}

function commonNotes(fn: FunctionInfo): string[] {
  const notes = ['inferred from code only; not a specification until reviewed and accepted'];
  if (fn.purity !== 'pure') notes.push(`purity is ${fn.purity}; results may depend on state or I/O`);
  if (fn.unsupported.length > 0) {
    const reasons = [...new Set(fn.unsupported.map((u) => u.reason))].join(', ');
    notes.push(`contains constructs outside the supported subset: ${reasons}`);
  }
  return notes;
}

function roundTripPartner(fn: FunctionInfo, all: FunctionInfo[]): FunctionInfo | null {
  if (fn.params.length !== 1 || fn.purity !== 'pure') return null;
  const local = fn.name.split('.').pop() ?? fn.name;
  for (const [pattern, replacement] of ROUND_TRIP_PAIRS) {
    if (!pattern.test(local)) continue;
    const wanted = local.replace(pattern, replacement);
    const partner = all.find(
      (other) =>
        other !== fn &&
        other.file === fn.file &&
        (other.name.split('.').pop() ?? other.name) === wanted &&
        other.params.length === 1 &&
        other.purity === 'pure' &&
        other.params[0]?.type === fn.returnType &&
        other.returnType === fn.params[0]?.type,
    );
    if (partner) return partner;
  }
  return null;
}

/** Split a printed type on top-level `|`. */
function unionParts(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of type) {
    if ('<([{'.includes(ch)) depth++;
    if ('>)]}'.includes(ch)) depth--;
    if (ch === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

const isArrayType = (t: string) => /\[\]$/.test(t) || /^(Readonly)?Array<.*>$/.test(t);

const isNumericType = (t: string) => t === 'number' || t === 'bigint' || /^-?\d+n?$/.test(t);

const span = (l: { range?: { start: number; end: number } }) => (l.range ? l.range.end - l.range.start : 0);

const stripParens = (s: string) => s.replace(/^\(+|\)+$/g, '').trim();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Changed line ranges per file (new-side line numbers, from `git diff -U0`). */
export type ChangedLines = Record<string, { start: number; end: number }[]>;

/**
 * Mark candidates of functions changed since `ref` with `git_diff` evidence: a change in behaviour there may be
 * intended or a regression, and only a human can tell. A boundary whose comparison line itself changed says so.
 */
export function markChangedCandidates(
  candidates: BehaviorCandidate[],
  index: CodeIndex,
  changed: ChangedLines,
  ref: string,
): BehaviorCandidate[] {
  const touches = (file: string, start: number, end: number) =>
    (changed[file] ?? []).some((r) => r.start <= end && r.end >= start);
  return candidates.map((c) => {
    const fn = index.functions.find((f) => f.symbol === c.symbol);
    const range = fn?.location.range;
    if (!fn || !range || !touches(fn.file, range.start, range.end)) return c;
    const comparisonChanged =
      c.boundary !== undefined &&
      fn.comparisons.some(
        (cmp) =>
          cmp.param === c.boundary?.param &&
          cmp.literal === c.boundary?.value &&
          touches(fn.file, cmp.location.range?.start ?? 0, cmp.location.range?.end ?? 0),
      );
    return {
      ...c,
      basis: c.basis.includes('git_diff') ? c.basis : [...c.basis, 'git_diff'],
      notes: [
        ...c.notes,
        comparisonChanged
          ? `this comparison changed since ${ref}; check whether the boundary moved on purpose`
          : `${fn.name} changed since ${ref}; check whether its behaviour changed on purpose`,
      ],
    };
  });
}

/** Parse `git diff -U0` output into changed new-side line ranges per file (deletions mark the line they follow). */
export function parseChangedLines(diff: string): ChangedLines {
  const out: ChangedLines = {};
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line);
    if (header) {
      file = header[1] ?? null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const ranges = out[file] ?? [];
      out[file] = ranges;
      ranges.push({
        start: Math.max(1, start),
        end: Math.max(1, start + Math.max(count, 1) - 1),
      });
    }
  }
  return out;
}
