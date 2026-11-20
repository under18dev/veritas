import type { Finding, Property, Run } from '@under18dev/veritas-core';
import { VeritasError } from '@under18dev/veritas-core';
import type { PlanResult } from '@under18dev/veritas-improvement';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import type { TuiApi } from '../src/api.js';
import { applyStageEvent } from '../src/screens/Run.js';
import { leaves, parseValue, setAt, validate } from '../src/screens/Settings.js';

const KEY = { up: '\u001B[A', down: '\u001B[B', enter: '\r', escape: '\u001B' };
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN = {
  id: 'R-1',
  command: 'run',
  args: [],
  profile: 'quick',
  scope: { root: '/p', paths: [] },
  startedAt: '2026-11-20T00:00:00.000Z',
  status: 'succeeded',
  exitCode: 4,
  verdict: 'inconclusive',
  policyReasons: ['1 test is weak'],
  stages: [{ stage: 'index', status: 'succeeded' }],
} as unknown as Run;

const FINDING = {
  id: 'F-1',
  kind: 'weak_test',
  title: 'boundary is not checked',
  severity: 'medium',
  certainty: 'likely',
  locations: [{ file: 'test/a.test.ts' }],
  propertyIds: [],
  sourceIds: [],
  testIds: [],
  mutantIds: [],
  claimIds: [],
  explanation: ['the test never uses 1000'],
  nextActions: ['add a test at 1000'],
} as unknown as Finding;

const PROPERTY = {
  id: 'P-1',
  version: 1,
  description: 'discount above 1000',
  template: 'threshold',
  targetSymbols: ['discountAmount'],
  status: 'proposed',
  origin: 'docs',
  sourceIds: [],
  assumptions: [],
  inputDomain: {},
  citations: ['orders over 1000 get a discount'],
  conflictsWith: [],
  confidence: 'high',
  implementationAgreement: 'agree',
  experimental: false,
} as unknown as Property;

const PLAN = {
  planId: 'IP-1',
  runId: 'R-1',
  outcome: 'planned',
  plan: {
    goal: 'add a boundary test',
    proposedTestCases: [{ file: 'test/x.test.ts', name: 'at 1000', input: {}, rationale: 'spec' }],
    risks: [],
    patchPreview: '+ it("at 1000")',
  },
  approvalToken: 'a'.repeat(64),
  specViolationCandidates: [],
  implementationFixProposals: [],
  skipped: [],
  reasons: [],
  planFile: '.veritas/improvements/IP-1/plan.json',
} as unknown as PlanResult;

function fakeApi(overrides: Partial<TuiApi> = {}): TuiApi {
  return {
    root: '/projects/shop',
    runs: () => ['R-1'],
    readRun: () => RUN,
    readFindings: () => [FINDING],
    explain: () =>
      ({
        runId: 'R-1',
        finding: FINDING,
        properties: [PROPERTY],
        sources: [],
        statements: [],
        tests: [],
        assessments: [],
        mutants: [],
        claims: [],
      }) as never,
    doctor: async () => ({
      root: '/p',
      os: { platform: 'darwin', arch: 'arm64', release: '1' },
      capabilities: [],
      features: [{ feature: 'mutate', state: 'enabled', missing: [] }],
    }),
    init: vi.fn(() => ({ nextSteps: ['veritas run'] }) as never),
    properties: () => [PROPERTY],
    property: () => ({ property: PROPERTY, approvals: [] }),
    decide: vi.fn(
      async (id, decision, reason) => ({ propertyId: id, decision, reason, actor: 'alice' }) as never,
    ),
    diff: () => null,
    run: vi.fn(() => new Promise<never>(() => {})),
    plan: vi.fn(async () => PLAN),
    apply: vi.fn(
      async () =>
        ({
          id: 'PA-1',
          planId: 'IP-1',
          outcome: 'improved',
          rolledBack: false,
          before: null,
          after: null,
          reasons: [],
        }) as never,
    ),
    readConfig: () => ({
      kind: 'json',
      file: '/p/.veritas/config.json',
      raw: { mutation: { timeoutMs: 1000 } },
    }),
    writeConfig: vi.fn(),
    ...overrides,
  };
}

let unmount: (() => void) | undefined;
afterEach(() => unmount?.());

async function open(api: TuiApi, screen: number) {
  const app = render(<App api={api} />);
  unmount = app.unmount;
  await tick();
  for (let i = 0; i < screen; i++) app.stdin.write(KEY.down);
  await tick();
  app.stdin.write(KEY.enter);
  await tick();

  return app;
}

/** Wait until the screen shows `text`; loads are asynchronous, so a key sent earlier would be lost. */
async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 200 && !app.lastFrame()?.includes(text); i++) await tick(10);
  expect(app.lastFrame()).toContain(text);
  // Input handlers subscribe in effects, after the frame is drawn.
  await tick();
}

async function press(app: ReturnType<typeof render>, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k);
    await tick();
  }
}

describe('the TUI', () => {
  it('shows the latest run and the menu, and help on ?', async () => {
    const app = render(<App api={fakeApi()} />);
    unmount = app.unmount;
    await until(app, 'latest R-1 · inconclusive · exit 4');
    expect(app.lastFrame()).toContain('Specifications');
    await press(app, '?');
    await until(app, 'a accepts and r rejects');
  });

  it('offers init on a project without configuration', async () => {
    const api = fakeApi({ readConfig: () => ({ kind: 'none' }) });
    const app = await open(api, 0);
    await until(app, 'no Veritas configuration');
    await press(app, 'y');
    await until(app, 'Created the configuration');
    expect(api.init).toHaveBeenCalled();
  });

  it('follows a run to a finding and its evidence', async () => {
    const app = await open(fakeApi(), 1);
    await until(app, 'R-1');
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    await press(app, KEY.enter);
    await until(app, 'add a test at 1000');
    expect(app.lastFrame()).toContain('P-1 [proposed] discount above 1000');
  });

  it('records a decision only with a reason', async () => {
    const api = fakeApi();
    const app = await open(api, 2);
    await until(app, 'discount above 1000');
    await press(app, KEY.enter);
    await until(app, 'orders over 1000 get a discount');
    await press(app, 'a');
    await until(app, 'Reason to accept P-1');
    await press(app, KEY.enter);
    await until(app, 'A reason is required');
    expect(api.decide).not.toHaveBeenCalled();
    await press(app, 'a');
    await until(app, 'Reason to accept P-1');
    await press(app, 'o', 'k', KEY.enter);
    expect(api.decide).toHaveBeenCalledWith('P-1', 'accept', 'ok');
    await until(app, 'Recorded accept of P-1 by alice');
  });

  it('starts a run offline by default and cancels it with Esc', async () => {
    const api = fakeApi();
    const app = await open(api, 3);
    await until(app, 'Profile: quick');
    await press(app, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    expect(api.run).toHaveBeenCalledTimes(1);
    const [request, signal] = vi.mocked(api.run).mock.calls[0] ?? [];
    expect(request).toEqual({ profile: 'quick', offline: true, includeProposed: false });
    expect(signal?.aborted).toBe(false);
    await until(app, 'Esc cancels');
    await press(app, KEY.escape);
    expect(signal?.aborted).toBe(true);
  });

  it('applies a plan only after it is confirmed, with the plan token', async () => {
    const api = fakeApi();
    const app = await open(api, 4);
    await until(app, 'Create a plan');
    await press(app, KEY.enter);
    expect(api.plan).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    await until(app, 'add a boundary test');
    await press(app, 'a');
    await until(app, 'Apply plan IP-1?');
    await press(app, 'n');
    await until(app, 'a apply this plan');
    expect(api.apply).not.toHaveBeenCalled();
    await press(app, 'a');
    await until(app, 'Apply plan IP-1?');
    await press(app, 'y');
    expect(api.apply).toHaveBeenCalledWith('IP-1', 'a'.repeat(64), expect.any(AbortSignal));
    await until(app, 'attempt PA-1: improved');
  });

  it('saves a setting only when it is valid and confirmed', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'mutation.timeoutMs = 1000');
    const edit = async (...keys: string[]) => {
      await press(app, KEY.enter);
      await until(app, 'New value for mutation.timeoutMs');
      await press(app, '\u007F', '\u007F', '\u007F', '\u007F', '\u007F', ...keys, KEY.enter);
    };
    // Not a number: refused before validation.
    await edit('x');
    await until(app, 'not valid JSON');
    await press(app, KEY.escape);
    await until(app, 'mutation.timeoutMs = 1000');
    await edit('-', '5');
    await until(app, 'mutation.timeoutMs:');
    expect(api.writeConfig).not.toHaveBeenCalled();
    await press(app, KEY.escape);
    await until(app, 'mutation.timeoutMs = 1000');
    await edit('5', '0', '0', '0');
    await until(app, '+ 5000');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({ mutation: { timeoutMs: 5000 } });
  });

  it('does not edit a code configuration', async () => {
    const app = await open(
      fakeApi({ readConfig: () => ({ kind: 'code', file: '/p/veritas.config.ts' }) }),
      5,
    );
    await until(app, 'is a code configuration');
  });

  it('shows the code and hint of an error', async () => {
    const api = fakeApi({
      properties: () => {
        throw new VeritasError('user', 'CONFIG_INVALID', 'invalid configuration', 'fix it');
      },
    });
    const app = await open(api, 2);
    await until(app, 'CONFIG_INVALID: invalid configuration');
    expect(app.lastFrame()).toContain('hint: fix it');
  });
});

describe('helpers', () => {
  it('tracks stage progress from run events', () => {
    let lines = applyStageEvent([], {
      time: '',
      level: 'debug',
      message: '',
      event: 'stage',
      stage: 'index',
      at: 'start',
    });
    lines = applyStageEvent(lines, {
      time: '',
      level: 'debug',
      message: '',
      event: 'stage',
      stage: 'spec',
      at: 'start',
    });
    lines = applyStageEvent(lines, {
      time: '',
      level: 'debug',
      message: '',
      event: 'stage',
      stage: 'index',
      at: 'end',
      status: 'succeeded',
      durationMs: 5,
    });
    expect(lines).toEqual([
      { stage: 'index', status: 'succeeded', durationMs: 5 },
      { stage: 'spec', status: 'running' },
    ]);
    expect(applyStageEvent(lines, { time: '', level: 'info', message: 'hello' })).toBe(lines);
  });

  it('edits nested configuration values', () => {
    const raw = { a: { b: 1, c: [1, 2] }, d: 'x' };
    expect(leaves(raw).map((l) => l.path.join('.'))).toEqual(['a.b', 'a.c', 'd']);
    expect(setAt(raw, ['a', 'b'], 2)).toEqual({ a: { b: 2, c: [1, 2] }, d: 'x' });
    expect(raw.a.b).toBe(1);
    expect(parseValue('true', false)).toBe(true);
    expect(parseValue('hello', 'x')).toBe('hello');
    expect(typeof parseValue('hello', 3)).toBe('symbol');
    expect(validate({ mutation: { timeoutMs: -5 } })[0]).toMatch(/^mutation\.timeoutMs:/);
    expect(validate({})).toEqual([]);
  });
});
