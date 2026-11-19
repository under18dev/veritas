import type { FunctionInfo } from '@under18dev/veritas-code-intelligence';
import {
  type Finding,
  type FormalClaim,
  type Location,
  type Mutant,
  type Property,
  stableId,
  type TestAssessment,
  type TestCase,
} from '@under18dev/veritas-core';
import type { ConflictGroup } from '@under18dev/veritas-property-engine';

export interface FindingInput {
  properties: Property[];
  conflicts: ConflictGroup[];
  claims: FormalClaim[];
  mutants: Mutant[];
  tests: TestCase[];
  assessments: TestAssessment[];
  functions: FunctionInfo[];
}

function functionLocation(symbol: string, functions: FunctionInfo[]): Location[] {
  const fn = functions.find((f) => f.symbol === symbol);
  return fn ? [fn.location] : [];
}

/**
 * Derive findings. Certainty is `confirmed` only when a replayed solver counterexample backs the finding and the
 * property is accepted; otherwise it is `suspected` (or `informational`). Survivors are test gaps, not bugs.
 */
export function deriveFindings(input: FindingInput): Finding[] {
  const findings: Finding[] = [];
  const claimsFor = (propertyId: string) =>
    input.claims.filter((c) => c.propertyId === propertyId && c.kind === 'conformance');

  for (const p of input.properties) {
    // A rejected or superseded reading is no longer a specification, so it cannot be violated.
    if (p.origin !== 'normative' || p.status === 'rejected' || p.status === 'superseded') continue;
    const claims = claimsFor(p.id);
    const cex = claims.find(
      (c) => c.status === 'counterexample_found' && c.semanticValidation === 'confirmed',
    );
    if (p.implementationAgreement !== 'disagree' && !cex) continue;
    const accepted = p.status === 'accepted';
    const certainty: Finding['certainty'] = cex && accepted ? 'confirmed' : 'suspected';
    const explanation = [
      `documented: ${p.formalExpression} (${p.citations.join(', ') || 'no citation'})`,
      p.implementationAgreement === 'disagree'
        ? 'implementation compares the same parameter against a different boundary'
        : 'implementation comparison not matched statically',
    ];
    if (cex)
      explanation.push(
        `solver counterexample ${JSON.stringify(cex.counterexample)} reproduced in JavaScript (${cex.id})`,
      );
    if (!accepted)
      explanation.push(`property status is ${p.status}; accept it to make this a confirmed violation`);
    findings.push({
      id: stableId('F', { kind: 'spec_implementation_mismatch', property: p.id }),
      kind: 'spec_implementation_mismatch',
      title: cex
        ? `${p.targetSymbols.join(', ')} does not satisfy "${p.formalExpression}" for ${JSON.stringify(cex.counterexample)} (within the model)`
        : `${p.targetSymbols.join(', ')} may not satisfy "${p.formalExpression}"`,
      severity: cex ? 'high' : 'medium',
      certainty,
      locations: p.targetSymbols.flatMap((s) => functionLocation(s, input.functions)),
      propertyIds: [p.id],
      sourceIds: p.sourceIds,
      testIds: [],
      mutantIds: [],
      claimIds: claims.map((c) => c.id),
      explanation,
      nextActions: accepted
        ? [
            'fix the implementation or change the specification through review',
            'add a test for the counterexample input',
          ]
        : [
            `review the property: veritas spec accept ${p.id} --reason "..." or veritas spec reject ${p.id} --reason "..."`,
          ],
    });
  }

  for (const c of input.conflicts) {
    findings.push({
      id: stableId('F', { kind: 'spec_conflict', conflict: c.id }),
      kind: 'spec_conflict',
      title: `conflicting specifications for ${c.symbol} (${c.param})`,
      severity: 'medium',
      certainty: 'confirmed',
      locations: functionLocation(c.symbol, input.functions),
      propertyIds: c.propertyIds,
      sourceIds: input.properties.filter((p) => c.propertyIds.includes(p.id)).flatMap((p) => p.sourceIds),
      testIds: [],
      mutantIds: [],
      claimIds: [],
      explanation: c.rationale,
      nextActions: ['decide which reading is intended: veritas spec accept <id> --reason "..."'],
    });
  }

  for (const claim of input.claims) {
    if (claim.status === 'unsupported' || claim.status === 'semantic_mismatch') {
      findings.push({
        id: stableId('F', { kind: 'unsupported_semantics', claim: claim.id }),
        kind: 'unsupported_semantics',
        title: `formal check ${claim.status} for ${claim.propertyId}`,
        severity: 'info',
        certainty: 'informational',
        locations: [],
        propertyIds: [claim.propertyId],
        sourceIds: [],
        testIds: [],
        mutantIds: claim.mutantId ? [claim.mutantId] : [],
        claimIds: [claim.id],
        explanation: [...claim.semanticGaps, ...claim.assumptions.slice(-2)],
        nextActions: ['rely on tests and mutation results for this property; the model does not cover it'],
      });
    }
  }

  for (const m of input.mutants) {
    if (m.status !== 'survived' || m.relevance !== 'spec_relevant') continue;
    const distinguishing = input.claims.find(
      (c) => c.mutantId === m.id && c.status === 'counterexample_found',
    );
    findings.push({
      id: stableId('F', { kind: 'survived_mutant', mutant: m.id }),
      kind: 'survived_mutant',
      title: `no test detects ${m.original} -> ${m.replacement} at ${m.location.file}:${m.location.range?.start}`,
      severity: 'medium',
      certainty: 'confirmed',
      locations: [m.location],
      propertyIds: m.propertyIds,
      sourceIds: [],
      testIds: m.coveredBy,
      mutantIds: [m.id],
      claimIds: distinguishing ? [distinguishing.id] : [],
      explanation: [
        'the mutant survived: this is a test gap candidate, not proof of a bug or of equivalence',
        ...(distinguishing
          ? [`input distinguishing it from the original: ${JSON.stringify(distinguishing.counterexample)}`]
          : []),
        `covered by ${m.coveredBy.length} test(s); reproduce with: ${m.reproduction}`,
      ],
      nextActions: distinguishing
        ? [
            `add a test with input ${JSON.stringify(distinguishing.counterexample)} asserting the specified result`,
          ]
        : ['add a test input on the boundary, or show equivalence with veritas prove'],
    });
  }

  const testsById = new Map(input.tests.map((t) => [t.id, t]));
  for (const a of input.assessments) {
    if (a.outcome !== 'tautological_or_disconnected') continue;
    const t = testsById.get(a.testId);
    findings.push({
      id: stableId('F', { kind: 'tautological_test', test: a.testId }),
      kind: 'tautological_test',
      title: `test "${t?.name ?? a.testId}" does not check project behaviour`,
      severity: 'low',
      certainty: 'suspected',
      locations: t ? [t.location] : [],
      propertyIds: [],
      sourceIds: [],
      testIds: [a.testId],
      mutantIds: [],
      claimIds: [],
      explanation: a.rationale,
      nextActions: ['assert on the result of the function under test, or remove the test'],
    });
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
