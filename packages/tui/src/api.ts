import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import {
  type Approval,
  CODE_CONFIGS,
  type DoctorReport,
  type Finding,
  type InitResult,
  JSON_CONFIG,
  type LogEvent,
  listRuns,
  loadConfig,
  type PatchAttempt,
  type Property,
  parseConfig,
  type Run,
  resolveInsideRoot,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  bundledTools,
  decideProperty,
  diffLatest,
  type Explanation,
  explainFinding,
  initProject,
  listProperties,
  type Profile,
  type RunSummary,
  readArtifact,
  run,
  runDoctor,
  showProperty,
} from '@under18dev/veritas-engine';
import { applyImprovement, type PlanResult, planImprovement } from '@under18dev/veritas-improvement';

export type ConfigFile =
  | { kind: 'json'; file: string; raw: unknown }
  | { kind: 'code'; file: string }
  | { kind: 'none' };

/**
 * What a run's evidence says, as counts per status of each kind: test assessments, mutants, property-based tests and
 * solver claims. A kind is null when the run did not record it. This is the evidence vector; there is no single score.
 */
export interface EvidenceVector {
  tests: [string, number][] | null;
  mutants: [string, number][] | null;
  pbt: [string, number][] | null;
  claims: [string, number][] | null;
}

export interface RunRequest {
  profile: Profile;
  offline: boolean;
  includeProposed: boolean;
  since?: string;
}

/**
 * Everything the screens read or change. Each method calls the same core, engine and improvement functions as the
 * CLI, so the TUI records the same artifacts and goes through the same checks.
 */
export interface TuiApi {
  root: string;
  runs(): string[];
  readRun(runId: string): Run;
  readFindings(runId: string): Finding[];
  readEvidence(runId: string): EvidenceVector;
  explain(findingId: string): Explanation;
  doctor(): Promise<DoctorReport>;
  init(): InitResult;
  properties(): Property[];
  property(id: string): { property: Property; approvals: Approval[] };
  decide(id: string, decision: 'accept' | 'reject', reason: string): Promise<Approval>;
  diff(): ReturnType<typeof diffLatest> | null;
  run(request: RunRequest, signal: AbortSignal, onEvent: (event: LogEvent) => void): Promise<RunSummary>;
  plan(includeProposed: boolean, signal: AbortSignal): Promise<PlanResult>;
  apply(planId: string, approvalToken: string, signal: AbortSignal): Promise<PatchAttempt>;
  readConfig(): ConfigFile;
  writeConfig(raw: unknown): void;
}

const NO_RUN = new Set(['NO_RUN', 'ARTIFACT_MISSING']);

function noRun(error: unknown): boolean {
  return error instanceof VeritasError && NO_RUN.has(error.code);
}

function counts(statuses: string[]): [string, number][] {
  const out = new Map<string, number>();

  for (const s of statuses) out.set(s, (out.get(s) ?? 0) + 1);

  return [...out];
}

/** Counts per status of an artifact the run may not have; null when it is missing. */
function tally(read: () => string[]): [string, number][] | null {
  try {
    return counts(read());
  } catch (error) {
    if (noRun(error)) return null;
    throw error;
  }
}

/**
 * Replace a file inside the project atomically: the content goes to a new temporary file next to it, created
 * exclusively (an existing file or link of that name is never opened), and is renamed over the target, which replaces
 * the directory entry instead of writing through a link. An interruption leaves the previous file intact.
 */
export function replaceFile(root: string, file: string, content: string): void {
  const dir = realpathSync(path.dirname(file));
  const base = realpathSync(root);

  if (dir !== base && !dir.startsWith(`${base}${path.sep}`))
    throw new VeritasError('user', 'PATH_OUTSIDE_ROOT', `${path.dirname(file)} resolves outside the project`);
  const target = path.join(dir, path.basename(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);

  try {
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, target);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The configuration whose declared properties the spec screens add to the latest run's, as the CLI does: the JSON
 * configuration (the TUI never loads a code configuration), or none.
 */
function specOptions(root: string): { config?: VeritasConfig } {
  const file = resolveInsideRoot(root, JSON_CONFIG);

  if (CODE_CONFIGS.some((f) => existsSync(resolveInsideRoot(root, f))) || !existsSync(file)) return {};

  return { config: parseConfig(JSON.parse(readFileSync(file, 'utf8')) as unknown, JSON_CONFIG) };
}

export function createApi(root: string): TuiApi {
  return {
    root,
    runs: () => listRuns(root),
    readRun: (runId) => readArtifact(root, runId, 'run').data,
    readFindings: (runId) => {
      try {
        return readArtifact(root, runId, 'findings').data;
      } catch (error) {
        if (noRun(error)) return [];
        throw error;
      }
    },
    readEvidence: (runId) => ({
      tests: tally(() => readArtifact(root, runId, 'assessments').data.map((a) => a.outcome)),
      mutants: tally(() => readArtifact(root, runId, 'mutation').data.mutants.map((m) => m.status)),
      pbt: tally(() => readArtifact(root, runId, 'pbt').data.map((r) => r.status)),
      claims: tally(() => readArtifact(root, runId, 'claims').data.map((c) => c.status)),
    }),
    explain: (findingId) => explainFinding(root, findingId),
    doctor: async () => {
      const config = await loadConfig(root).then(
        (c) => c.config,
        () => null,
      );

      return runDoctor(root, config, process.env, bundledTools());
    },
    init: () => initProject(root),
    properties: () => {
      try {
        return listProperties(root, specOptions(root)).properties;
      } catch (error) {
        if (noRun(error)) return [];
        throw error;
      }
    },
    property: (id) => showProperty(root, id, specOptions(root)),
    decide: (id, decision, reason) => decideProperty(root, id, decision, { reason, ...specOptions(root) }),
    diff: () => {
      try {
        return diffLatest(root);
      } catch (error) {
        if (noRun(error)) return null;
        throw error;
      }
    },
    run: (request, signal, onEvent) =>
      run({
        root,
        args: [],
        profile: request.profile,
        offline: request.offline,
        includeProposed: request.includeProposed,
        ...(request.since ? { since: request.since } : {}),
        signal,
        logger: onEvent,
      }),
    plan: (includeProposed, signal) => planImprovement({ root, includeProposed, signal }),
    apply: (planId, approvalToken, signal) =>
      applyImprovement({ root, planId, approvalToken, signal, via: 'api' }),
    readConfig: () => {
      const json = resolveInsideRoot(root, JSON_CONFIG);
      const code = CODE_CONFIGS.map((f) => resolveInsideRoot(root, f)).find((f) => existsSync(f));

      if (code) return { kind: 'code', file: code };
      if (!existsSync(json)) return { kind: 'none' };

      return { kind: 'json', file: json, raw: JSON.parse(readFileSync(json, 'utf8')) as unknown };
    },
    writeConfig: (raw) => {
      // The same validation the CLI applies on load: a value it would refuse is never written.
      parseConfig(raw, JSON_CONFIG);
      replaceFile(root, resolveInsideRoot(root, JSON_CONFIG), `${JSON.stringify(raw, null, 2)}\n`);
    },
  };
}
