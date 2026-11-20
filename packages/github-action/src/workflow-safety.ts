import YAML from 'yaml';

export interface WorkflowSafety {
  ok: boolean;
  problems: string[];
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function containsSecret(value: unknown): boolean {
  // `secrets.*` and the automatic token (`github.token`, `secrets.GITHUB_TOKEN`) are both credentials.
  if (typeof value === 'string') {
    return /\bsecrets\.[A-Za-z_][A-Za-z0-9_]*|\bsecrets\[|\bgithub\.token\b|\bgithub\[\s*['"]token['"]\s*\]/.test(
      value,
    );
  }

  if (Array.isArray(value)) return value.some(containsSecret);

  return value && typeof value === 'object'
    ? Object.entries(value).some(([key, child]) => containsSecret(key) || containsSecret(child))
    : false;
}

function readOnly(value: unknown): boolean {
  const permissions = record(value);

  return (
    permissions.contents === 'read' &&
    !Object.entries(permissions).some(([key, v]) => key !== 'contents' && v !== 'none' && v !== undefined)
  );
}

export function checkWorkflowSafety(yamlText: string): WorkflowSafety {
  const problems: string[] = [];
  let document: Record<string, unknown>;

  try {
    document = record(YAML.parse(yamlText));
  } catch (error) {
    return { ok: false, problems: [`invalid workflow YAML: ${String(error)}`] };
  }
  const triggers = document.on ?? document['"on"'] ?? document.true;
  const triggerRecord = record(triggers);
  const hasPr =
    triggers === 'pull_request' ||
    (Array.isArray(triggers) && triggers.includes('pull_request')) ||
    Object.hasOwn(triggerRecord, 'pull_request') ||
    /^\s*pull_request\s*:/m.test(yamlText);
  const hasTarget =
    triggers === 'pull_request_target' ||
    (Array.isArray(triggers) && triggers.includes('pull_request_target')) ||
    Object.hasOwn(triggerRecord, 'pull_request_target') ||
    /pull_request_target/.test(yamlText);

  if (hasPr && document.permissions === undefined)
    problems.push('pull_request workflow is missing top-level permissions');

  if (hasPr && document.permissions !== undefined && !readOnly(document.permissions))
    problems.push('pull_request workflow permissions must be read-only contents: read');

  if (
    hasTarget &&
    yamlText.includes('actions/checkout') &&
    yamlText.includes('github.event.pull_request.head.sha')
  )
    problems.push('pull_request_target must not check out the pull request head SHA');
  const jobs = record(document.jobs);

  for (const [jobId, raw] of Object.entries(jobs)) {
    const job = record(raw);
    const prJob = hasPr || /pull_request/.test(String(job.if ?? ''));

    if (!prJob) continue;

    if (job.permissions !== undefined && !readOnly(job.permissions))
      problems.push(`job ${jobId} permissions must be read-only contents: read`);

    if (containsSecret(job))
      problems.push(`job ${jobId} references secrets or the GitHub token in a pull_request workflow`);

    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      const stepRecord = record(step);

      if (typeof stepRecord.uses !== 'string' || !stepRecord.uses.startsWith('actions/checkout@')) continue;
      const withRecord = record(stepRecord.with);

      if (
        hasTarget &&
        typeof withRecord.ref === 'string' &&
        withRecord.ref.includes('github.event.pull_request.head.sha')
      )
        problems.push('pull_request_target must not check out the pull request head SHA');

      if (withRecord['persist-credentials'] !== false && withRecord['persist-credentials'] !== 'false')
        problems.push(`job ${jobId} checkout must set persist-credentials: false`);
    }
  }

  if (/workflow_run/.test(yamlText) && /pull_request/.test(yamlText))
    problems.push('workflow_run must not run privileged checks for fork pull requests');

  return { ok: problems.length === 0, problems };
}
