import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planFromEvent, readEventPayload } from '../src/event.js';
import { changedFiles } from '../src/main.js';
import { checkWorkflowSafety } from '../src/workflow-safety.js';

const pr = (fork = false) => ({
  pull_request: {
    base: { sha: 'base-sha', repo: { full_name: 'org/project' } },
    head: { repo: { full_name: fork ? 'other/project' : 'org/project' } },
  },
});

describe('event planning', () => {
  it.each([
    ['push', { before: 'old' }, 'push', 'old', false],
    ['pull request', pr(), 'pull_request', 'base-sha', false],
    ['fork pull request', pr(true), 'pull_request', 'base-sha', true],
    ['manual dispatch', {}, 'manual', null, false],
  ])('%s', (_, payload, mode, since, fork) => {
    const plan = planFromEvent(
      {
        eventName: mode === 'push' ? 'push' : mode === 'pull_request' ? 'pull_request' : 'workflow_dispatch',
        repository: 'org/project',
      },
      payload,
    );
    expect(plan.mode).toBe(mode);
    expect(plan.since).toBe(since);
    expect(plan.fromFork).toBe(fork);
  });
  it('marks a same-repository pull request as not a fork', () =>
    expect(planFromEvent({ eventName: 'pull_request', repository: 'org/project' }, pr()).fromFork).toBe(
      false,
    ));
  it('refuses pull_request_target', () =>
    expect(() => planFromEvent({ eventName: 'pull_request_target' }, pr())).toThrow(/refusing privileged/));
  it('refuses workflow_run for fork pull requests', () =>
    expect(() => planFromEvent({ eventName: 'workflow_run', repository: 'org/project' }, pr(true))).toThrow(
      /refusing privileged/,
    ));
  it('allows workflow_run without a fork PR', () =>
    expect(() => planFromEvent({ eventName: 'workflow_run', repository: 'org/project' }, {})).toThrow(
      /unsupported/,
    ));
  it('reports a missing event file clearly', () =>
    expect(() => readEventPayload({ eventPath: '/does/not/exist' })).toThrow(
      /cannot read GitHub event payload/,
    ));
  it('reports invalid JSON clearly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'veritas-action-'));
    const file = path.join(dir, 'event.json');
    writeFileSync(file, '{');
    expect(() => readEventPayload({ eventPath: file })).toThrow(/cannot read GitHub event payload/);
  });
  it('reports a missing event name clearly', () =>
    expect(() => planFromEvent({ eventPath: '/tmp/event' }, {})).toThrow(/GITHUB_EVENT_NAME/));
});

describe('changed files', () => {
  it('returns null without a base', async () => expect(await changedFiles(process.cwd(), null)).toBeNull());
  it('does not skip when git diff fails', async () =>
    expect(await changedFiles('/tmp', 'not-a-real-sha')).toBeNull());
  it('refuses a base that reads as an option', async () => {
    // In this repository a valid ref works; one starting with `-` is refused before git runs.
    expect(await changedFiles(process.cwd(), 'HEAD')).not.toBeNull();
    expect(await changedFiles(process.cwd(), '--output=/tmp/veritas-injected')).toBeNull();
  });
});

describe('workflow safety', () => {
  it('accepts the repository CI workflow', () =>
    expect(checkWorkflowSafety(readFileSync('.github/workflows/ci.yml', 'utf8')).ok).toBe(true));
  it('accepts the recommended example', () =>
    expect(
      checkWorkflowSafety(readFileSync('packages/github-action/examples/pull-request.yml', 'utf8')).ok,
    ).toBe(true));
  it.each([
    [
      'head checkout',
      `on: pull_request_target\npermissions: { contents: read }\njobs: { x: { steps: [{ uses: actions/checkout@v4, with: { ref: "\${{ github.event.pull_request.head.sha }}", persist-credentials: false } }] } }`,
      /head SHA/,
    ],
    [
      'secrets',
      `on: pull_request\npermissions: { contents: read }\njobs: { x: { steps: [{ run: "echo \${{ secrets.TOP_SECRET }}" }] } }`,
      /references secrets/,
    ],
    [
      'missing permissions',
      `on: pull_request\njobs: { x: { steps: [{ uses: actions/checkout@v4, with: { persist-credentials: false } }] } }`,
      /missing top-level permissions/,
    ],
    [
      'write permissions',
      `on: pull_request\npermissions: { contents: write }\njobs: { x: { steps: [] } }`,
      /read-only/,
    ],
    [
      'true credentials',
      `on: pull_request\npermissions: { contents: read }\njobs: { x: { steps: [{ uses: actions/checkout@v4, with: { persist-credentials: true } }] } }`,
      /persist-credentials/,
    ],
    [
      'missing credentials',
      `on: pull_request\npermissions: { contents: read }\njobs: { x: { steps: [{ uses: actions/checkout@v4 }] } }`,
      /persist-credentials/,
    ],
    [
      'workflow run fork',
      `on: workflow_run\njobs: { x: { if: github.event.workflow_run.event == 'pull_request', steps: [] } }`,
      /workflow_run/,
    ],
  ])('flags %s', (_, yaml, problem) => {
    const result = checkWorkflowSafety(yaml);
    expect(result.ok).toBe(false);
    expect(result.problems.some((item) => problem.test(item))).toBe(true);
  });
  it('rejects malformed YAML', () => expect(checkWorkflowSafety('on: [').ok).toBe(false));
  it('allows non-PR workflows without checkout restrictions', () =>
    expect(checkWorkflowSafety('on: push\njobs: { x: { steps: [{ uses: actions/checkout@v4 }] } }').ok).toBe(
      true,
    ));
  it('returns an empty problem list for a safe document', () =>
    expect(checkWorkflowSafety('on: push\njobs: {}').problems).toEqual([]));
});

describe('secret handling', () => {
  it('does not reference privileged token names in the action runner', () => {
    const source = readFileSync('packages/github-action/src/main.ts', 'utf8');
    expect(source).not.toMatch(/GITHUB_TOKEN|secrets/);
  });
});

describe('workflow token exposure', () => {
  // GitHub expression syntax, assembled so the source has no literal template placeholder.
  const expression = (inner: string) => ['$', '{{ ', inner, ' }}'].join('');
  it.each([expression('github.token'), expression('secrets.GITHUB_TOKEN'), expression("github['token']")])(
    'flags %s in a pull_request job',
    (value) => {
      const yaml = [
        'on: pull_request',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  verify:',
        '    runs-on: ubuntu-latest',
        '    env:',
        `      GH_TOKEN: ${value}`,
        '    steps:',
        '      - run: echo "$GH_TOKEN"',
        '',
      ].join('\n');
      const result = checkWorkflowSafety(yaml);
      expect(result.ok).toBe(false);
      expect(result.problems.join('\n')).toMatch(/token/);
    },
  );
});
