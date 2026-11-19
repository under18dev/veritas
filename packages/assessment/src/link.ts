import type { FunctionInfo } from '@veritas/code-intelligence';
import type { Mutant, Property, TestCase, TestPropertyEdge } from '@veritas/core';
import { stableId } from '@veritas/core';

function inRange(line: number, fn: FunctionInfo): boolean {
  const range = fn.location.range;
  return range !== undefined && line >= range.start && line <= range.end;
}

/** The function enclosing a mutant, by file and line. */
export function enclosingFunction(mutant: Mutant, functions: FunctionInfo[]): FunctionInfo | undefined {
  const line = mutant.location.range?.start;
  if (line === undefined) return undefined;
  return functions.find((f) => f.file === mutant.location.file && inRange(line, f));
}

/**
 * A mutant is relevant to a property when it sits in a target function and touches the line of a comparison on
 * the property's parameter, or (without a predicate) anywhere in a target function. Otherwise it is unrelated.
 */
export function linkMutants(mutants: Mutant[], properties: Property[], functions: FunctionInfo[]): Mutant[] {
  return mutants.map((m) => {
    const fn = enclosingFunction(m, functions);
    if (!fn) return { ...m, relevance: 'unknown' as const, propertyIds: [] };
    const line = m.location.range?.start;
    const related = properties.filter((p) => {
      if (!p.targetSymbols.includes(fn.symbol) || p.status === 'rejected' || p.status === 'superseded')
        return false;
      if (!p.predicate) return true;
      const param = p.predicate.param;
      return (
        fn.comparisons.some((c) => c.param === param && c.location.range?.start === line) ||
        m.original.includes(param)
      );
    });
    return {
      ...m,
      relevance: related.length > 0 ? ('spec_relevant' as const) : ('unrelated' as const),
      propertyIds: related.map((p) => p.id),
    };
  });
}

/**
 * Attach property ids to test-symbol edges. Evidence kinds come from the inventory (static call, direct assertion)
 * plus mutation evidence when the test killed a mutant relevant to the property. Names alone never link.
 */
export function linkTests(
  tests: TestCase[],
  edges: TestPropertyEdge[],
  properties: Property[],
  mutants: Mutant[],
): TestPropertyEdge[] {
  const out: TestPropertyEdge[] = [];
  const testsById = new Map(tests.map((t) => [t.id, t]));
  for (const edge of edges) {
    const targeted = properties.filter((p) => p.targetSymbols.includes(edge.symbol));
    if (targeted.length === 0) {
      out.push(edge);
      continue;
    }
    for (const p of targeted) {
      const kills = mutants.filter((m) => m.killedBy.includes(edge.testId) && m.propertyIds.includes(p.id));
      const evidence = [...edge.evidence];
      if (kills.length > 0) {
        evidence.push({
          kind: 'mutation_evidence',
          detail: `killed ${kills.length} mutant(s) relevant to this property`,
          artifactIds: kills.map((k) => k.id),
        });
      }
      out.push({
        ...edge,
        id: stableId('E', { test: edge.testId, symbol: edge.symbol, property: p.id }),
        propertyId: p.id,
        evidence,
      });
    }
  }
  return out.filter((e) => testsById.has(e.testId));
}
