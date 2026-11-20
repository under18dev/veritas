import { readFileSync } from 'node:fs';

export interface RunPlan {
  mode: 'pull_request' | 'push' | 'manual';
  since: string | null;
  fromFork: boolean;
  skip: null | { reason: string };
}
export interface EventEnvironment {
  eventName?: string;
  eventPath?: string;
  repository?: string;
  baseRef?: string;
}

export function readEventPayload(environment: EventEnvironment = process.env): Record<string, unknown> {
  if (!environment.eventPath)
    throw new Error('GITHUB_EVENT_PATH is not set; cannot determine the GitHub event');

  try {
    const value: unknown = JSON.parse(readFileSync(environment.eventPath, 'utf8'));

    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('event payload is not an object');

    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `cannot read GitHub event payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stringAt(value: unknown, ...keys: string[]): string | null {
  let current = value;

  for (const key of keys) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === 'string' && current.length > 0 ? current : null;
}

function isFork(payload: Record<string, unknown>, repository?: string): boolean {
  const head = stringAt(payload, 'pull_request', 'head', 'repo', 'full_name');
  const base = stringAt(payload, 'pull_request', 'base', 'repo', 'full_name') ?? repository;

  return Boolean(head && base && head !== base);
}

export function planFromEvent(
  environment: EventEnvironment = process.env,
  payload = readEventPayload(environment),
): RunPlan {
  const name = environment.eventName;

  if (!name) throw new Error('GITHUB_EVENT_NAME is not set; cannot determine the GitHub event');

  if (name === 'pull_request_target' || (name === 'workflow_run' && isFork(payload, environment.repository)))
    throw new Error(
      'refusing privileged GitHub event: pull_request_target/workflow_run could execute untrusted fork code',
    );

  if (name === 'pull_request')
    return {
      mode: 'pull_request',
      since: stringAt(payload, 'pull_request', 'base', 'sha'),
      fromFork: isFork(payload, environment.repository),
      skip: null,
    };

  if (name === 'push')
    return { mode: 'push', since: stringAt(payload, 'before'), fromFork: false, skip: null };

  if (name === 'workflow_dispatch' || name === 'schedule' || name === 'repository_dispatch')
    return { mode: 'manual', since: null, fromFork: false, skip: null };
  throw new Error(`unsupported GitHub event: ${name}`);
}
