import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assessTests, deriveFindings, linkMutants, linkTests } from '@veritas/assessment';
import { analyzeCode, type CodeIndex, inferBehaviorCandidates } from '@veritas/code-intelligence';
import {
  type Capability,
  evaluatePolicy,
  type Finding,
  type FormalClaim,
  hashValue,
  type Mutant,
  newRunId,
  type PolicyDecision,
  type Property,
  type Run,
  RunStore,
  runDoctor,
  runStages,
  type Stage,
  type StageName,
  type StageResult,
  stableId,
} from '@veritas/core';
import { applyMutation, equivalenceProperty, proveProperty, translateFunction } from '@veritas/formal-core';
import { runMutation } from '@veritas/mutation-adapter';
import { applyApprovals, buildRegistry, formalizeProperty, loadApprovals } from '@veritas/property-engine';
import { type PbtResult, runPropertyTest } from '@veritas/property-testing';
import { type DiscoveryResult, discoverEvidence } from '@veritas/spec-discovery';
import { inventoryTests, type TestInventory } from '@veritas/test-inventory';
import { ARTIFACTS } from './artifacts.js';
import { defaultSeed, latestRunWith, openProject, readArtifact } from './project.js';

export type Profile = 'quick' | 'standard' | 'deep';

export interface RunOptions {
  root: string;
  command: string;
  args?: string[];
  /** Stages to run; dependencies earlier in the list are run too. */
  stages: StageName[];
  profile?: Profile;
  offline?: boolean;
  since?: string;
  scope?: string[];
  /** Verify proposed (not yet accepted) properties as experimental. Accepted ones are always verified. */
  includeProposed?: boolean;
  propertyIds?: string[];
  allowCodeConfig?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface RunSummary {
  runId: string;
  dir: string;
  run: Run;
  findings: Finding[];
  decision: PolicyDecision;
}

export const PROFILE_STAGES: Record<Profile, StageName[]> = {
  quick: ['index', 'discover', 'spec', 'map', 'assess', 'report'],
  standard: ['index', 'discover', 'spec', 'map', 'mutate', 'assess', 'report'],
  deep: ['index', 'discover', 'spec', 'map', 'mutate', 'pbt', 'prove', 'assess', 'report'],
};

interface SpecOutput {
  properties: Property[];
  formalized: Map<
    string,
    { ir: import('@veritas/core').PropertyIR; assumptions: string[]; file: string; exportName: string }
  >;
  conflicts: import('@veritas/property-engine').ConflictGroup[];
}

function previousProperties(root: string): Property[] {
  const runId = latestRunWith(root, 'properties');
  if (!runId) return [];
  try {
    return readArtifact(root, runId, 'properties').data.properties;
  } catch {
    return [];
  }
}

/** Run the requested stages and persist every artifact under `.veritas/runs/<run-id>/`. */
export async function runVeritas(options: RunOptions): Promise<RunSummary> {
  const { root } = options;
  const log = options.log ?? (() => {});
  const { config, configHash } = await openProject(root, { allowCodeConfig: options.allowCodeConfig });
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const code0 = analyzeCode({ root, config });
  const sourceHash = hashValue(code0.files);
  const store = new RunStore(root, runId, { configHash, sourceHash });
  const signal = options.signal ?? new AbortController().signal;
  const wanted = new Set(options.stages);
  const domain = config.formal.integerDomain;
  const claims: FormalClaim[] = [];
  let mutants: Mutant[] = [];
  let mutationAvailable = false;
  let findings: Finding[] = [];
  const pbtResults: PbtResult[] = [];
  const seeds: Record<string, number> = {};

  const stages: Stage[] = [];
  const add = (stage: Stage) => wanted.has(stage.name) && stages.push(stage);

  add({
    name: 'index',
    dependsOn: [],
    run: async () => {
      const candidates = inferBehaviorCandidates(code0);
      return {
        status: 'succeeded',
        output: { code: code0, candidates },
        artifacts: [store.write(ARTIFACTS.codeIndex.file, ARTIFACTS.codeIndex.schema, code0)],
        messages: [
          `${code0.functions.length} function(s) in ${code0.files.length} file(s); ${candidates.length} inferred candidate(s)`,
        ],
      };
    },
  });
  add({
    name: 'discover',
    dependsOn: [],
    run: async () => {
      const result = await discoverEvidence({ root, config, offline: options.offline ?? false });
      const messages = [
        `${result.sources.length} source(s), ${result.statements.length} statement(s), ${result.networkRequests} network request(s)`,
      ];
      for (const s of result.skipped) messages.push(`skipped ${s.source}: ${s.reason}`);
      return {
        status: 'succeeded',
        output: result,
        artifacts: [store.write(ARTIFACTS.evidence.file, ARTIFACTS.evidence.schema, result)],
        messages,
      };
    },
  });
  add({
    name: 'spec',
    dependsOn: ['index', 'discover'],
    run: async (ctx) => {
      const index = ctx.outputs.get('index') as {
        code: CodeIndex;
        candidates: ReturnType<typeof inferBehaviorCandidates>;
      };
      const discovery = ctx.outputs.get('discover') as DiscoveryResult;
      const registry = buildRegistry({
        discovery,
        code: index.code,
        candidates: index.candidates,
        previous: previousProperties(root),
      });
      const applied = applyApprovals(registry.properties, loadApprovals(root));
      const formalized: SpecOutput['formalized'] = new Map();
      const formalization: {
        propertyId: string;
        status: 'formalized' | 'not_formalizable';
        detail: string;
      }[] = [];
      for (const p of applied.properties) {
        if (!p.predicate || p.targetSymbols.length !== 1) continue;
        const fn = index.code.functions.find((f) => f.symbol === p.targetSymbols[0]);
        if (!fn) continue;
        const quote = discovery.statements.find((s) => p.statementIds.includes(s.id))?.quote;
        const result = formalizeProperty({ root, property: p, fn, domain, ...(quote ? { quote } : {}) });
        if (result.status === 'formalized') {
          formalized.set(p.id, result);
          p.ir = result.ir;
          p.assumptions = [...p.assumptions, ...result.assumptions];
          formalization.push({
            propertyId: p.id,
            status: 'formalized',
            detail: result.assumptions.join('; '),
          });
        } else {
          formalization.push({ propertyId: p.id, status: 'not_formalizable', detail: result.reason });
        }
      }
      const artifact = store.write(ARTIFACTS.properties.file, ARTIFACTS.properties.schema, {
        properties: applied.properties,
        conflicts: registry.conflicts,
        mapping: registry.mapping,
        formalization,
        staleApprovals: applied.staleApprovals.map((a) => a.id),
      });
      const counts = applied.properties.reduce<Record<string, number>>(
        (acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }),
        {},
      );
      return {
        status: 'succeeded',
        output: {
          properties: applied.properties,
          formalized,
          conflicts: registry.conflicts,
        } satisfies SpecOutput,
        artifacts: [artifact],
        messages: [`properties: ${JSON.stringify(counts)}; ${registry.conflicts.length} conflict(s)`],
      };
    },
  });
  add({
    name: 'map',
    dependsOn: [],
    run: async () => {
      const inventory = inventoryTests({ root, config });
      return {
        status: 'succeeded',
        output: inventory,
        messages: [`${inventory.tests.length} test(s), ${inventory.edges.length} symbol edge(s)`],
      };
    },
  });
  add({
    name: 'mutate',
    dependsOn: [],
    run: async () => {
      const result = await runMutation({
        root,
        config,
        reportDir: store.pathFor('mutation'),
        signal,
        ...(options.since ? { since: options.since } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
      });
      mutants = result.mutants;
      mutationAvailable = result.status === 'succeeded';
      const status =
        result.status === 'succeeded'
          ? 'succeeded'
          : result.status === 'unsupported'
            ? 'unsupported'
            : result.status;
      return {
        status,
        output: result,
        usage: { mutants: result.mutants.length },
        messages: [
          `mutator ${result.backend.version ?? 'unknown'}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`,
          `counts: ${JSON.stringify(Object.fromEntries(Object.entries(result.counts).filter(([, n]) => n > 0)))}`,
          ...result.warnings,
        ],
      };
    },
  });
  const eligible = (spec: SpecOutput) =>
    spec.properties.filter(
      (p) =>
        spec.formalized.has(p.id) &&
        (options.propertyIds ? options.propertyIds.includes(p.id) : true) &&
        (p.status === 'accepted' ||
          (options.includeProposed &&
            (p.status === 'proposed' || p.status === 'reviewed' || p.status === 'conflicted'))),
    );
  add({
    name: 'pbt',
    dependsOn: ['spec'],
    run: async (ctx) => {
      const spec = ctx.outputs.get('spec') as SpecOutput;
      const messages: string[] = [];
      for (const p of eligible(spec)) {
        const f = spec.formalized.get(p.id);
        if (!f) continue;
        // A fixed default seed per property keeps runs reproducible; config.pbt.seed overrides it.
        const seed = config.pbt.seed ?? defaultSeed(p.id);
        seeds[`pbt:${p.id}`] = seed;
        const result = await runPropertyTest({
          root,
          propertyId: p.id,
          ir: f.ir,
          bindings: [
            { modelName: f.exportName, modulePath: path.join(root, f.file), exportName: f.exportName },
          ],
          seed,
          numRuns: config.pbt.numRuns,
          timeoutMs: Math.max(30_000, config.formal.maxSolverMs),
          experimental: p.status !== 'accepted',
          store,
          signal,
        });
        pbtResults.push(result);
        messages.push(
          `${p.id}: ${result.status}${result.counterexample ? ` ${JSON.stringify(result.counterexample)} (seed ${seed})` : ''}`,
        );
      }
      store.write(ARTIFACTS.pbt.file, ARTIFACTS.pbt.schema, pbtResults);
      const bad = pbtResults.filter(
        (r) => r.status === 'error' || r.status === 'timeout' || r.status === 'cancelled',
      );
      return {
        status: bad.length ? 'partial' : 'succeeded',
        artifacts: [ARTIFACTS.pbt.file],
        usage: { testRuns: pbtResults.reduce((n, r) => n + (r.runsExecuted ?? 0), 0) },
        messages: messages.length ? messages : ['no property eligible for property-based testing'],
      };
    },
  });
  add({
    name: 'prove',
    dependsOn: ['spec'],
    run: async (ctx) => {
      const spec = ctx.outputs.get('spec') as SpecOutput;
      const messages: string[] = [];
      let solverMs = 0;
      const toProve = eligible(spec);
      for (const p of toProve) {
        const f = spec.formalized.get(p.id);
        if (!f) continue;
        const { claim } = await proveProperty({
          kind: 'conformance',
          propertyId: p.id,
          ir: f.ir,
          root,
          bindings: [
            { modelName: f.exportName, modulePath: path.join(root, f.file), exportName: f.exportName },
          ],
          timeoutMs: config.formal.maxSolverMs,
          store,
          signal,
          assumptions:
            p.status === 'accepted'
              ? []
              : [`property ${p.id} is ${p.status}, not accepted: experimental check`],
        });
        claims.push(claim);
        solverMs += claim.durationMs;
        messages.push(
          `${p.id}: ${claim.status}${claim.counterexample ? ` ${JSON.stringify(claim.counterexample)}` : ''}`,
        );
      }
      const skipped = spec.properties.filter((p) => spec.formalized.has(p.id) && !toProve.includes(p));
      if (skipped.length)
        messages.push(
          `${skipped.length} formalized propert(y/ies) not verified: not accepted (use --include-proposed)`,
        );
      // Survived mutants in translatable functions: bounded equivalence or a distinguishing input.
      for (const m of mutants.filter((m) => m.status === 'survived')) {
        const relevant = spec.properties.filter(
          (p) => spec.formalized.has(p.id) && m.location.file === spec.formalized.get(p.id)?.file,
        );
        const target = relevant[0] ? spec.formalized.get(relevant[0].id) : undefined;
        const line = m.location.range?.start;
        if (!target || line === undefined) continue;
        const source = readFileSync(path.join(root, target.file), 'utf8');
        const column = (source.split('\n')[line - 1] ?? '').indexOf(m.original) + 1;
        if (column <= 0) continue;
        let mutated: string;
        try {
          mutated = applyMutation(source, { line, column, original: m.original, replacement: m.replacement });
        } catch {
          continue;
        }
        const orig = translateFunction({
          file: target.file,
          source,
          exportName: target.exportName,
          domain,
          modelName: 'original',
        });
        const mut = translateFunction({
          file: target.file,
          source: mutated,
          exportName: target.exportName,
          domain,
          modelName: 'mutant',
        });
        if (orig.status !== 'translated' || mut.status !== 'translated') continue;
        const { claim } = await proveProperty({
          kind: 'bounded_equivalence',
          propertyId: relevant[0]?.id as string,
          ir: equivalenceProperty(orig, mut, domain),
          root,
          bindings: [
            {
              modelName: 'original',
              modulePath: path.join(root, target.file),
              exportName: target.exportName,
            },
          ],
          timeoutMs: config.formal.maxSolverMs,
          store,
          signal,
          mutantId: m.id,
        });
        claims.push(claim);
        solverMs += claim.durationMs;
        if (claim.status === 'proven_within_model') {
          m.status = 'equivalent_proven';
          m.statusReason = `bounded equivalence within ${JSON.stringify(domain)} (${claim.id})`;
        }
        messages.push(
          `mutant ${m.id}: ${claim.status}${claim.counterexample ? ` distinguishing input ${JSON.stringify(claim.counterexample)}` : ''}`,
        );
      }
      store.write(ARTIFACTS.claims.file, ARTIFACTS.claims.schema, claims);
      const undecided = claims.filter(
        (c) => c.status === 'timeout' || c.status === 'unknown' || c.status === 'error',
      );
      return {
        status: undecided.length ? 'partial' : 'succeeded',
        usage: { solverMs },
        artifacts: [ARTIFACTS.claims.file],
        messages: messages.length ? messages : ['no property eligible for verification'],
      };
    },
  });
  add({
    name: 'assess',
    dependsOn: ['spec', 'map'],
    run: async (ctx) => {
      const spec = ctx.outputs.get('spec') as SpecOutput;
      const inventory = ctx.outputs.get('map') as TestInventory;
      const index = ctx.outputs.get('index') as { code: CodeIndex } | undefined;
      const functions = index?.code.functions ?? code0.functions;
      const linkedMutants = linkMutants(mutants, spec.properties, functions);
      const edges = linkTests(inventory.tests, inventory.edges, spec.properties, linkedMutants);
      const assessments = assessTests({
        tests: inventory.tests,
        edges,
        properties: spec.properties,
        mutants: linkedMutants,
        claims,
        functions,
        mutationAvailable,
      });
      findings = deriveFindings({
        properties: spec.properties,
        conflicts: spec.conflicts,
        claims,
        mutants: linkedMutants,
        tests: inventory.tests,
        assessments,
        functions,
      });
      for (const r of pbtResults.filter((r) => r.status === 'counterexample')) {
        const p = spec.properties.find((x) => x.id === r.propertyId);
        findings.push({
          id: stableId('F', { kind: 'counterexample', pbt: r.id }),
          kind: 'counterexample',
          title: `property-based test found ${JSON.stringify(r.counterexample)} violating "${p?.formalExpression ?? r.propertyId}"`,
          severity: 'high',
          certainty: p?.status === 'accepted' ? 'confirmed' : 'suspected',
          locations: [],
          propertyIds: [r.propertyId],
          sourceIds: p?.sourceIds ?? [],
          testIds: [],
          mutantIds: [],
          claimIds: [],
          explanation: [
            `fast-check seed ${r.seed}, shrunk after ${r.shrinks} step(s): ${r.failure?.reason ?? 'property failed'}`,
            `replay: ${r.replayCommand}`,
            ...(p?.status === 'accepted'
              ? []
              : [`property is ${p?.status ?? 'unknown'}; experimental check`]),
          ],
          nextActions: [
            'add the counterexample as a regression test once the intended behaviour is confirmed',
          ],
        });
      }
      findings.sort((a, b) => a.id.localeCompare(b.id));
      const artifacts = [
        store.write(ARTIFACTS.testMap.file, ARTIFACTS.testMap.schema, { ...inventory, edges }),
        store.write(ARTIFACTS.assessments.file, ARTIFACTS.assessments.schema, assessments),
        store.write(ARTIFACTS.findings.file, ARTIFACTS.findings.schema, findings),
      ];
      if (wanted.has('mutate')) {
        const mutation = ctx.outputs.get('mutate') as
          | import('@veritas/mutation-adapter').MutationRunResult
          | undefined;
        if (mutation)
          artifacts.push(
            store.write(ARTIFACTS.mutation.file, ARTIFACTS.mutation.schema, {
              ...mutation,
              mutants: linkedMutants,
            }),
          );
      }
      const outcomes = assessments.reduce<Record<string, number>>(
        (acc, a) => ({ ...acc, [a.outcome]: (acc[a.outcome] ?? 0) + 1 }),
        {},
      );
      return {
        status: 'succeeded',
        artifacts,
        messages: [`assessments: ${JSON.stringify(outcomes)}; ${findings.length} finding(s)`],
      };
    },
  });
  add({
    name: 'report',
    dependsOn: [],
    run: async () => ({ status: 'succeeded', messages: ['artifacts written'] }),
  });

  const results: StageResult[] = await runStages(stages, { root, config, store, signal, log });
  const capabilities: Capability[] = (await runDoctor(root, config)).capabilities;
  const decision = evaluatePolicy(config.policy, findings, results, claims);
  const usage = results.reduce(
    (acc, r) => ({
      llmTokens: acc.llmTokens + r.usage.llmTokens,
      solverMs: acc.solverMs + r.usage.solverMs,
      mutants: acc.mutants + r.usage.mutants,
      testRuns: acc.testRuns + r.usage.testRuns,
    }),
    { llmTokens: 0, solverMs: 0, mutants: 0, testRuns: 0 },
  );
  const run: Run = {
    id: runId,
    command: options.command,
    args: options.args ?? [],
    ...(options.profile ? { profile: options.profile } : {}),
    scope: { root, ...(options.since ? { since: options.since } : {}), paths: options.scope ?? [] },
    startedAt,
    finishedAt: new Date().toISOString(),
    status: results.every((r) => r.status === 'succeeded')
      ? 'succeeded'
      : results.some((r) => r.status === 'error' || r.status === 'failed')
        ? 'error'
        : 'partial',
    exitCode: decision.exitCode,
    verdict: decision.verdict,
    policyReasons: decision.reasons,
    stages: results,
    capabilities,
    environment: { os: process.platform, arch: process.arch, node: process.versions.node },
    seeds,
    usage,
    replay: `veritas replay ${runId}`,
    partial: results.some((r) => r.status !== 'succeeded'),
  };
  store.write(ARTIFACTS.run.file, ARTIFACTS.run.schema, run);
  log(`run ${runId}: ${decision.verdict}`);
  return { runId, dir: store.dir, run, findings, decision };
}
