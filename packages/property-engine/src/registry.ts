import path from 'node:path';
import type { BehaviorCandidate, CodeIndex, FunctionInfo } from '@under18dev/veritas-code-intelligence';
import {
  type EvidenceSource,
  hashValue,
  type Property,
  type SourceConfidence,
  stableId,
} from '@under18dev/veritas-core';
import type { DiscoveryInput, StatementInput, ThresholdRelation } from './inputs.js';
import { complement, normalizeComparison, type Op, sameInterval, toInterval } from './predicates.js';

export interface ConflictGroup {
  id: string;
  symbol: string;
  param: string;
  propertyIds: string[];
  /** Suggested reading for the human decision; never applied automatically. */
  preferredPropertyId: string | null;
  rationale: string[];
}

export interface MappingNote {
  statementId: string;
  status: 'mapped' | 'unmapped' | 'not_threshold' | 'stale' | 'duplicate';
  symbol: string | null;
  reason: string;
}

export interface Registry {
  properties: Property[];
  conflicts: ConflictGroup[];
  mapping: MappingNote[];
}

/** Crude singular form, so "passes", "orders" and "boxes" match "pass", "order" and "box". */
function singular(w: string): string {
  if (w.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);

  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);

  return w;
}

const words = (text: string): string[] =>
  text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .map(singular);

const QUALITY: Record<EvidenceSource['kind'], SourceConfidence['sourceQuality']> = {
  readme: 'primary',
  docs: 'primary',
  standard: 'primary',
  human: 'primary',
  issue: 'secondary',
  pr: 'secondary',
  web: 'secondary',
  git: 'derived',
  code: 'implementation',
  test: 'implementation',
  runtime: 'implementation',
};

interface Target {
  fn: FunctionInfo;
  param: string;
  score: number;
}

/**
 * Whether a statement is about how many elements an array has: it says count/number of/length/size, or puts
 * the number right before the array's noun ("3 or more items", "at least 2 values") without an ordinal
 * ("the second value" is about one element).
 */
function lengthStatement(quote: string, arrayWords: string[]): boolean {
  if (/\b(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th))\s+\w+/i.test(quote)) return false;

  if (/\b(?:count|number of|length|size|how many)\b/i.test(quote)) return true;

  // "3 or more items", "at least 3 items", "up to 5 values": a number right before the array's noun.
  return arrayWords.some((noun) =>
    new RegExp(`\\d[\\d,]*\\s+(?:or\\s+(?:more|fewer|less)\\s+)?${noun}`, 'i').test(quote),
  );
}

/** Pick the function and parameter a threshold statement talks about, or null when nothing fits clearly. */
/**
 * A parameter type that only holds numbers (`number`, numeric literals, optionally with `undefined` or `null`). A union
 * that also accepts a string or an object (`string | number`) is not modelled as an integer.
 */
export function numberOnly(type: string): boolean {
  if (/[<>()[\]{}&]/.test(type)) return false;
  const members = type
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t !== 'undefined' && t !== 'null');

  return members.length > 0 && members.every((t) => t === 'number' || /^-?\d+(\.\d+)?$/.test(t));
}

/**
 * The functions a statement can be about, from where it was written. A comment in a source file is about a function
 * of that file, the one it documents when it sits right above or inside it. A documentation page named after an
 * exported function (`docs/reference/array/chunk.md`) is about that function. Elsewhere, any exported function.
 */
export function statementScope(
  statement: Pick<StatementInput, 'range' | 'quote'>,
  source: Pick<EvidenceSource, 'kind' | 'locator'> | undefined,
  functions: FunctionInfo[],
): (fn: FunctionInfo) => boolean {
  if (!source) return () => true;
  const locator = source.locator.split('\\').join('/');

  if (source.kind === 'code') {
    // Code sources hold the JSDoc of exported declarations: the statement is about the function whose JSDoc has it.
    const inFile = functions.filter((fn) => fn.file === locator);
    const plain = (text: string) =>
      text
        .replace(/[\s*]+/g, ' ')
        .trim()
        .toLowerCase();
    const quote = plain(statement.quote).slice(0, 80);
    const documented = inFile.filter((fn) => fn.jsdoc !== null && plain(fn.jsdoc).includes(quote));

    if (documented.length > 0) return (fn) => documented.includes(fn);

    // Otherwise the first function declared after it, which its JSDoc block precedes.
    const next = inFile
      .filter((fn) => (fn.location.range?.start ?? 0) >= statement.range.start)
      .sort((a, b) => (a.location.range?.start ?? 0) - (b.location.range?.start ?? 0))[0];

    return next ? (fn) => fn === next : (fn) => fn.file === locator;
  }

  if (source.kind === 'docs' || source.kind === 'readme') {
    const page = path.posix
      .basename(locator)
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    const named = functions.some((fn) => fn.exported && fn.name.toLowerCase() === page);

    if (named) return (fn) => fn.name.toLowerCase() === page;
  }

  return () => true;
}

function mapStatement(
  statement: StatementInput,
  relation: ThresholdRelation,
  index: CodeIndex,
  inScope: (fn: FunctionInfo) => boolean = () => true,
): Target | null {
  const quoteWords = new Set([...words(statement.quote), ...statement.subjects.flatMap(words)]);
  const quantityWords = words(relation.quantity);
  const scored: Target[] = [];

  for (const fn of index.functions) {
    if (!fn.exported || !inScope(fn)) continue;
    // Number parameters, and fields of record parameters the function compares (`order.total`).
    const numeric = [
      ...fn.params.filter((p) => numberOnly(p.type)).map((p) => ({ name: p.name, words: words(p.name) })),
      ...[
        ...new Set(fn.comparisons.map((c) => c.param).filter((n): n is string => n?.includes('.') ?? false)),
      ].map((name) => ({ name, words: words(name.slice(name.indexOf('.') + 1)) })),
    ];

    if (numeric.length === 0) continue;
    const nameHits = words(fn.name).filter((w) => quoteWords.has(w)).length;

    for (const p of numeric) {
      // An array's length only when the statement talks about a count ("3 or more items", "the item count"),
      // never about one element ("the second value") and never on the function name alone.
      if (p.name.endsWith('.length')) {
        const arrayWords = words(p.name.slice(0, -'.length'.length));

        if (!lengthStatement(statement.quote, arrayWords)) continue;
      }
      const paramWords = p.words;
      const paramHit =
        p.name.endsWith('.length') ||
        quantityWords.some((w) => paramWords.includes(w)) ||
        paramWords.some((w) => quoteWords.has(w));
      const compared = fn.comparisons.some((c) => c.param === p.name);
      const score =
        (paramHit ? 2 : 0) +
        nameHits * 2 +
        (compared ? 1 : 0) +
        (numeric.length === 1 && nameHits > 0 ? 1 : 0);

      if (paramHit || nameHits > 0) scored.push({ fn, param: p.name, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;

  if (!best || best.score < 3) return null;

  if (second && second.score === best.score) return null;

  return best;
}

/** Compare the documented predicate with the implementation's comparisons on the same parameter. */
export function implementationAgreement(
  fn: FunctionInfo,
  param: string,
  op: Op,
  value: string,
): Property['implementationAgreement'] {
  const documented = toInterval(op, value);
  let near = false;

  for (const c of fn.comparisons) {
    if (c.param !== param || c.literal === null) continue;
    const paramOnLeft = c.left.trim() === param;
    const codeOp = normalizeComparison(c.operator, paramOnLeft);

    if (!codeOp) continue;
    const code = toInterval(codeOp, c.literal);
    const negated = complement(code);

    if (sameInterval(code, documented) || (negated && sameInterval(negated, documented))) return 'agree';
    const distance = BigInt(c.literal) - BigInt(value);

    if (distance >= -1n && distance <= 1n) near = true;
  }

  return near ? 'disagree' : 'unknown';
}

/** Compare dotted numeric versions (`2.10.0` > `2.9`); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);

    if (d !== 0) return d;
  }

  return 0;
}

function sourceRank(source: EvidenceSource | undefined, statement: StatementInput): number {
  if (!source) return 0;
  let rank = {
    human: 6,
    standard: 5,
    readme: 4,
    docs: 4,
    issue: 3,
    pr: 3,
    web: 2,
    git: 1,
    code: 0,
    test: 0,
    runtime: 0,
  }[source.kind];

  if (
    /\b(decision|decided|supersede|outdated|replaces)\b/i.test(statement.quote) ||
    /\b(decision|outdated)\b/i.test(source.summary)
  ) {
    rank += 3;
  }

  return rank;
}

export interface BuildOptions {
  discovery: DiscoveryInput;
  code: CodeIndex;
  candidates: BehaviorCandidate[];
  /** Previous registry, used to bump versions when a property's content changes. */
  previous?: Property[];
}

/**
 * Build the property registry. Normative statements become `proposed` properties; inferred candidates become
 * experimental `proposed` properties; conflicting claims become `conflicted`. Nothing is ever `accepted` here:
 * only approval records (see approvals.ts) change review status.
 */
export function buildRegistry(options: BuildOptions): Registry {
  const { discovery, code } = options;
  const sources = new Map(discovery.sources.map((s) => [s.id, s]));
  const duplicateOf = new Map(
    discovery.provenance.filter((p) => p.relation === 'duplicate_of').map((p) => [p.from, p.to] as const),
  );
  // Sources that copy statements of another source are not independent evidence for them.
  const derived = new Set(
    discovery.provenance.filter((p) => p.relation === 'derived_from').map((p) => p.from),
  );
  // Sources another source calls outdated. That claim is itself untrusted data: it lowers the source's
  // freshness and its rank as a suggestion, but never removes it from a conflict.
  const supersededBy = new Map<string, string[]>();

  for (const p of discovery.provenance.filter((e) => e.relation === 'supersedes'))
    supersededBy.set(p.to, [...(supersededBy.get(p.to) ?? []), p.from]);
  const mapping: MappingNote[] = [];
  const bySymbolParam = new Map<
    string,
    { property: Property; statement: StatementInput; stale: boolean }[]
  >();
  const properties: Property[] = [];

  for (const statement of discovery.statements) {
    const source = sources.get(statement.sourceId);

    if (statement.relation.kind !== 'threshold') {
      mapping.push({
        statementId: statement.id,
        status: 'not_threshold',
        symbol: null,
        reason: 'free-text statement; kept as evidence only',
      });
      continue;
    }
    const canonical = duplicateOf.get(statement.sourceId) ?? duplicateOf.get(statement.id);

    if (canonical) {
      mapping.push({
        statementId: statement.id,
        status: 'duplicate',
        symbol: null,
        reason: `duplicate of ${canonical}; not counted as independent`,
      });
      continue;
    }
    const relation = statement.relation;
    const target = mapStatement(statement, relation, code, statementScope(statement, source, code.functions));

    if (!target) {
      mapping.push({
        statementId: statement.id,
        status: 'unmapped',
        symbol: null,
        reason: 'no single exported function and parameter clearly matches',
      });
      continue;
    }
    const stale = statement.flags.includes('stale');
    const instructionLike = statement.flags.includes('instruction_like');
    const llmExtracted = statement.flags.includes('llm_extracted');
    const agreement = implementationAgreement(target.fn, target.param, relation.operator, relation.value);
    const citation = `${source?.locator ?? statement.sourceId}:${statement.range.start}`;
    const property: Property = {
      id: stableId('P', {
        symbol: target.fn.symbol,
        param: target.param,
        op: relation.operator,
        value: relation.value,
        statement: statement.id,
      }),
      version: 1,
      description:
        `${target.fn.name}: ${target.param} ${relation.operator} ${relation.value} -> ${relation.consequence}`.slice(
          0,
          500,
        ),
      template: 'boundary',
      targetSymbols: [target.fn.symbol],
      status: 'proposed',
      origin: 'normative',
      sourceIds: [statement.sourceId],
      assumptions: [`the statement at ${citation} refers to ${target.fn.symbol} parameter ${target.param}`],
      inputDomain: { [target.param]: 'integer' },
      formalExpression: `${target.param} ${relation.operator} ${relation.value}`,
      predicate: {
        param: target.param,
        operator: relation.operator,
        value: relation.value,
        consequence: relation.consequence,
      },
      statementIds: [statement.id],
      citations: [citation],
      conflictsWith: [],
      confidence: {
        sourceQuality: source ? QUALITY[source.kind] : 'unknown',
        agreement: 'single_source',
        implementationAlignment: agreement,
        independence:
          source && QUALITY[source.kind] === 'implementation'
            ? 'circular'
            : derived.has(statement.sourceId)
              ? 'derived'
              : 'independent',
        freshness: stale || supersededBy.has(statement.sourceId) ? 'stale' : 'current',
      },
      implementationAgreement: agreement,
      experimental: instructionLike || llmExtracted,
    };

    if (instructionLike)
      property.assumptions.push('source text contains instruction-like content; treated as data only');

    if (llmExtracted)
      property.assumptions.push(
        'threshold read by an LLM from free text; not reproducible, review before accepting',
      );
    properties.push(property);
    mapping.push({
      statementId: statement.id,
      status: stale ? 'stale' : 'mapped',
      symbol: target.fn.symbol,
      reason: `matched ${target.fn.name}(${target.param})`,
    });
    const key = `${target.fn.symbol}#${target.param}`;
    const group = bySymbolParam.get(key) ?? [];
    group.push({ property, statement, stale });
    bySymbolParam.set(key, group);
  }

  const conflicts: ConflictGroup[] = [];

  for (const [key, group] of bySymbolParam) {
    const live = group.filter((g) => !g.stale);
    // Merge claims that say the same thing (same interval) from different sources.
    const distinct = new Map<string, typeof live>();

    for (const g of live) {
      const p = g.property.predicate as NonNullable<Property['predicate']>;
      const iv = toInterval(p.operator, p.value);
      const k = `${iv.lo}:${iv.hi}`;
      distinct.set(k, [...(distinct.get(k) ?? []), g]);
    }

    for (const same of distinct.values()) {
      if (same.length > 1) {
        // Agreement needs two sources that are not copies of each other.
        const independent = new Set(
          same.filter((g) => !derived.has(g.statement.sourceId)).map((g) => g.statement.sourceId),
        );

        for (const g of same) {
          if (independent.size >= 2) g.property.confidence.agreement = 'agree';
          g.property.sourceIds = [...new Set(same.flatMap((s) => s.property.sourceIds))];
        }
      }
    }

    if (distinct.size > 1) {
      const ids = live.map((g) => g.property.id);

      for (const g of live) {
        g.property.status = 'conflicted';
        g.property.conflictsWith = ids.filter((id) => id !== g.property.id);
        g.property.confidence.agreement = 'disagree';
      }
      // A statement from a newer release outranks one from an older release of the same project.
      const versions = live.map((g) => g.statement.version).filter((v): v is string => v !== undefined);
      const newest = versions.length ? versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
      const rankOf = (g: (typeof live)[number]) => {
        const base =
          sourceRank(sources.get(g.statement.sourceId), g.statement) -
          (supersededBy.has(g.statement.sourceId) ? 2 : 0);
        const v = g.statement.version;

        if (!v || !newest || versions.length < 2) return base;

        return base + (compareVersions(v, newest) === 0 ? 2 : -2);
      };
      const ranked = [...live].sort((a, b) => rankOf(b) - rankOf(a));
      const [top, next] = ranked;
      const tie = top && next && rankOf(top) === rankOf(next);
      const [symbol, param] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
      conflicts.push({
        id: stableId('CF', ids.sort()),
        symbol,
        param,
        propertyIds: ids,
        preferredPropertyId: tie || !top ? null : top.property.id,
        rationale: [
          ...live.map(
            (g) =>
              `${g.property.citations[0]}: ${g.property.formalExpression} (${sources.get(g.statement.sourceId)?.kind ?? 'unknown'}${g.statement.version ? `, version ${g.statement.version}` : ''})`,
          ),
          tie || !top
            ? 'no source is clearly preferable; a human decision is required'
            : `suggested: ${top.property.citations[0]} (newer release, higher source rank or an explicit decision/outdated marker); not applied without approval`,
          ...group
            .filter((g) => g.stale)
            .map((g) => `${g.property.citations[0]} is marked stale and was not counted`),
          ...live
            .filter((g) => supersededBy.has(g.statement.sourceId))
            .map(
              (g) =>
                `${g.property.citations[0]} is called outdated by ${(supersededBy.get(g.statement.sourceId) ?? []).map((id) => sources.get(id)?.locator ?? id).join(', ')}; still counted until a human decides`,
            ),
        ],
      });
    }
  }

  for (const candidate of options.candidates) {
    properties.push({
      id: stableId('P', { candidate: candidate.id }),
      version: 1,
      description: candidate.description,
      template: candidate.template,
      targetSymbols: [candidate.symbol],
      status: 'proposed',
      origin: 'inferred',
      sourceIds: [],
      assumptions: [
        'inferred from the implementation; not independent evidence of intended behaviour',
        ...candidate.notes,
      ],
      inputDomain: {},
      ...(candidate.boundary
        ? {
            formalExpression: `${candidate.boundary.param} ${candidate.boundary.operator} ${candidate.boundary.value}`,
          }
        : {}),
      statementIds: [],
      citations: [],
      conflictsWith: [],
      confidence: {
        sourceQuality: 'implementation',
        agreement: 'single_source',
        implementationAlignment: 'agree',
        independence: 'circular',
        freshness: 'current',
      },
      implementationAgreement: 'unknown',
      experimental: true,
    });
  }

  const previous = new Map((options.previous ?? []).map((p) => [p.id, p]));

  for (const p of properties) {
    const before = previous.get(p.id);

    if (before && contentHash(before) !== contentHash(p)) p.version = before.version + 1;
    else if (before) p.version = before.version;
  }

  return { properties, conflicts, mapping };
}

/** Hash of the fields an approval is about; review state and confidence are excluded. */
export function contentHash(p: Property): string {
  return hashValue({
    description: p.description,
    predicate: p.predicate,
    targetSymbols: p.targetSymbols,
    sourceIds: p.sourceIds,
    template: p.template,
  });
}
