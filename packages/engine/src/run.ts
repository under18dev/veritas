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
  resolveInsideRoot,
  runDoctor,
  runStages,
  type Stage,
  type StageName,
  type StageResult,
  stableId,
  toPosixRelative,
  VeritasError,
} from '@veritas/core';
import { applyMutation, equivalenceProperty, proveProperty, translateFunction } from '@veritas/formal-core';
import { LlmClient, type LlmProvider } from '@veritas/llm';
import { ClaudeProvider } from '@veritas/llm-claude';
import { runMutation } from '@veritas/mutation-adapter';
import { applyApprovals, buildRegistry, formalizeProperty, loadApprovals } from '@veritas/property-engine';
import { type PbtResult, runPropertyTest } from '@veritas/property-testing';
import { proveWithLean } from '@veritas/solver-lean';
import { type DiscoveryResult, discoverEvidence } from '@veritas/spec-discovery';
import { inventoryTests, type TestInventory } from '@veritas/test-inventory';
import { ARTIFACTS } from './artifacts.js';
import { extractWithLlm } from './llm-extract.js';
import { defaultSeed, latestRunWith, openProject, readArtifact } from './project.js';
import { buildReportInput, REPORT_FILES, renderReport } from './report.js';

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
  /** Formal backend for conformance claims (mutant equivalence always uses Z3). */
  formalEngine?: 'z3' | 'lean';
  propertyIds?: string[];
  allowCodeConfig?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Injected LLM provider (tests). By default Claude is used only when configured and a key is present. */
  llmProvider?: LlmProvider | null;
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
  /** Properties with a predicate that could not be formalized, with the reason. */
  notFormalized: Map<string, string>;
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

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Run the requested stages and persist every artifact under `.veritas/runs/<run-id>/`. */
export async function runVeritas(options: RunOptions): Promise<RunSummary> {
  const { root } = options;
  const log = options.log ?? (() => {});
  const { config, configHash } = await openProject(root, { allowCodeConfig: options.allowCodeConfig });
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  // Scope entries must stay inside the project; `..`, absolute paths elsewhere and escaping symlinks are refused.
  const scopePrefixes = (options.scope ?? []).map((entry) => {
    if (/[*?[\]{}]/.test(entry)) {
      if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
        throw new VeritasError('user', 'SCOPE_OUTSIDE_ROOT', `scope escapes the project root: ${entry}`);
      }
      return null;
    }
    return toPosixRelative(root, resolveInsideRoot(root, entry));
  });
  const fullIndex = analyzeCode({ root, config });
  const prefixes = scopePrefixes.filter((p): p is string => p !== null);
  const inScope = (file: string) =>
    prefixes.length === 0 || prefixes.some((p) => p === '' || file === p || file.startsWith(`${p}/`));
  const code0 = {
    ...fullIndex,
    functions: fullIndex.functions.filter((f) => inScope(f.file)),
    files: fullIndex.files.filter((f) => inScope(f.path)),
  };
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
      let llmTokens = 0;
      const llmMessages: string[] = [];
      const provider =
        options.llmProvider !== undefined
          ? options.llmProvider
          : config.llm.provider === 'claude' && process.env.ANTHROPIC_API_KEY
            ? new ClaudeProvider({ ...(config.llm.model ? { model: config.llm.model } : {}) })
            : null;
      if (provider && options.offline) llmMessages.push('llm: skipped because the run is offline');
      else if (provider) {
        const client = new LlmClient(provider, {
          tokenBudget: config.llm.maxTokensPerRun,
          sendFullText: config.sources.sendFullTextToLlm,
        });
        const extracted = await extractWithLlm(client, result, signal);
        result.statements.push(...extracted.added);
        llmTokens = extracted.tokens;
        llmMessages.push(...extracted.messages);
      } else if (config.llm.provider !== 'none') {
        llmMessages.push(`llm: ${config.llm.provider} configured but no API key; rule-based results only`);
      }
      const messages = [
        ...llmMessages,
        `${result.sources.length} source(s), ${result.statements.length} statement(s), ${result.networkRequests} network request(s)`,
      ];
      for (const s of result.skipped) messages.push(`skipped ${s.source}: ${s.reason}`);
      return {
        status: 'succeeded',
        output: result,
        artifacts: [store.write(ARTIFACTS.evidence.file, ARTIFACTS.evidence.schema, result)],
        usage: { llmTokens },
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
      const notFormalized: SpecOutput['notFormalized'] = new Map();
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
          notFormalized.set(p.id, result.reason);
        }
      }
      const artifact = store.write(ARTIFACTS.properties.file, ARTIFACTS.properties.schema, {
        properties: applied.properties,
        conflicts: registry.conflicts,
        mapping: registry.mapping,
        formalization,
        staleApprovals: applied.staleApprovals.map((a) => a.id),
      });
      const counts = tally(applied.properties.map((p) => p.status));
      return {
        status: 'succeeded',
        output: {
          properties: applied.properties,
          formalized,
          notFormalized,
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
  const wantedStatus = (p: Property) =>
    (options.propertyIds ? options.propertyIds.includes(p.id) : true) &&
    (p.status === 'accepted' ||
      (Boolean(options.includeProposed) &&
        (p.status === 'proposed' || p.status === 'reviewed' || p.status === 'conflicted')));
  const eligible = (spec: SpecOutput) =>
    spec.properties.filter((p) => spec.formalized.has(p.id) && wantedStatus(p));
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
      // Properties selected for verification that fall outside the formal subset are reported, not skipped silently.
      for (const p of spec.properties.filter((x) => spec.notFormalized.has(x.id) && wantedStatus(x))) {
        const reason = spec.notFormalized.get(p.id) as string;
        claims.push({
          id: stableId('C', { kind: 'conformance', propertyId: p.id, unsupported: reason }),
          propertyId: p.id,
          kind: 'conformance',
          status: 'unsupported',
          engine: 'none',
          engineVersion: 'n/a',
          assurance: 'none',
          modelId: 'none',
          assumptions: [],
          scope: {},
          semanticGaps: [reason],
          semanticValidation: 'not_attempted',
          durationMs: 0,
        });
        messages.push(`${p.id}: unsupported (${reason})`);
      }
      for (const p of toProve) {
        const f = spec.formalized.get(p.id);
        if (!f) continue;
        if ((options.formalEngine ?? config.formal.backend) === 'lean') {
          const { claim } = await proveWithLean({
            propertyId: p.id,
            ir: f.ir,
            timeoutMs: Math.max(60_000, config.formal.maxSolverMs),
            store,
            signal,
          });
          claims.push(claim);
          solverMs += claim.durationMs;
          messages.push(`${p.id} (lean): ${claim.status} [${claim.assurance}]`);
          continue;
        }
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
      const functions =
        (ctx.outputs.get('index') as { code: CodeIndex } | undefined)?.code.functions ?? code0.functions;
      for (const m of mutants.filter((m) => m.status === 'survived')) {
        const line = m.location.range?.start;
        const fn = functions.find(
          (f) =>
            f.file === m.location.file &&
            line !== undefined &&
            line >= (f.location.range?.start ?? 0) &&
            line <= (f.location.range?.end ?? 0),
        );
        if (!fn || line === undefined || !fn.exported) continue;
        const source = readFileSync(path.join(root, fn.file), 'utf8');
        const column = (source.split('\n')[line - 1] ?? '').indexOf(m.original) + 1;
        if (column <= 0) continue;
        let mutated: string;
        try {
          mutated = applyMutation(source, { line, column, original: m.original, replacement: m.replacement });
        } catch {
          continue;
        }
        const orig = translateFunction({
          file: fn.file,
          source,
          exportName: fn.name,
          domain,
          modelName: 'original',
        });
        const mut = translateFunction({
          file: fn.file,
          source: mutated,
          exportName: fn.name,
          domain,
          modelName: 'mutant',
        });
        if (orig.status !== 'translated' || mut.status !== 'translated') {
          messages.push(`mutant ${m.id}: equivalence not checked (outside the formal subset)`);
          continue;
        }
        const related = spec.properties.find((p) => p.targetSymbols.includes(fn.symbol));
        const target = { file: fn.file, exportName: fn.name };
        const relevant = [{ id: related?.id ?? stableId('P', { mutantsOf: fn.symbol }) }];
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
      const outcomes = tally(assessments.map((a) => a.outcome));
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
    // The report files are rendered after run.json is written (below), so they show the final verdict.
    run: async () => ({ status: 'succeeded', messages: [`formats: ${config.reports.formats.join(', ')}`] }),
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
  if (wanted.has('report')) {
    const input = buildReportInput(root, runId);
    for (const format of config.reports.formats) {
      if (format === 'text') continue;
      store.writeText(REPORT_FILES[format], renderReport(input, format));
    }
  }
  log(`run ${runId}: ${decision.verdict}`);
  return { runId, dir: store.dir, run, findings, decision };
}
