import type { Finding, Property, Run } from '@under18dev/veritas-core';
import { VeritasError } from '@under18dev/veritas-core';
import type { PlanResult } from '@under18dev/veritas-improvement';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import type { TuiApi } from '../src/api.js';
import { ago, duration } from '../src/components.js';
import { abbreviateHome, nextSteps } from '../src/screens/Home.js';
import { appendLog, applyStageEvent, clock } from '../src/screens/Run.js';
import { leaves, parseValue, setAt, validate } from '../src/screens/Settings.js';

const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  enter: '\r',
  escape: '\u001B',
  backspace: '\u007F',
};
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN = {
  id: 'R-1',
  command: 'run',
  args: [],
  profile: 'quick',
  scope: { root: '/p', paths: [] },
  startedAt: '2026-11-20T00:00:00.000Z',
  finishedAt: '2026-11-20T00:00:12.300Z',
  status: 'succeeded',
  exitCode: 4,
  verdict: 'inconclusive',
  policyReasons: ['1 test is weak'],
  stages: [
    { stage: 'index', status: 'succeeded', durationMs: 4 },
    { stage: 'mutate', status: 'partial', durationMs: 1600 },
  ],
  partial: false,
} as unknown as Run;

const FINDING = {
  id: 'F-1',
  kind: 'weak_test',
  title: 'boundary is not checked',
  severity: 'medium',
  certainty: 'suspected',
  locations: [{ file: 'test/a.test.ts' }],
  propertyIds: [],
  sourceIds: [],
  testIds: [],
  mutantIds: [],
  claimIds: [],
  explanation: ['the test never uses 1000'],
  nextActions: ['add a test at 1000'],
} as unknown as Finding;

const HIGH = {
  ...FINDING,
  id: 'F-2',
  kind: 'counterexample',
  title: 'returns 0 for 1000',
  severity: 'high',
  certainty: 'confirmed',
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
  confidence: {
    sourceQuality: 'primary',
    agreement: 'single_source',
    implementationAlignment: 'agree',
    independence: 'independent',
    freshness: 'current',
  },
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
    readFindings: () => [FINDING, HIGH],
    readEvidence: () => ({
      tests: [
        ['meaningful_with_evidence', 2],
        ['weak_or_incomplete', 1],
      ],
      mutants: [
        ['killed', 5],
        ['survived', 2],
      ],
      pbt: null,
      claims: [['proven_within_model', 1]],
    }),
    explain: () =>
      ({
        runId: 'R-1',
        finding: FINDING,
        properties: [PROPERTY],
        sources: [],
        statements: [{ range: { start: 3 }, quote: 'orders over 1000 get a discount' }],
        tests: [],
        assessments: [{ testId: 'T-1', outcome: 'weak_or_incomplete', rationale: ['no boundary input'] }],
        mutants: [],
        claims: [],
      }) as never,
    doctor: async () => ({
      root: '/p',
      os: { platform: 'darwin', arch: 'arm64', release: '1' },
      capabilities: [],
      features: [
        { feature: 'mutate', state: 'enabled', missing: [] },
        { feature: 'improve', state: 'degraded', missing: ['llm'] },
      ],
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
      file: '/projects/shop/.veritas/config.json',
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
    await until(app, 'latest R-1 · exit 4');
    expect(app.lastFrame()).toContain(' inconclusive ');
    expect(app.lastFrame()).toContain('Specifications');
    await press(app, '?');
    await until(app, 'a accepts and r rejects');
  });

  it('opens a screen with its number key', async () => {
    const app = render(<App api={fakeApi()} />);
    unmount = app.unmount;
    await press(app, '4');
    await until(app, 'Profile: quick');
    // The menu follows: Esc returns to it with Run highlighted.
    await press(app, KEY.escape);
    expect(app.lastFrame()).toContain('› 4 Run');
  });

  it('shows the stages and a live activity log while a run works, and a summary once it ends', async () => {
    let finish: (summary: unknown) => void = () => {};
    const api = fakeApi({
      run: vi.fn((_request, _signal, onEvent) => {
        onEvent({
          time: '2026-11-21T10:00:01.000Z',
          level: 'debug',
          message: 'stage index started',
          event: 'stage',
          stage: 'index',
          at: 'start',
        });
        onEvent({
          time: '2026-11-21T10:00:02.000Z',
          level: 'debug',
          message: 'vitest started',
          event: 'process-start',
        });

        return new Promise((resolve) => {
          finish = resolve as never;
        });
      }) as TuiApi['run'],
    });
    const app = await open(api, 3);
    await until(app, 'Profile: quick');
    await press(app, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await until(app, '10:00:02 vitest started');
    expect(app.lastFrame()).toMatch(/index\s+running/);
    expect(app.lastFrame()).toMatch(/discover\s+waiting/);
    expect(app.lastFrame()).toContain('0/6 stages');
    finish({
      runId: 'R-2',
      dir: '',
      run: { ...RUN, stages: [{ stage: 'index', status: 'succeeded', durationMs: 12 }] },
      findings: [FINDING],
      decision: { exitCode: 0, verdict: 'pass', reasons: [] },
    });
    await until(app, ' pass ');
    // The activity log is gone; the summary and the recorded stages stay.
    expect(app.lastFrame()).not.toContain('vitest started');
    expect(app.lastFrame()).toContain('1 finding(s)');
    expect(app.lastFrame()).toMatch(/index\s+succeeded 12 ms/);
    await press(app, KEY.enter);
    await until(app, 'R-1');
  });

  it('offers init on a project without configuration', async () => {
    const api = fakeApi({ readConfig: () => ({ kind: 'none' }) });
    const app = await open(api, 0);
    await until(app, 'no Veritas configuration');
    await press(app, 'y');
    await until(app, 'Created the configuration');
    expect(api.init).toHaveBeenCalled();
  });

  it('keeps a long project path on one line, cut at the start, with the home directory as ~', async () => {
    const root = `/home/someone/${'very-long-directory-name/'.repeat(8)}shop`;
    const app = await open(fakeApi({ root }), 0);
    await until(app, '/shop');
    const line =
      app
        .lastFrame()
        ?.split('\n')
        .find((l) => l.includes('path ')) ?? '';
    expect(line).toMatch(/path\s+…\S*\/shop /);
    expect(app.lastFrame()).not.toMatch(/^\s*very-long-directory-name/m);
    expect(abbreviateHome('/home/someone/work/shop', '/home/someone')).toBe('~/work/shop');
    expect(abbreviateHome('/home/someone', '/home/someone')).toBe('~');
    expect(abbreviateHome('/home/someone2/shop', '/home/someone')).toBe('/home/someone2/shop');
  });

  it('shows the project, the latest run, the tools and the next steps as cards on Home', async () => {
    const app = await open(fakeApi(), 0);
    await until(app, 'Latest run');
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Project');
    expect(frame).toMatch(/Latest run\s+inconclusive/);
    expect(frame).toContain('quick');
    expect(frame).toContain('took 12.3 s');
    expect(frame).toContain('exit 4');
    // The stage strip marks a partial stage, never as a success.
    expect(frame).toMatch(/✔ index/);
    expect(frame).toMatch(/! mutate partial/);
    expect(frame).toMatch(/2 findings:\s+1 high\s+1 medium/);
    // The evidence vector, not a single score.
    expect(frame).toContain('2 meaningful_with_evidence');
    expect(frame).toContain('1 weak_or_incomplete');
    expect(frame).toContain('2 survived');
    // The cards scroll; the next steps and the tools are further down.
    for (let i = 0; i < 8; i++) await press(app, KEY.down);
    await until(app, 'Next steps');
    expect(app.lastFrame()).toContain('Read 2 findings of the latest run');
    expect(app.lastFrame()).toContain('Review 1 proposed specification');
    for (let i = 0; i < 12; i++) await press(app, KEY.down);
    await until(app, 'Tools');
    expect(app.lastFrame()).toContain('✔ mutate');
    expect(app.lastFrame()).toContain('! improve');
    expect(app.lastFrame()).toContain('no llm limits improve');
    // A next step's key opens its screen.
    await press(app, '3');
    await until(app, 'discount above 1000');
  });

  it('points to the Run screen when there is no run yet', async () => {
    const app = await open(fakeApi({ runs: () => [], properties: () => [] }), 0);
    await until(app, 'No run yet: start one on Run');
    await press(app, '4');
    await until(app, 'Profile: quick');
  });

  it('follows a run to a finding and its evidence', async () => {
    const app = await open(fakeApi(), 1);
    await until(app, 'R-1');
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    await press(app, KEY.enter);
    await until(app, 'next: add a test at 1000');
    // The same lines as `veritas explain`, statements and assessments included.
    expect(app.lastFrame()).toContain('quote   line 3: "orders over 1000 get a discount"');
    expect(app.lastFrame()).toContain('assess  T-1: weak_or_incomplete - no boundary input');
    expect(app.lastFrame()).toContain('property P-1 [proposed, docs] discount above 1000');
  });

  it('records a decision only with a reason', async () => {
    const api = fakeApi();
    const app = await open(api, 2);
    await until(app, 'discount above 1000');
    await press(app, KEY.enter);
    await until(app, 'orders over 1000 get a discount');
    expect(app.lastFrame()).toContain('evidence: sourceQuality=primary agreement=single_source');
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

  it('shows a run cancelled with Esc as cancelled even when the run returns a summary', async () => {
    let emit: (message: string) => void = () => {};
    const api = fakeApi({
      // The engine does not reject a cancelled run: it records the stages as cancelled and returns a summary.
      run: vi.fn(
        (_request, signal, onEvent) =>
          new Promise((resolve) => {
            emit = (message) =>
              onEvent({ time: '2026-11-21T10:00:03.000Z', level: 'debug', message, event: 'process-start' });
            emit('mutator started');
            signal.addEventListener('abort', () => {
              emit('mutator exited SIGKILL');
              resolve({
                runId: 'R-3',
                dir: '',
                run: {
                  ...RUN,
                  stages: [
                    { stage: 'index', status: 'succeeded', durationMs: 5 },
                    { stage: 'mutate', status: 'cancelled', durationMs: 7 },
                  ],
                },
                findings: [],
                decision: { exitCode: 0, verdict: 'pass_with_warnings', reasons: [] },
              } as never);
            });
          }),
      ) as TuiApi['run'],
    });
    const app = await open(api, 3);
    await until(app, 'Profile: quick');
    await press(app, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await until(app, 'mutator started');
    await press(app, KEY.escape);
    await until(app, 'Run cancelled.');
    const frame = app.lastFrame() ?? '';
    // No verdict claims the run passed; the log, the recorded stages and the run id stay.
    expect(frame).not.toContain('pass_with_warnings');
    expect(frame).toContain('R-3');
    expect(frame).toMatch(/mutate\s+cancelled 7 ms/);
    expect(frame).toContain('10:00:03 mutator started');
    expect(frame).toContain('10:00:03 mutator exited SIGKILL');
    expect(frame).toContain('Enter opens Results for this cancelled run');
    await press(app, KEY.enter);
    await until(app, 'R-1');
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

  it('keeps the last activity lines with their time of day, and formats clocks', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      time: `2026-11-21T10:00:0${i}.000Z`,
      level: 'debug' as const,
      message: `event\n ${i}`,
    }));
    const log = appendLog([], events, 3);
    expect(log.map((l) => [l.id, l.time, l.text])).toEqual([
      [3, '10:00:02', 'event 2'],
      [4, '10:00:03', 'event 3'],
      [5, '10:00:04', 'event 4'],
    ]);
    expect(appendLog(log, [])).toBe(log);
    expect(clock(0)).toBe('0:00');
    expect(clock(65_400)).toBe('1:05');
  });

  it('says what to do next, and formats durations and times', () => {
    expect(nextSteps({ config: 'json', latest: null, proposed: 0, doctor: undefined })).toEqual([
      { key: '4', text: 'No run yet: start one on Run' },
    ]);
    const evidence = { tests: null, mutants: null, pbt: null, claims: null };
    expect(
      nextSteps({
        config: 'json',
        latest: { run: RUN, findings: [], evidence },
        proposed: 0,
        doctor: undefined,
      }),
    ).toEqual([{ key: '2', text: 'See why the latest run did not pass' }]);
    expect(duration(850)).toBe('850 ms');
    expect(duration(12_345)).toBe('12.3 s');
    expect(duration(245_000)).toBe('4m 05s');
    expect(ago('2026-11-21T10:00:00Z', Date.parse('2026-11-21T12:30:00Z'))).toBe('2h ago');
  });
});
