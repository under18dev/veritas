import { readFileSync } from 'node:fs';
import path from 'node:path';
import { copyFixture, runCli } from './helpers.js';

// Shared by the pipeline acceptance tests, which are split over several files so they run in parallel.
export interface RunJson {
  status: string;
  exitCode: number;
  runId: string;
  stages: { stage: string; status: string; messages: string[] }[];
  findings: {
    id: string;
    kind: string;
    certainty: string;
    propertyIds: string[];
    mutantIds: string[];
    claimIds: string[];
  }[];
}

export function readRunArtifact<T>(dir: string, runId: string, file: string): T {
  return (JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, file), 'utf8')) as { data: T }).data;
}

export function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });
  const init = runCli(['init', '--yes'], dir);

  if (init.status !== 0) throw new Error(init.stderr);

  return dir;
}
