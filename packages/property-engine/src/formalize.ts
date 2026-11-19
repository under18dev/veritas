import { readFileSync } from 'node:fs';
import type { FunctionInfo } from '@veritas/code-intelligence';
import {
  type Expr,
  type IntDomain,
  type Property,
  type PropertyIR,
  parseSymbolId,
  resolveInsideRoot,
} from '@veritas/core';
import { thresholdProperty, translateFunction } from '@veritas/formal-core';

export type Formalization =
  | { status: 'formalized'; ir: PropertyIR; assumptions: string[]; file: string; exportName: string }
  | { status: 'not_formalizable'; reason: string };

const POSITIVE = /\b(allow|allowed|accept|accepted|valid|eligible|permitted|pass|may send|can)\b/i;
const NEGATIVE = /\b(reject|rejected|deny|denied|invalid|block|blocked|forbidden|not allowed)\b/i;

/** Integer literals the function can return: the leaves of its translated if/ternary tree. */
function returnLiterals(body: Expr | null): string[] {
  if (!body) return [];
  if (body.kind === 'int') return [body.value];
  if (body.kind === 'ite')
    return [...new Set([...returnLiterals(body.whenTrue), ...returnLiterals(body.whenFalse)])];
  return [];
}

/**
 * Turn a threshold property into IR when the expected result can be read from the statement:
 * - numeric functions: a number in the consequence that the function can return (and an "otherwise" number);
 *   "free" maps to 0 when the function can return 0;
 * - boolean functions: allow/accept wording means true exactly when the threshold holds.
 * Every reading is recorded as an assumption; anything less clear is reported as not formalizable.
 */
export function formalizeProperty(options: {
  root: string;
  property: Property;
  fn: FunctionInfo;
  domain: IntDomain;
  quote?: string;
}): Formalization {
  const { property, fn } = options;
  const predicate = property.predicate;
  if (!predicate) return { status: 'not_formalizable', reason: 'property has no threshold predicate' };
  if (fn.purity !== 'pure')
    return { status: 'not_formalizable', reason: `${fn.symbol} is ${fn.purity}, not pure` };
  const { file, name } = parseSymbolId(fn.symbol);
  const source = readFileSync(resolveInsideRoot(options.root, file), 'utf8');
  const translated = translateFunction({ file, source, exportName: name, domain: options.domain });
  if (translated.status !== 'translated') {
    const reason =
      translated.status === 'unsupported'
        ? translated.reasons.map((r) => `line ${r.line}: ${r.reason}`).join('; ')
        : `${fn.symbol} not found`;
    return { status: 'not_formalizable', reason: `outside the supported subset: ${reason}` };
  }
  const text = `${predicate.consequence} ${options.quote ?? ''}`;
  const assumptions: string[] = [];
  let whenTrue: string | boolean | undefined;
  let whenFalse: string | boolean | undefined;
  if (translated.model.returns === 'bool') {
    if (POSITIVE.test(predicate.consequence) && !NEGATIVE.test(predicate.consequence)) {
      whenTrue = true;
      whenFalse = false;
    } else if (NEGATIVE.test(predicate.consequence)) {
      whenTrue = false;
      whenFalse = true;
    }
    if (whenTrue !== undefined) {
      assumptions.push(
        `formalized as: ${name} returns ${whenTrue} exactly when ${predicate.param} ${predicate.operator} ${predicate.value}`,
      );
    }
  } else {
    const literals = returnLiterals(translated.model.body);
    const numbers = [...predicate.consequence.matchAll(/-?\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ''));
    whenTrue = numbers.find((n) => literals.includes(n) && n !== predicate.value);
    if (whenTrue === undefined && /\bfree\b/i.test(predicate.consequence) && literals.includes('0'))
      whenTrue = '0';
    const otherwise = /otherwise[^.]*?(-?\d[\d,]*)/i.exec(text)?.[1]?.replace(/,/g, '');
    if (otherwise && literals.includes(otherwise)) whenFalse = otherwise;
    else if (
      whenTrue !== undefined &&
      literals.length === 2 &&
      literals.includes('0') &&
      whenTrue !== '0' &&
      /\bdiscount|bonus|fee|charge\b/i.test(text)
    ) {
      whenFalse = '0';
      assumptions.push(
        `assumed: ${name} returns 0 when the condition does not hold (only other literal it returns)`,
      );
    }
    if (whenTrue !== undefined) {
      assumptions.push(
        `formalized as: ${predicate.param} ${predicate.operator} ${predicate.value} implies ${name}(...) == ${whenTrue}` +
          (whenFalse !== undefined ? `, otherwise ${whenFalse}` : ''),
      );
    }
  }
  if (whenTrue === undefined) {
    return {
      status: 'not_formalizable',
      reason: `cannot read the expected result of ${name} from "${predicate.consequence}"`,
    };
  }
  const ir = thresholdProperty({
    implementation: translated,
    param: predicate.param,
    operator: predicate.operator,
    value: predicate.value,
    whenTrue,
    ...(whenFalse !== undefined ? { whenFalse } : {}),
    domain: options.domain,
  });
  return { status: 'formalized', ir, assumptions, file, exportName: name };
}
