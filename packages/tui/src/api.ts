import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type Approval,
  CODE_CONFIGS,
  type DoctorReport,
  type Finding,
  type InitResult,
  initProject,
  JSON_CONFIG,
  type LogEvent,
  listRuns,
  loadConfig,
  type PatchAttempt,
  type Property,
  parseConfig,
  type Run,
  resolveInsideRoot,
  runDoctor,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  bundledTools,
  decideProperty,
  diffLatest,
  type Explanation,
  explainFinding,
  listProperties,
  type Profile,
  type RunSummary,
  readArtifact,
  run,
  showProperty,
} from '@under18dev/veritas-engine';
import { applyImprovement, type PlanResult, planImprovement } from '@under18dev/veritas-improvement';

export type ConfigFile =
  | { kind: 'json'; file: string; raw: unknown }
  | { kind: 'code'; file: string }
  | { kind: 'none' };

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
        return listProperties(root).properties;
      } catch (error) {
        if (noRun(error)) return [];
        throw error;
      }
    },
    property: (id) => showProperty(root, id),
    decide: (id, decision, reason) => decideProperty(root, id, decision, { reason }),
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
      writeFileSync(resolveInsideRoot(root, JSON_CONFIG), `${JSON.stringify(raw, null, 2)}\n`);
    },
  };
}
