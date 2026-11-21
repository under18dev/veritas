import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assessTests, deriveFindings, linkMutants, linkTests } from '@under18dev/veritas-assessment';
import {
  analyzeCode,
  type CodeIndex,
  type FunctionInfo,
  inferBehaviorCandidates,
  markChangedCandidates,
  parseChangedLines,
} from '@under18dev/veritas-code-intelligence';
import {
  type Capability,
  type ContentCache,
  detectProject as detectProjectWith,
  evaluatePolicy,
  type Finding,
  type FormalClaim,
  gitCommit,
  gitOutput,
  hashValue,
  type JsParam,
  type LogSink,
  logEvent,
  type Mutant,
  newRunId,
  openCache,
  type Param,
  type PolicyDecision,
  type PolicyEvidence,
  type Property,
  type PropertyIR,
  parseConfig,
  pruneRuns,
  type Run,
  RunStore,
  resolveInsideRoot,
  runStages,
  type Stage,
  type StageName,
  type StageResult,
  sha256,
  stableId,
  type TestRunnerProvider,
  toPosixRelative,
  traceCollector,
  type VerificationStatus,
  type VeritasConfig,
  VeritasError,
  withRunContext,
} from '@under18dev/veritas-core';
import {
  applyMutation,
  detectionProperty,
  equivalenceProperty,
  proveProperty,
  restrictToInputs,
  shapeInput,
  type TranslationResult,
  translateFunction,
} from '@under18dev/veritas-formal-core';
import { LlmClient, type LlmProvider } from '@under18dev/veritas-llm';
import {
  countMutants,
  importMutationResult,
  locateMutator,
  type MutationConfirmation,
  MutationRunResult,
  runMutation,
} from '@under18dev/veritas-mutation-adapter';
import {
  applyApprovals,
  buildRegistry,
  formalizeProperty,
  loadApprovals,
} from '@under18dev/veritas-property-engine';
import { type PbtResult, runPropertyTest } from '@under18dev/veritas-property-testing';
import { detectLean, leanTranslatable, proveWithLean } from '@under18dev/veritas-solver-lean';
import { type DiscoveryResult, discoverEvidence } from '@under18dev/veritas-spec-discovery';
import { inventoryTests, isTestSupportPath, type TestInventory } from '@under18dev/veritas-test-inventory';
import { ARTIFACTS } from './artifacts.js';
import {
  CONFIRMATION_MUTANTS_PER_LINE,
  MAIN_RUN_BUDGET_SHARE,
  MIN_CONFIRMATION_MS,
  mergeConfirmation,
  selectConfirmation,
} from './confirm.js';
import { extractWithLlm } from './llm-extract.js';
import { createLlmProvider } from './llm-providers.js';
import { defaultSeed, latestRunWith, openProject, readArtifact } from './project.js';
import { buildReportInput, REPORT_FILES, renderReport } from './report.js';
import { runDoctor, testRunnerFor } from './test-runners.js';
import { bundledTools } from './tools.js';

export type Profile = 'quick' | 'standard' | 'deep';

export interface RunOptions {
  root: string;
  command: string;
  args?: string[];
  /** Stages to run; dependencies earlier in the list are run too. */
  stages: StageName[];
  profile?: Profile;
  /** Never access the network: no network sources and no LLM requests. */
  offline?: boolean;
  /** Collect only local sources (no GitHub or web), while still allowing a configured LLM. */
  localSourcesOnly?: boolean;
  /** Sources to collect; by default local plus the network sources enabled in the configuration. */
  sources?: ('local' | 'github' | 'web')[];
  /** Import this mutation-testing-elements report (path inside the project) instead of running mutator. */
  mutationReport?: string;
  /** Run every covering test for every mutant and report the kill matrix (slower). */
  killMatrix?: boolean;
  /** Web discovery overrides from the command line: extra allowed domains and a page budget. */
  web?: { allowDomains?: string[]; maxPages?: number };
  since?: string;
  scope?: string[];
  /** Verify proposed (not yet accepted) properties as experimental. Accepted ones are always verified. */
  includeProposed?: boolean;
  /** Formal backend for conformance claims (mutant equivalence always uses Z3). */
  formalEngine?: 'z3' | 'lean' | 'both';
  propertyIds?: string[];
  allowCodeConfig?: boolean;
  /**
   * Repository whose git revision and log describe `root`, when `root` is a copy without `.git` (for example the
   * isolated workspace of `improve`). Read only. Source and property ids then match those of the repository.
   */
  gitRoot?: string;
  signal?: AbortSignal;
  /** Plain progress messages (info level and above). */
  log?: (message: string) => void;
  /** Every structured event of the run, debug level included (see `LogEvent`). */
  logger?: LogSink;
  /** Injected LLM provider (tests). By default the configured provider is used when it is available. */
  llmProvider?: LlmProvider | null;
}

export interface RunSummary {
  runId: string;
  dir: string;
  run: Run;
  findings: Finding[];
  decision: PolicyDecision;
}

/**
 * The options a recorded run was made with, as `runVeritas` takes them, for re-running it (`veritas replay`, the
 * re-evaluation of `improve`). Network sources are recorded too; callers that run offline skip them.
 */
export function recordedRunOptions(run: Run): Omit<RunOptions, 'root' | 'command' | 'stages'> {
  return {
    args: run.args,
    ...(run.profile ? { profile: run.profile } : {}),
    includeProposed: run.options?.includeProposed ?? run.args.includes('--include-proposed'),
    ...(run.options?.propertyIds ? { propertyIds: run.options.propertyIds } : {}),
    ...(run.options?.formalEngine ? { formalEngine: run.options.formalEngine } : {}),
    ...(run.options?.sources ? { sources: run.options.sources } : {}),
    ...(run.options?.web ? { web: run.options.web } : {}),
    ...(run.options?.mutationReport ? { mutationReport: run.options.mutationReport } : {}),
    ...(run.options?.killMatrix ? { killMatrix: true } : {}),
    ...(run.scope.paths.length ? { scope: run.scope.paths } : {}),
    ...(run.scope.since ? { since: run.scope.since } : {}),
  };
}

/**
 * With the `both` backend, whether Lean is tried after Z3 for a property: only when Z3 proved it, since Lean proves
 * the same model with mathematical integers and would otherwise add a proof next to a refuted or mismatched model.
 * Returns why Lean is skipped, or null to try it.
 */
export function leanSkipReason(z3Status: VerificationStatus, translatable: boolean): string | null {
  if (z3Status !== 'proven_within_model') return `skipped, Z3 result is ${z3Status}`;
  if (!translatable) return 'skipped, outside the Lean subset';

  return null;
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
    {
      ir: import('@under18dev/veritas-core').PropertyIR;
      assumptions: string[];
      file: string;
      exportName: string;
    }
  >;
  conflicts: import('@under18dev/veritas-property-engine').ConflictGroup[];
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
  const { config, configHash } = await openProject(options.root, {
    allowCodeConfig: options.allowCodeConfig,
  });
  // Every run keeps an execution trace (child processes, sandbox calls, stages, cache) in trace.jsonl; callers may
  // also receive the events (logger) or, as before, only the plain messages (log).
  const trace = traceCollector();
  const sinks: LogSink[] = [trace.sink];

  if (options.logger) sinks.push(options.logger);
  const legacy = options.log;

  if (legacy) sinks.push((event) => event.level !== 'debug' && legacy(event.message));

  return withRunContext({ root: options.root, memoryMb: config.limits.memoryMb, sinks }, () =>
    runInContext(options, config, configHash, trace),
  );
}

async function runInContext(
  options: RunOptions,
  config: VeritasConfig,
  configHash: string,
  trace: ReturnType<typeof traceCollector>,
): Promise<RunSummary> {
  const { root } = options;
  const log = (message: string) => logEvent('info', message);
  // Command-line web overrides go through the same validation as the configuration file.
  const discoveryConfig = options.web
    ? parseConfig(
        {
          ...config,
          sources: {
            ...config.sources,
            web: {
              ...config.sources.web,
              allowDomains: [
                ...new Set([...config.sources.web.allowDomains, ...(options.web.allowDomains ?? [])]),
              ],
              ...(options.web.maxPages !== undefined ? { maxPages: options.web.maxPages } : {}),
            },
          },
        },
        'command-line options',
      )
    : config;

  // A ref is passed to git as an argument: refuse anything that could be read as an option.
  if (
    options.since !== undefined &&
    (options.since === '' || options.since.startsWith('-') || /[\s\0]/.test(options.since))
  )
    throw new VeritasError(
      'user',
      'SINCE_INVALID',
      `invalid git ref for --since: ${JSON.stringify(options.since)}`,
    );
  // An imported mutation report is read before any stage runs, so a bad path or report is a user error.
  const imported = options.mutationReport
    ? importMutationResult({ root, reportFile: options.mutationReport })
    : null;
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
  const store = new RunStore(root, runId, {
    configHash,
    sourceHash,
    ...(options.gitRoot ? { gitCommit: gitCommit(options.gitRoot) } : {}),
  });
  const { cache, message: cacheMessage } = openCache(root, config);

  if (cacheMessage) log(cacheMessage);
  const signal = options.signal ?? new AbortController().signal;
  const wanted = new Set(options.stages);
  const domain = config.formal.integerDomain;
  const claims: FormalClaim[] = [];
  let mutants: Mutant[] = [];
  let mutationAvailable = false;
  let findings: Finding[] = [];
  let policyEvidence: PolicyEvidence = {};
  const pbtResults: PbtResult[] = [];
  const seeds: Record<string, number> = {};

  const stages: Stage[] = [];
  const add = (stage: Stage) => wanted.has(stage.name) && stages.push(stage);
  // Project-relative files changed since --since (committed or not), when the run selects mutation tests by them.
  let changedSince: string[] | undefined | null = null;
  const changedSinceFiles = (): string[] | undefined => {
    if (changedSince === null) {
      const lines = (output: string | null) =>
        output
          ?.split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      // Changed since the ref (committed or not), plus new files git does not track yet.
      const diff =
        !options.scope?.length && options.since
          ? lines(
              gitOutput(root, [
                'diff',
                '--name-only',
                '--relative',
                '--no-color',
                '--no-ext-diff',
                options.since,
                '--',
              ]),
            )
          : undefined;
      changedSince = diff
        ? [...diff, ...(lines(gitOutput(root, ['ls-files', '--others', '--exclude-standard'])) ?? [])]
        : undefined;
    }

    return changedSince;
  };
  const testRunner = testRunnerFor(config);
  /** The test inventory the map stage made, or one made now when it has not run; undefined when it cannot be made. */
  const mutationInventory = (mapped: TestInventory | undefined): TestInventory | undefined => {
    try {
      return mapped ?? inventoryTests({ root, config, recognition: testRunner.recognitionFor(root) });
    } catch {
      return undefined;
    }
  };
  const mutationTestFiles = (inventory: TestInventory | undefined): string[] | undefined => {
    // With --since, mutator only mutates what changed, so only tests that reach a changed file can kill a mutant.
    const changed = changedSinceFiles();
    const scope = options.scope?.length ? options.scope : changed?.length ? changed : undefined;

    if (!inventory) return undefined;

    try {
      return selectMutationTestFiles(inventory, config, scope);
    } catch {
      return undefined;
    }
  };

  /**
   * Check the tests static analysis could not link to project code, by running mutator again on their test files
   * alone, on the project sources those files import, with --kill-matrix (every covering test runs every mutant)
   * and one mutant per line, within what is left of mutation.timeoutMs. Their kills and the mutants they ran are
   * merged into the main run's mutants; a test whose check did not run keeps what the main run says.
   */
  const confirmDisconnected = async (
    main: MutationRunResult,
    inventory: TestInventory | undefined,
    remainingMs: number,
  ): Promise<{
    confirmation: MutationConfirmation;
    mutants: Mutant[];
    artifacts: string[];
    messages: string[];
  } | null> => {
    // A main run under --kill-matrix already ran every covering test on every mutant: nothing is left to check.
    if (
      !config.mutation.confirmDisconnected ||
      options.killMatrix ||
      !inventory ||
      main.status !== 'succeeded'
    )
      return null;
    const selection = selectConfirmation(inventory, main.mutants, config, options.scope);

    if (selection.testIds.length === 0) return null;
    const label = `check of ${selection.testIds.length} test(s) static analysis could not link to project code`;

    if (remainingMs < MIN_CONFIRMATION_MS) {
      const detail = `${Math.max(0, Math.round(remainingMs / 1000))}s of mutation.timeoutMs left, less than the ${MIN_CONFIRMATION_MS / 1000}s it needs; raise mutation.timeoutMs or narrow the run with --since`;

      return {
        confirmation: {
          status: 'skipped',
          detail,
          ...selection,
          command: [],
          durationMs: 0,
          counts: countMutants([]),
          killedBy: [],
          ranBy: {},
          inconsistent: [],
          adopted: [],
          warnings: [],
        },
        mutants: main.mutants,
        artifacts: [],
        messages: [`${label}: skipped (${detail}); they stay as static analysis reports them`],
      };
    }
    const cacheKey = cache
      ? mutationCacheKey(cache, root, {
          configHash,
          since: options.since,
          scope: selection.sourceFiles,
          killMatrix: true,
          testFiles: selection.testFiles,
          mutantsPerLine: CONFIRMATION_MUTANTS_PER_LINE,
          testRunner,
        })
      : null;
    const cached = cache && cacheKey ? cache.get('mutation', cacheKey, MutationRunResult) : undefined;
    const run =
      cached ??
      (await runMutation({
        root,
        config: { ...config, mutation: { ...config.mutation, timeoutMs: Math.floor(remainingMs) } },
        testRunner,
        reportDir: store.pathFor('mutation-confirm'),
        signal,
        ...(options.since ? { since: options.since } : {}),
        scope: selection.sourceFiles,
        testFiles: selection.testFiles,
        killMatrix: true,
        mutantsPerLine: CONFIRMATION_MUTANTS_PER_LINE,
        tests: inventory.tests,
      }));

    if (!cached && cache && cacheKey && cacheableMutationResult(run)) cache.set('mutation', cacheKey, run);
    const merged =
      run.status === 'succeeded'
        ? mergeConfirmation(main.mutants, run.mutants, selection.testIds)
        : { mutants: main.mutants, ranBy: {}, killedBy: [], inconsistent: [], adopted: [] };
    const ranSome = Object.keys(merged.ranBy).length;

    return {
      confirmation: {
        status: run.status,
        detail: run.detail,
        ...selection,
        command: run.command,
        durationMs: run.durationMs,
        counts: run.counts,
        killedBy: merged.killedBy,
        ranBy: merged.ranBy,
        inconsistent: merged.inconsistent,
        adopted: merged.adopted,
        warnings: run.warnings,
      },
      mutants: merged.mutants,
      artifacts: cached ? [] : store.recordExternal('mutation-confirm'),
      messages: [
        `${label}: ${run.status}${run.detail ? ` (${run.detail})` : ''}${cached ? ` (reused from cache ${cacheKey})` : ''}; mutator ran ${selection.testFiles.length} test file(s) on ${selection.sourceFiles.length} source file(s) they import, with --kill-matrix and at most ${CONFIRMATION_MUTANTS_PER_LINE} mutant(s) per line`,
        ...(run.status === 'succeeded'
          ? [
              `of the ${selection.testIds.length} test(s) checked: ${merged.killedBy.length} killed at least one mutant, ${ranSome - merged.killedBy.length} ran mutants and killed none, ${selection.testIds.length - ranSome} ran no mutant to a verdict (those stay as static analysis reports them)`,
              `check counts: ${JSON.stringify(Object.fromEntries(Object.entries(run.counts).filter(([, n]) => n > 0)))}`,
            ]
          : ['no test was checked; they stay as static analysis reports them']),
        ...(merged.inconsistent.length
          ? [
              `${merged.inconsistent.length} mutant(s) survived the main run or were covered by no test there, but were killed in the check (a flaky test?); the main run's result was kept: ${merged.inconsistent.join(', ')}`,
            ]
          : []),
        ...(merged.adopted.length
          ? [
              `${merged.adopted.length} mutant(s) the main run did not decide (pending) were killed in the check and are counted as killed in this stage's counts; each says so in its statusReason`,
            ]
          : []),
        ...run.warnings.map((w) => `check: ${w}`),
      ],
    };
  };

  add({
    name: 'index',
    dependsOn: [],
    run: async () => {
      const inferred = inferBehaviorCandidates(code0);
      // With --since, candidates in functions changed since that ref carry the change as evidence.
      const diff =
        options.since && code0.files.length
          ? gitOutput(root, [
              'diff',
              '-U0',
              '--no-color',
              '--no-ext-diff',
              options.since,
              '--',
              ...code0.files.map((f) => f.path),
            ])
          : null;
      // analysis.inferSpecsFromCode: false keeps code-inferred candidates out of the property registry.
      const fromCode = config.analysis.inferSpecsFromCode ? inferred : [];
      const candidates =
        options.since && diff !== null
          ? markChangedCandidates(fromCode, code0, parseChangedLines(diff), options.since)
          : fromCode;

      return {
        status: 'succeeded',
        output: { code: code0, candidates },
        artifacts: [store.write(ARTIFACTS.codeIndex.file, ARTIFACTS.codeIndex.schema, code0)],
        messages: [
          `${code0.functions.length} function(s) in ${code0.files.length} file(s); ${candidates.length} inferred candidate(s)`,
          ...(options.since && diff === null
            ? [`git diff against ${options.since} unavailable; changes not marked`]
            : []),
        ],
      };
    },
  });
  add({
    name: 'discover',
    dependsOn: [],
    run: async () => {
      const result = await discoverEvidence({
        root,
        config: discoveryConfig,
        offline: Boolean(options.offline || options.localSourcesOnly),
        ...(options.sources ? { sources: options.sources } : {}),
        ...(options.gitRoot ? { gitRoot: options.gitRoot } : {}),
      });
      let llmTokens = 0;
      const llmMessages: string[] = [];
      let provider: LlmProvider | null = null;

      if (options.offline) {
        if (options.llmProvider || config.llm.provider !== 'none')
          llmMessages.push('llm: skipped because the run is offline');
      } else if (options.llmProvider !== undefined) {
        provider = options.llmProvider;
      } else {
        const created = await createLlmProvider(config, root);
        provider = created.provider;

        if (created.message) llmMessages.push(created.message);
      }

      if (provider) {
        const client = new LlmClient(provider, {
          tokenBudget: config.llm.maxTokensPerRun,
          sendFullText: config.sources.sendFullTextToLlm,
          cache,
        });
        const extracted = await extractWithLlm(client, result, signal);
        result.statements.push(...extracted.added);
        llmTokens = extracted.tokens;
        llmMessages.push(...extracted.messages);
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
        const result = formalizeProperty({
          root,
          property: p,
          fn,
          domain,
          maxArrayLength: config.formal.maxArrayLength,
          ...(quote ? { quote } : {}),
        });

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
      const inventory = inventoryTests({ root, config, recognition: testRunner.recognitionFor(root) });

      return {
        status: 'succeeded',
        output: inventory,
        messages: [
          // Counted as written in the test files, so the test runner, which counts each case of a loop or .each, may report more.
          `${inventory.tests.length} test registration(s) (a loop or .each counts once), ${inventory.edges.length} symbol edge(s)`,
        ],
      };
    },
  });
  add({
    name: 'mutate',
    dependsOn: [],
    run: async (ctx) => {
      if (imported) {
        const result = imported;
        mutants = result.mutants;
        // A report says nothing about which mutants a --since change covers, so pending ones stay undecided.
        const { status, undecided, empty } = mutationStageStatus(result, { incremental: false });
        mutationAvailable = !empty;

        return {
          status,
          output: result,
          usage: { mutants: result.mutants.length },
          messages: [
            `counts: ${JSON.stringify(Object.fromEntries(Object.entries(result.counts).filter(([, n]) => n > 0)))}`,
            ...result.warnings,
            ...(empty ? ['the report contains no mutant; mutation results are partial'] : []),
            ...(undecided > 0
              ? [`${undecided} mutant(s) not decided (pending or unknown); mutation results are partial`]
              : []),
          ],
        };
      }
      const started = Date.now();
      const inventory = mutationInventory(ctx.outputs.get('map') as TestInventory | undefined);
      const testFiles = mutationTestFiles(inventory);
      const cacheKey = cache
        ? mutationCacheKey(cache, root, {
            configHash,
            since: options.since,
            scope: options.scope,
            killMatrix: Boolean(options.killMatrix),
            testFiles,
            testRunner,
          })
        : null;
      const cached = cache && cacheKey ? cache.get('mutation', cacheKey, MutationRunResult) : undefined;
      // With tests to check after it, the main run stops starting mutants earlier, to leave the check some time.
      // Only when what is left would let the check run with some room: otherwise the main run would lose time and
      // the check would still be skipped.
      const reserve =
        config.mutation.confirmDisconnected &&
        !options.killMatrix &&
        !cached &&
        config.mutation.timeoutMs * (1 - MAIN_RUN_BUDGET_SHARE) >= MIN_CONFIRMATION_MS * 2 &&
        inventory !== undefined &&
        selectConfirmation(inventory, [], config, options.scope).testIds.length > 0;
      const result =
        cached ??
        (await runMutation({
          root,
          config,
          testRunner,
          ...(reserve
            ? { timeBudgetSeconds: (config.mutation.timeoutMs * MAIN_RUN_BUDGET_SHARE) / 1000 }
            : {}),
          reportDir: store.pathFor('mutation'),
          signal,
          ...(options.since ? { since: options.since } : {}),
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.killMatrix ? { killMatrix: true } : {}),
          ...(testFiles ? { testFiles } : {}),
          ...(inventory ? { tests: inventory.tests } : {}),
        }));

      // Only a complete mutation run is reused; a failed or unsupported one, or one that left files out, is run again.
      if (!cached && cache && cacheKey && cacheableMutationResult(result))
        cache.set('mutation', cacheKey, result);

      if (cached) result.rawReportPath = null;
      // Tests were chosen by the changed files, so mutator calls a mutant of an unchanged file "no coverage". It
      // was outside --since and not run: pending, as without the narrower test selection.
      // The mutants mutator itself left unrun, before --since relabels others as pending.
      const budgetBefore = result.timeBudgetExhausted?.notRun;
      const unrun = result.mutants.filter((m) => m.status === 'pending').map((m) => m.id);
      const changed = testFiles ? changedSinceFiles() : undefined;

      if (changed?.length) {
        const inChange = new Set(changed);
        result.mutants = result.mutants.map((m) =>
          m.status === 'no_coverage' && !inChange.has(m.location.file)
            ? { ...m, status: 'pending' as const }
            : m,
        );
        result.counts = countMutants(result.mutants);
      }
      // The mutator writes its own report files; index them so they carry the run metadata and a hash.
      const external = cached ? [] : store.recordExternal('mutation');
      const confirmed = await confirmDisconnected(
        result,
        inventory,
        config.mutation.timeoutMs - (Date.now() - started),
      );

      if (confirmed) {
        result.confirmation = confirmed.confirmation;
        result.timeBudgetExhausted = outstandingBudget(
          result.timeBudgetExhausted,
          unrun,
          confirmed.confirmation.adopted,
        );
        result.mutants = confirmed.mutants;
        result.counts = countMutants(result.mutants);
        external.push(...confirmed.artifacts);
      }
      mutants = result.mutants;
      const { status, undecided, empty } = mutationStageStatus(result, {
        incremental: Boolean(options.since),
      });
      mutationAvailable = result.status === 'succeeded' && !empty;

      return {
        status,
        output: result,
        artifacts: external,
        usage: { mutants: result.mutants.length },
        messages: [
          ...(cached ? [`mutation results reused from cache ${cacheKey}`] : []),
          ...(reserve
            ? [
                `the main run started no new mutant after ${Math.round(MAIN_RUN_BUDGET_SHARE * 100)}% of mutation.timeoutMs (instead of 75%), to leave time for the check of tests static analysis could not link`,
              ]
            : []),
          ...(cacheMessage ? [cacheMessage] : []),
          `mutator ${result.backend.version ?? 'unknown'}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`,
          ...(result.typecheck === 'off'
            ? ['mutator ran with --no-typecheck: mutants were not type-checked']
            : result.typecheck === 'auto'
              ? [
                  "mutator was allowed to type-check mutants with the project's TypeScript (typecheck: auto) and leave out those that do not compile",
                ]
              : []),
          `counts: ${JSON.stringify(Object.fromEntries(Object.entries(result.counts).filter(([, n]) => n > 0)))}`,
          ...result.warnings,
          ...(undecided > 0
            ? [`${undecided} mutant(s) not decided (pending or unknown); mutation results are partial`]
            : []),
          ...(result.excludedFiles?.length
            ? [
                `${result.excludedFiles.length} source file(s) left out of mutation (${result.excludedFiles.join(', ')}); mutation results are partial`,
              ]
            : []),
          ...(empty && result.status === 'succeeded'
            ? ['no mutant was generated; mutation results are partial']
            : []),
          ...(confirmed?.messages ?? []),
          ...(confirmed &&
          result.timeBudgetExhausted &&
          result.timeBudgetExhausted.notRun < (budgetBefore ?? 0)
            ? [
                `the check of unlinked tests killed mutants the main run had no time for: ${result.timeBudgetExhausted.notRun} mutant(s) are still not run`,
              ]
            : []),
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
          allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
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

      let leanInstalled: boolean | undefined;

      for (const p of toProve) {
        const f = spec.formalized.get(p.id);

        if (!f) continue;

        const engine = options.formalEngine ?? config.formal.backend;
        const lean = () =>
          proveWithLean({
            propertyId: p.id,
            ir: f.ir,
            timeoutMs: Math.max(60_000, config.formal.maxSolverMs),
            store,
            signal,
          }).then(({ claim }) => {
            solverMs += claim.durationMs;

            return claim;
          });

        if (engine === 'lean') {
          const claim = await lean();
          claims.push(claim);
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
          allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
          cache,
        });
        claims.push(claim);
        solverMs += claim.durationMs;
        messages.push(
          `${p.id}: ${claim.status}${claim.counterexample ? ` ${JSON.stringify(claim.counterexample)}` : ''}`,
        );

        // With `both`, Lean adds a kernel-checked proof to what Z3 proved, where it can translate the property. Z3
        // still checks the implementation, which the Lean model does not cover. Only a kernel-checked proof is
        // recorded as a claim: Lean failing to prove what Z3 proved, or not being installed, decides nothing.
        if (engine !== 'both') continue;
        const skip = leanSkipReason(claim.status, leanTranslatable(f.ir));

        if (skip) {
          messages.push(`${p.id} (lean): ${skip}`);
          continue;
        }
        leanInstalled ??= await detectLean().then((lean) => {
          if (!lean.available)
            messages.push(`Lean is not available (${lean.detail}); only Z3 claims are recorded`);

          return lean.available;
        });

        if (!leanInstalled) continue;
        const proof = await lean();

        if (proof.status === 'proven_within_model') {
          claims.push(proof);
          messages.push(`${p.id} (lean): ${proof.status} [${proof.assurance}]`);
        } else messages.push(`${p.id} (lean): ${proof.status}, no kernel-checked proof; the Z3 claim stands`);
      }
      const skipped = spec.properties.filter((p) => spec.formalized.has(p.id) && !toProve.includes(p));

      if (skipped.length)
        messages.push(
          `${skipped.length} formalized propert(y/ies) not verified: not accepted (use --include-proposed)`,
        );
      // Survived mutants in translatable functions: bounded equivalence or a distinguishing input.
      const functions =
        (ctx.outputs.get('index') as { code: CodeIndex } | undefined)?.code.functions ?? code0.functions;
      /** The exported function a mutant sits in, with the original and the mutated source. */
      const mutantSource = (m: Mutant) => {
        const line = m.location.range?.start;
        const fn = functions.find(
          (f) =>
            f.file === m.location.file &&
            line !== undefined &&
            line >= (f.location.range?.start ?? 0) &&
            line <= (f.location.range?.end ?? 0),
        );

        if (!fn || line === undefined || !fn.exported) return null;
        const source = readFileSync(path.join(root, fn.file), 'utf8');
        const column = (source.split('\n')[line - 1] ?? '').indexOf(m.original) + 1;

        if (column <= 0) return null;

        try {
          const mutated = applyMutation(source, {
            line,
            column,
            original: m.original,
            replacement: m.replacement,
          });

          return { fn, source, mutated };
        } catch {
          return null;
        }
      };
      const pairs = new Map<
        string,
        { fn: FunctionInfo; orig: Translated; mut: Translated; propertyId: string }
      >();

      for (const m of mutants.filter((m) => m.status === 'survived')) {
        const found = mutantSource(m);

        if (!found) continue;
        const { fn, source, mutated } = found;
        const orig = translateFunction({
          file: fn.file,
          source,
          exportName: fn.name,
          domain,
          maxArrayLength: config.formal.maxArrayLength,
          modelName: 'original',
        });
        const mut = translateFunction({
          file: fn.file,
          source: mutated,
          exportName: fn.name,
          domain,
          maxArrayLength: config.formal.maxArrayLength,
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
          allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
          cache,
        });
        claims.push(claim);
        solverMs += claim.durationMs;

        if (claim.status === 'proven_within_model') {
          m.status = 'equivalent_proven';
          m.statusReason = `bounded equivalence within ${JSON.stringify(domain)} (${claim.id})`;
        } else {
          pairs.set(m.id, { fn, orig, mut, propertyId: relevant[0]?.id as string });
        }
        messages.push(
          `mutant ${m.id}: ${claim.status}${claim.counterexample ? ` distinguishing input ${JSON.stringify(claim.counterexample)}` : ''}`,
        );
      }

      // The two other relations cost a solver call each; at most MAX_RELATION_CLAIMS per run.
      let budget = MAX_RELATION_CLAIMS;
      let overBudget = 0;
      const spend = (): boolean => {
        if (budget > 0) {
          budget--;

          return true;
        }

        overBudget++;

        return false;
      };

      // Relation 2: can the inputs a test already uses tell a surviving mutant from the original?
      const inventory = ctx.outputs.get('map') as TestInventory | undefined;

      for (const [mutantId, { fn, orig, mut, propertyId }] of pairs) {
        const byInputs = new Map<string, { inputs: Record<string, string | boolean>[]; testIds: string[] }>();

        for (const test of inventory?.tests ?? []) {
          const inputs = test.targetCalls
            .filter((c) => c.symbol === fn.symbol)
            .map((c) => literalInput(orig.params, c.args, domain, orig.model.jsParams));

          if (inputs.length === 0) continue;

          if (inputs.some((i) => i === null)) {
            messages.push(
              `mutant ${mutantId}: inputs of ${test.id} are not all integer or boolean literals in the domain`,
            );
            continue;
          }
          const usable = inputs as Record<string, string | boolean>[];
          const key = JSON.stringify(usable);
          const group = byInputs.get(key) ?? { inputs: usable, testIds: [] };
          group.testIds.push(test.id);
          byInputs.set(key, group);
        }

        for (const { inputs, testIds } of byInputs.values()) {
          if (!spend()) continue;
          const { claim } = await proveProperty({
            kind: 'distinguishability',
            propertyId,
            ir: restrictToInputs(equivalenceProperty(orig, mut, domain), inputs),
            root,
            bindings: [{ modelName: 'original', modulePath: path.join(root, fn.file), exportName: fn.name }],
            timeoutMs: config.formal.maxSolverMs,
            store,
            signal,
            mutantId,
            assumptions: [
              `only the inputs of ${testIds.join(', ')} are considered; a counterexample means one of them gives a different result under the mutant`,
            ],
            allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
            cache,
          });
          const withTests = {
            ...claim,
            scope: { ...claim.scope, testIds },
            semanticGaps: [...claim.semanticGaps, MUTANT_MODEL_GAP],
          };
          claims.push(withTests);
          solverMs += claim.durationMs;
          messages.push(
            `mutant ${mutantId} vs inputs of ${testIds.join(', ')}: ${claim.status}${claim.counterexample ? ` (${JSON.stringify(claim.counterexample)} distinguishes it)` : ''}`,
          );
        }
      }

      // Relation 4: which mutants of its function does each verified property detect?
      for (const p of toProve) {
        const f = spec.formalized.get(p.id);

        if (!f) continue;

        for (const m of mutants.filter((m) => m.status !== 'pending' && m.status !== 'ignored')) {
          const found = mutantSource(m);

          if (!found || found.fn.symbol !== p.targetSymbols[0]) continue;
          const mut = translateFunction({
            file: found.fn.file,
            source: found.mutated,
            exportName: found.fn.name,
            domain,
            maxArrayLength: config.formal.maxArrayLength,
            modelName: `${f.exportName}__mutant`,
          });
          let ir: PropertyIR;

          try {
            if (mut.status !== 'translated') throw new Error('outside the formal subset');
            ir = detectionProperty(f.ir, f.exportName, mut);
          } catch (error) {
            messages.push(`${p.id} vs mutant ${m.id}: detection not checked (${(error as Error).message})`);
            continue;
          }

          if (!spend()) continue;
          const { claim } = await proveProperty({
            kind: 'property_detection',
            propertyId: p.id,
            ir,
            root,
            // Only the original has a JavaScript export to replay; the mutant exists as a model.
            bindings: [
              { modelName: f.exportName, modulePath: path.join(root, f.file), exportName: f.exportName },
            ],
            timeoutMs: config.formal.maxSolverMs,
            store,
            signal,
            mutantId: m.id,
            assumptions: [
              'a counterexample is an input where the original satisfies the property and the mutant does not (the property detects the change); proven_within_model means no such input exists within the bounds',
            ],
            allowNetworkWithoutIsolation: config.sandbox.allowNetworkWithoutIsolation,
            cache,
          });
          claims.push({ ...claim, semanticGaps: [...claim.semanticGaps, MUTANT_MODEL_GAP] });
          solverMs += claim.durationMs;
          messages.push(
            `${p.id} vs mutant ${m.id}: ${claim.status === 'counterexample_found' ? `detects it with ${JSON.stringify(claim.counterexample)}` : claim.status === 'proven_within_model' ? 'cannot distinguish it within the bounds' : claim.status}`,
          );
        }
      }

      if (overBudget > 0)
        messages.push(
          `${overBudget} distinguishability/property-detection check(s) skipped: limit of ${MAX_RELATION_CLAIMS} per run`,
        );
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
        killMatrix: Boolean(options.killMatrix) && !imported,
        ranMutantIds: new Map(
          Object.entries(
            (ctx.outputs.get('mutate') as MutationRunResult | undefined)?.confirmation?.ranBy ?? {},
          ).map(([testId, ids]) => [testId, new Set(ids)]),
        ),
      });
      policyEvidence = { mutants: linkedMutants, properties: spec.properties, assessments };
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
          title: `property-based test found ${JSON.stringify(p?.ir && r.counterexample ? shapeInput(p.ir, r.counterexample) : r.counterexample)} violating "${p?.formalExpression ?? r.propertyId}"`,
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
          | import('@under18dev/veritas-mutation-adapter').MutationRunResult
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
  const capabilities: Capability[] = (await runDoctor(root, config, process.env, bundledTools()))
    .capabilities;
  const decision = evaluatePolicy(config.policy, findings, results, claims, { mutants, ...policyEvidence });
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
    options: {
      includeProposed: Boolean(options.includeProposed),
      ...(options.propertyIds ? { propertyIds: options.propertyIds } : {}),
      ...(options.formalEngine ? { formalEngine: options.formalEngine } : {}),
      ...(options.sources ? { sources: options.sources } : {}),
      ...(options.web ? { web: options.web } : {}),
      ...(options.mutationReport ? { mutationReport: options.mutationReport } : {}),
      ...(options.killMatrix ? { killMatrix: true } : {}),
      offline: Boolean(options.offline),
    },
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
  // Older runs are pruned before the trace is written, so the trace records the removal. The current run is never
  // pruned, and runs still in progress elsewhere are not finished yet.
  const pruned = pruneRuns(root, config.storage.retainRuns, runId);

  if (pruned.length > 0)
    log(`removed ${pruned.length} older run(s) beyond storage.retainRuns (${config.storage.retainRuns})`);
  store.writeText('trace.jsonl', trace.text());

  return { runId, dir: store.dir, run, findings, decision };
}

/**
 * Cache key for a mutation run: every file the tests could read (tracked and untracked, not ignored, from
 * `git ls-files`, without tool state) by content, the mutator and test runner builds, Node.js, the configuration and
 * the selection (`--since` resolved to a commit, scope). Without git the files cannot be listed and the cache is
 * not used.
 */
/**
 * Test files mutator needs to run. A test file is left out only on evidence that it cannot kill these
 * mutants: it imports project sources and none of them is in scope. A test whose reach static analysis cannot
 * see is always kept: a child process or dynamic import may load the mutated source itself (plain JavaScript,
 * a TypeScript loader), and an unresolved import may be the source in scope. So is a file in which no test was
 * recognized, and a test that imports no source at all, so a failing baseline still shows.
 */
export function selectMutationTestFiles(
  inventory: Pick<TestInventory, 'files' | 'tests'>,
  config: VeritasConfig,
  scope?: string[],
): string[] {
  const { include, exclude, testInclude } = config.analysis;
  const matches = (file: string, globs: string[]) => globs.some((glob) => path.posix.matchesGlob(file, glob));
  const isSource = (file: string) =>
    matches(file, include) &&
    !matches(file, exclude) &&
    !matches(file, testInclude) &&
    !isTestSupportPath(file);
  const inScope = (file: string) => (scope?.length ? matches(file, scope) : isSource(file));
  const unseen = new Set([
    ...inventory.files.filter((file) => file.unseenReach).map((file) => file.path),
    ...inventory.tests
      .filter(
        (test) => test.suspicions.includes('opaque_call') || test.suspicions.includes('unresolved_import'),
      )
      .map((test) => test.file),
  ]);

  // A file without a recorded test (a custom registration, say) may still run anything.
  const recorded = new Set(inventory.tests.map((test) => test.file));

  return inventory.files
    .filter(
      (file) =>
        unseen.has(file.path) ||
        !recorded.has(file.path) ||
        !file.dependencies.some(isSource) ||
        file.dependencies.some(inScope),
    )
    .map((file) => file.path);
}

export function mutationCacheKey(
  cache: ContentCache,
  root: string,
  selection: {
    configHash: string;
    since?: string | undefined;
    scope?: string[] | undefined;
    killMatrix?: boolean;
    testFiles?: string[] | undefined;
    mutantsPerLine?: number;
    /** The provider of the project's test runner, whose installed version is part of the key (default: Vitest). */
    testRunner?: TestRunnerProvider;
  },
): string | null {
  const listed = gitOutput(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);

  if (listed === null) return null;
  const since = selection.since
    ? gitOutput(root, ['rev-parse', '--verify', `${selection.since}^{commit}`])
    : null;

  if (selection.since && since === null) return null;
  // Tool state is not an input: Veritas runs and cache, mutator's working directory and installed dependencies
  // (`node_modules`, where Vitest also keeps its cache; dependencies count through the lockfile and versions).
  const files = [
    ...new Set(
      listed
        .split('\0')
        .filter((f) => f && !/^(\.veritas|\.mutator)\//.test(f) && !f.split('/').includes('node_modules')),
    ),
  ].sort();
  const contents = files.map((file) => {
    try {
      return [file, sha256(readFileSync(resolveInsideRoot(root, file)))];
    } catch {
      return [file, null];
    }
  });
  const mutator = locateMutator(root);
  const runner = selection.testRunner ?? testRunnerFor(null);

  return cache.key({
    mutation: contents,
    mutator: mutator ? { version: mutator.version, origin: mutator.origin } : null,
    [runner.name]: detectProjectWith(root, runner).testRunner.installedVersion,
    node: process.versions.node,
    configHash: selection.configHash,
    since: since?.trim() ?? null,
    scope: selection.scope ?? [],
    killMatrix: selection.killMatrix ?? false,
    testFiles: selection.testFiles ?? null,
    // Absent unless set, so the keys of runs without it stay as they were.
    ...(selection.mutantsPerLine === undefined ? {} : { mutantsPerLine: selection.mutantsPerLine }),
  });
}

/** Upper bound on distinguishability and property-detection solver calls in one run. */
export const MAX_RELATION_CLAIMS = 40;

type Translated = Extract<TranslationResult, { status: 'translated' }>;

const MUTANT_MODEL_GAP =
  'the mutant is checked as a model of the mutated source only; it is not run in JavaScript, so the original side is the only one replayed';

/**
 * The literal arguments of a call as an input for `params`, or null when any is not an integer (within the
 * domain) or boolean literal of the right sort.
 */
export function literalInput(
  params: Param[],
  args: (string | null)[],
  domain: { min: string; max: string },
  jsParams?: JsParam[],
): Record<string, string | boolean> | null {
  const sortOf = new Map(params.map((p) => [p.name, p.sort]));
  const input: Record<string, string | boolean> = {};
  const set = (param: string, value: unknown, range = domain): boolean => {
    const sort = sortOf.get(param);

    if (sort === 'bool') {
      if (typeof value !== 'boolean') return false;
      input[param] = value;

      return true;
    }

    if (sort !== 'int' || typeof value !== 'string' || !/^-?\d+$/.test(value)) return false;
    const n = BigInt(value);

    if (n < BigInt(range.min) || n > BigInt(range.max)) return false;
    input[param] = n.toString();

    return true;
  };
  const scalar = (raw: string): unknown => (raw === 'true' ? true : raw === 'false' ? false : raw);
  // Without jsParams every JavaScript argument is the model parameter of the same position.
  const shapes: JsParam[] = jsParams ?? params.map((p) => ({ kind: 'scalar', name: p.name, param: p.name }));

  if (args.length !== shapes.length) return null;

  for (const [i, shape] of shapes.entries()) {
    const raw = args[i]?.trim() ?? null;

    if (raw === null) return null;

    if (shape.kind === 'scalar') {
      if (!set(shape.param, scalar(raw))) return null;
      continue;
    }
    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }

    if (shape.kind === 'record') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;

      if (Object.keys(record).length !== shape.fields.length) return null;

      for (const f of shape.fields) if (!set(f.param, record[f.key])) return null;
    } else {
      if (!Array.isArray(value) || value.length > shape.elements.length) return null;

      // The length ranges over [0, number of slots], not over the integer domain of the elements.
      if (!set(shape.length, String(value.length), { min: '0', max: String(shape.elements.length) }))
        return null;

      // Slots beyond the length do not affect the result in the model; give them a fixed value.
      for (const [k, param] of shape.elements.entries())
        if (!set(param, k < value.length ? value[k] : sortOf.get(param) === 'bool' ? false : domain.min))
          return null;
    }
  }

  return input;
}

/**
 * The time-budget overrun still outstanding once the confirmation's kills are adopted: each mutant mutator left unrun
 * (`unrun`, its own `pending` mutants, not those `--since` relabelled) that the confirmation killed now has a verdict.
 * The record stays (with `notRun` possibly 0) so the result is still not cached.
 */
export function outstandingBudget(
  budget: MutationRunResult['timeBudgetExhausted'],
  unrun: string[],
  adopted: string[],
): MutationRunResult['timeBudgetExhausted'] {
  if (!budget) return budget;
  const pending = new Set(unrun);
  const decided = adopted.filter((id) => pending.has(id)).length;

  return { ...budget, notRun: Math.max(0, budget.notRun - decided) };
}

/**
 * Whether a mutation result may be reused from the cache: a succeeded run that covered every file in scope and ran
 * every mutant within its time budget.
 */
export function cacheableMutationResult(
  result: Pick<MutationRunResult, 'status' | 'excludedFiles' | 'timeBudgetExhausted'>,
): boolean {
  return result.status === 'succeeded' && !result.excludedFiles?.length && !result.timeBudgetExhausted;
}

/**
 * Stage status for a mutation run. Mutants whose backend status was not recognized (`unknown`) leave the stage
 * `partial`, and so do mutants that were not run (`pending`) unless the run was incremental (`--since`), where
 * mutants outside the change are left out on purpose. A complete run without a single mutant is `partial` too:
 * it is no evidence about the tests. So is a run that left source files out because their instrumented copy did
 * not parse, and a run that stopped starting mutants because its time budget ran out, `--since` or not: those
 * mutants were selected and not run. A `partial` stage means the run cannot report `pass`.
 */
export function mutationStageStatus(
  result: {
    status: StageResult['status'] | 'unsupported';
    mutants: Mutant[];
    excludedFiles?: string[];
    timeBudgetExhausted?: { notRun: number };
  },
  options: { incremental?: boolean } = {},
): { status: StageResult['status']; undecided: number; empty: boolean } {
  const undecided = result.mutants.filter(
    (m) => m.status === 'unknown' || (m.status === 'pending' && !options.incremental),
  ).length;
  const empty = result.mutants.length === 0 && !options.incremental;

  if (result.status !== 'succeeded') return { status: result.status, undecided, empty };

  const excluded = (result.excludedFiles?.length ?? 0) > 0;
  const overBudget = (result.timeBudgetExhausted?.notRun ?? 0) > 0;

  return {
    status: undecided > 0 || empty || excluded || overBudget ? 'partial' : 'succeeded',
    undecided,
    empty,
  };
}
