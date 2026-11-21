import type { Finding, Property, Run } from '@under18dev/veritas-core';
import { VeritasError } from '@under18dev/veritas-core';
import type { PlanResult } from '@under18dev/veritas-improvement';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import type { TuiApi } from '../src/api.js';
import { ago, duration, statusColor } from '../src/components.js';
import { abbreviateHome, nextSteps } from '../src/screens/Home.js';
import { sortFindings } from '../src/screens/Results.js';
import { appendLog, applyStageEvent, clock } from '../src/screens/Run.js';
import {
  diff,
  fieldLabel,
  getAt,
  humanize,
  parseText,
  resetField,
  SECTIONS,
  setAt,
  setField,
  tidy,
  unsetAt,
  validate,
} from '../src/screens/Settings.js';

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

// Each test drives the TUI key by key and waits for frames; slow CI runners (Windows) need more than the default 5 s.
describe('the TUI', { timeout: 20_000 }, () => {
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

  it('lists runs with a verdict badge, finding count and time, and a run with sorted, colored findings', async () => {
    const app = await open(fakeApi(), 1);
    await until(app, ' inconclusive ');
    expect(app.lastFrame()).toMatch(/inconclusive\s+2 findings\s+quick\s+\S+ ago\s+12\.3 s/);
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    const frame = app.lastFrame() ?? '';
    expect(frame).toMatch(/Run\s+inconclusive/);
    expect(frame).toContain('1 test is weak');
    expect(frame).toMatch(/✔ index 4 ms/);
    expect(frame).toMatch(/! mutate partial 1\.6 s/);
    expect(frame).toMatch(/1 counterexample\s+1 weak_test/);
    // Most severe first, with the certainty.
    const lines = frame.split('\n');
    const high = lines.findIndex((l) => /HIGH\s+confirmed\s+returns 0 for 1000/.test(l));
    const medium = lines.findIndex((l) => /MEDIUM\s+suspected\s+boundary is not checked/.test(l));
    expect(high).toBeGreaterThan(-1);
    expect(medium).toBeGreaterThan(high);
    await press(app, 'e');
    await until(app, 'counts per status');
    expect(app.lastFrame()).toContain('1 proven_within_model');
  });

  it('marks a partial run in the run list before the fields a narrow terminal cuts', async () => {
    const app = await open(fakeApi({ readRun: () => ({ ...RUN, partial: true }) as Run }), 1);
    await until(app, ' partial ');
    expect(app.lastFrame()).toMatch(/inconclusive\s+partial\s+2 findings/);
  });

  it('keeps the finding under the cursor when the evidence counts are shown and hidden', async () => {
    const app = await open(fakeApi(), 1);
    await until(app, 'R-1');
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    await press(app, KEY.down, 'e');
    await until(app, 'counts per status');
    await press(app, 'e');
    await until(app, '› MEDIUM');
    await press(app, KEY.enter);
    await until(app, 'Why it was reported');
    expect(app.lastFrame()).toMatch(/MEDIUM\s+suspected\s+weak_test/);
  });

  it('follows a run to a finding, its evidence in sections, and the suggested next actions apart', async () => {
    const app = await open(fakeApi(), 1);
    await until(app, 'R-1');
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    await press(app, KEY.down, KEY.enter);
    await until(app, 'Why it was reported');
    const frame = app.lastFrame() ?? '';
    expect(frame).toMatch(/MEDIUM\s+suspected\s+weak_test/);
    expect(frame).toContain('the test never uses 1000');
    expect(frame).toContain('EVIDENCE recorded by the run');
    expect(frame).toContain('Locations (1)');
    expect(frame).toContain('test/a.test.ts');
    // The rest is further down; the view scrolls.
    for (let i = 0; i < 20; i++) await press(app, KEY.down);
    await until(app, 'SUGGESTED next actions, not verified');
    const end = app.lastFrame() ?? '';
    expect(end).toContain('> add a test at 1000');
    expect(end).toContain('T-1: weak_or_incomplete no boundary input');
    expect(end).toContain('P-1 [proposed, docs] discount above 1000');
  });

  it('shows the finding and its IDs when the evidence of an older run cannot be read', async () => {
    const app = await open(
      fakeApi({
        explain: () => {
          throw new VeritasError('user', 'FINDING_NOT_FOUND', 'no finding F-1 in run R-2');
        },
      }),
      1,
    );
    await until(app, 'R-1');
    await press(app, KEY.enter);
    await until(app, 'boundary is not checked');
    await press(app, KEY.down, KEY.enter);
    await until(app, 'The linked evidence could not be read');
    expect(app.lastFrame()).toContain('FINDING_NOT_FOUND');
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

  it('groups the settings by section and shows each with its description, default and a changed mark', async () => {
    const app = await open(fakeApi(), 5);
    await until(app, 'Mutation testing');
    const frame = app.lastFrame() ?? '';
    for (const title of ['General', 'Project', 'Sources', 'Analysis', 'Property-based testing', 'LLM'])
      expect(frame).toContain(title);
    expect(frame).toMatch(/Mutation testing\s+3 settings\s+1 changed/);
    await press(app, KEY.down, KEY.down, KEY.down, KEY.down);
    await until(app, 'Mutation testing with mutator.');
    await press(app, KEY.enter, KEY.down, KEY.down, KEY.down);
    await until(app, 'Time allowed for mutation testing, in');
    const field = app.lastFrame() ?? '';
    expect(field).toMatch(/Timeout \(ms\)\s+1000\s+changed/);
    expect(field).toMatch(/now 1000\s+default 120000/);
    expect(field).toContain('allowed: whole number, > 0');
    // A value the file does not set shows its default, without a changed mark.
    await press(app, KEY.up);
    await until(app, 'diff mutates only the code changed');
    expect(
      app
        .lastFrame()
        ?.split('\n')
        .find((l) => l.includes('Mode ')),
    ).not.toContain('changed');
    expect(app.lastFrame()).toMatch(/now diff \(default\)/);
  });

  it('refuses a value that is not a number or out of range at the field, and writes nothing', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    await press(app, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.down, KEY.down);
    await until(app, 'Timeout (ms)');
    const type = async (...keys: string[]) => {
      await press(app, KEY.enter);
      await until(app, 'New value:');
      await press(
        app,
        KEY.backspace,
        KEY.backspace,
        KEY.backspace,
        KEY.backspace,
        KEY.backspace,
        ...keys,
        KEY.enter,
      );
    };
    await type('x');
    await until(app, 'Enter a whole number');
    await press(app, KEY.escape);
    await type('-', '5');
    await until(app, 'mutation.timeoutMs: Too small');
    // The editor stays open with the error until the value is fixed or the edit cancelled.
    expect(app.lastFrame()).toContain('New value:');
    await press(app, KEY.escape, 's');
    await until(app, 'No unsaved changes.');
    expect(api.writeConfig).not.toHaveBeenCalled();
  });

  it('shows the changes before saving and saves only after y', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    await press(
      app,
      KEY.down,
      KEY.down,
      KEY.down,
      KEY.down,
      KEY.enter,
      KEY.down,
      KEY.down,
      KEY.down,
      KEY.enter,
    );
    await until(app, 'New value:');
    await press(
      app,
      KEY.backspace,
      KEY.backspace,
      KEY.backspace,
      KEY.backspace,
      '5',
      '0',
      '0',
      '0',
      KEY.enter,
    );
    await until(app, '1 unsaved');
    expect(app.lastFrame()).toMatch(/\* Timeout \(ms\)\s+5000/);
    expect(api.writeConfig).not.toHaveBeenCalled();
    await press(app, 's');
    await until(app, 'Review 1 change to .veritas/config.json');
    expect(app.lastFrame()).toContain('- 1000');
    expect(app.lastFrame()).toContain('+ 5000');
    await press(app, 'n');
    await until(app, '1 unsaved');
    expect(api.writeConfig).not.toHaveBeenCalled();
    await press(app, 's');
    await until(app, 'Save this change?');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({ mutation: { timeoutMs: 5000 } });
    await until(app, 'Saved 1 change to .veritas/config.json.');
  });

  it('toggles a switch, picks from the allowed values and resets to the default', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    // Sources > Local: Enter and Space toggle it.
    await press(app, KEY.down, KEY.down, KEY.enter, KEY.down);
    await until(app, 'Read specifications from documents');
    await press(app, ' ');
    await until(app, '1 unsaved');
    expect(app.lastFrame()).toMatch(/\* Local\s+off\s+changed/);
    await press(app, KEY.enter);
    await tick();
    expect(app.lastFrame()).not.toContain('unsaved');
    // Network sources are marked and explained.
    await press(app, KEY.down);
    await until(app, 'Network: Reads issues and pull requests from GitHub');
    expect(app.lastFrame()).toMatch(/GitHub: enabled\s+off\s+network/);
    // Mutation > Mode: a picker with every allowed value.
    await press(app, KEY.left, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.down, KEY.enter);
    await until(app, 'Choose a value:');
    expect(app.lastFrame()).toMatch(/diff \(now\) \(default\)/);
    expect(app.lastFrame()).toContain('full');
    await press(app, KEY.down, KEY.enter);
    await until(app, '1 unsaved');
    expect(app.lastFrame()).toMatch(/\* Mode\s+full\s+changed/);
    // r resets Timeout to its default by removing it from the file.
    await press(app, KEY.down, 'r');
    await until(app, '2 unsaved');
    expect(app.lastFrame()).toMatch(/now 120000 \(default\)/);
    await press(app, 's');
    await until(app, 'Review 2 changes');
    expect(app.lastFrame()).toContain('+ (unset, default 120000)');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({ mutation: { mode: 'full' } });
  });

  it('edits a list entry by entry and refuses an invalid entry', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    // Sources > Web: allow domains.
    await press(app, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
    await until(app, 'Domains web pages may be fetched from');
    await press(app, KEY.enter);
    await until(app, 'press a to add an entry');
    await press(app, 'a', 'b', 'a', 'd', ' ', 'x', KEY.enter);
    await until(app, 'expected a bare domain name');
    await press(app, KEY.escape, 'a', ...'docs.example.com', KEY.enter);
    await until(app, '1 unsaved');
    await press(app, 'a', ...'shop.example.com', KEY.enter);
    await until(app, 'docs.example.com, shop.example.com');
    await press(app, KEY.up, 'd');
    await until(app, '› shop.example.com');
    await press(app, KEY.escape, 's');
    await until(app, 'Review 1 change');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({
      mutation: { timeoutMs: 1000 },
      sources: { web: { allowDomains: ['shop.example.com'] } },
    });
  });

  it('marks the LLM provider and asks before leaving with unsaved changes', async () => {
    const api = fakeApi();
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    await press(app, ...Array(7).fill(KEY.down), KEY.enter, KEY.down);
    await until(app, 'LLM: Sends specification text to this provider');
    await press(app, KEY.enter);
    await until(app, 'Choose a value:');
    expect(app.lastFrame()).toContain('claude uses LLM');
    await press(app, KEY.down, KEY.enter);
    await until(app, '1 unsaved');
    await press(app, KEY.escape);
    await until(app, 'Discard 1 unsaved change and leave?');
    await press(app, 'n');
    await until(app, '1 unsaved');
    await press(app, KEY.escape, 'y');
    await until(app, 'jump');
    expect(api.writeConfig).not.toHaveBeenCalled();
  });

  it('does not edit a code configuration', async () => {
    const api = fakeApi({ readConfig: () => ({ kind: 'code', file: '/p/veritas.config.ts' }) });
    const app = await open(api, 5);
    await until(app, 'is a code configuration');
    expect(app.lastFrame()).toContain('read-only');
    // Only the way back is offered.
    expect(app.lastFrame()).toContain('Esc  back');
    expect(app.lastFrame()).not.toContain('review & save');
    await press(app, KEY.enter, ' ', 's', 'y');
    expect(api.writeConfig).not.toHaveBeenCalled();
    await press(app, KEY.escape);
    await until(app, 'jump');
  });

  it('explains a configuration it cannot read and still lets you leave', async () => {
    const api = fakeApi({
      readConfig: () => {
        throw new VeritasError('user', 'CONFIG_PARSE', 'cannot parse .veritas/config.json: Unexpected token');
      },
    });
    const app = await open(api, 5);
    await until(app, 'CONFIG_PARSE: cannot parse .veritas/config.json');
    expect(app.lastFrame()).toContain('cannot read');
    expect(app.lastFrame()).toContain('Esc  back');
    await press(app, KEY.escape);
    await until(app, 'jump');
    expect(api.writeConfig).not.toHaveBeenCalled();
  });

  it('shows every change before saving when they do not all fit, and saves only after the last is seen', async () => {
    const api = fakeApi({
      readConfig: () => ({ kind: 'json', file: '/projects/shop/.veritas/config.json', raw: {} }),
    });
    const app = await open(api, 5);
    await until(app, 'Mutation testing');
    const down = (n: number) => Array(n).fill(KEY.down);
    // Sources: local, GitHub, web and full text to the LLM.
    await press(app, ...down(2), KEY.enter, KEY.down, ' ', KEY.down, ' ', ...down(2), ' ', ...down(7), ' ');
    await until(app, '4 unsaved');
    // Sandbox and cache.
    await press(app, ...down(9), KEY.enter, KEY.down, ' ', ...down(2), KEY.enter, KEY.down, ' ');
    await until(app, '6 unsaved');
    await press(app, 's');
    await until(app, 'Review 6 changes to .veritas/config.json');
    expect(app.lastFrame()).toContain('+2 more (↓)');
    expect(app.lastFrame()).toContain('turns on network');
    await press(app, 'y');
    await until(app, 'Scroll to the last change');
    expect(api.writeConfig).not.toHaveBeenCalled();
    await press(app, KEY.down, KEY.down);
    await until(app, 'cache.enabled');
    expect(app.lastFrame()).not.toContain('more (↓)');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({
      sources: { local: false, github: { enabled: true }, web: { enabled: true }, sendFullTextToLlm: true },
      sandbox: { allowNetworkWithoutIsolation: true },
      cache: { enabled: false },
    });
  });

  it('fixes a file with problems one setting at a time and saves only once it is valid', async () => {
    const api = fakeApi({
      readConfig: () => ({
        kind: 'json',
        file: '/projects/shop/.veritas/config.json',
        raw: { mutation: { timeoutMs: -1 }, pbt: { numRuns: 0 } },
      }),
    });
    const app = await open(api, 5);
    await until(app, '2 problems to fix before saving');
    await press(app, ...Array(4).fill(KEY.down), KEY.enter, ...Array(3).fill(KEY.down), KEY.enter);
    await until(app, 'New value:');
    await press(app, KEY.backspace, KEY.backspace, '5', '0', '0', '0', KEY.enter);
    await until(app, '1 problem to fix before saving: pbt.numRuns');
    await press(app, 's');
    await until(app, 'Fix 1 problem before saving');
    expect(api.writeConfig).not.toHaveBeenCalled();
    // A change that adds a problem is still refused.
    await press(app, KEY.enter);
    await until(app, 'New value:');
    await press(app, ...Array(4).fill(KEY.backspace), '0', KEY.enter);
    await until(app, 'mutation.timeoutMs: Too small');
    await press(app, KEY.escape, KEY.down, KEY.enter, KEY.down, KEY.enter);
    await until(app, 'New value:');
    await press(app, KEY.backspace, '9', KEY.enter);
    await until(app, '2 unsaved');
    expect(app.lastFrame()).not.toContain('problem');
    await press(app, 's');
    await until(app, 'Review 2 changes');
    await press(app, 'y');
    expect(api.writeConfig).toHaveBeenCalledWith({ mutation: { timeoutMs: 5000 }, pbt: { numRuns: 9 } });
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

  it('edits nested configuration values', () => {
    const raw = { a: { b: 1, c: [1, 2] }, d: 'x' };
    expect(getAt(raw, ['a', 'c'])).toEqual([1, 2]);
    expect(getAt(raw, ['a', 'x', 'y'])).toBeUndefined();
    expect(setAt(raw, ['a', 'b'], 2)).toEqual({ a: { b: 2, c: [1, 2] }, d: 'x' });
    expect(raw.a.b).toBe(1);
    // Removing the last value of an object removes the object too.
    expect(unsetAt({ a: { b: 1 }, d: 'x' }, ['a', 'b'])).toEqual({ d: 'x' });
    expect(unsetAt(raw, ['a', 'b'])).toEqual({ a: { c: [1, 2] }, d: 'x' });
    expect(validate({ mutation: { timeoutMs: -5 } })[0]).toMatch(/^mutation\.timeoutMs:/);
    expect(validate({})).toEqual([]);
  });

  it('reads settings, labels and typed values from the schema', () => {
    const field = (k: string) =>
      SECTIONS.flatMap((s) => s.fields).find((f) => f.path.join('.') === k) ?? expect.fail(k);
    expect(humanize('maxDurationMs')).toBe('Max duration (ms)');
    expect(humanize('sendFullTextToLlm')).toBe('Send full text to LLM');
    expect(fieldLabel(field('sources.web.maxPages'))).toBe('Web: max pages');
    expect(fieldLabel(field('limits.memoryMb'))).toBe('Memory (MiB)');
    expect(parseText('5000', field('mutation.timeoutMs'))).toEqual({ value: 5000 });
    expect(parseText('1.5', field('mutation.timeoutMs'))).toHaveProperty('error');
    expect(parseText('0.5', field('policy.minPropertyCoverage'))).toEqual({ value: 0.5 });
    expect(parseText('', field('project.tsconfig'))).toEqual({ value: null });
    expect(parseText('', field('pbt.seed'))).toEqual({ value: expect.any(Symbol) });
    // A required field brings its required siblings, so the object stays valid.
    const min = field('formal.integerDomain.min');
    expect(setField({}, min, '-5')).toEqual({ formal: { integerDomain: { min: '-5', max: '10000' } } });
    expect(resetField({ formal: { integerDomain: { min: '-5', max: '7' } } }, min)).toEqual({
      formal: { integerDomain: { min: '-10000', max: '7' } },
    });
    expect(resetField({ mutation: { timeoutMs: 5 } }, field('mutation.timeoutMs'))).toEqual({});
    expect(diff({ mutation: { timeoutMs: 5 } }, { mutation: { mode: 'full' } }).map((c) => c.path)).toEqual([
      'mutation.mode',
      'mutation.timeoutMs',
    ]);
  });

  it('sorts findings by severity, then certainty', () => {
    const f = (severity: string, certainty: string) => ({ ...FINDING, severity, certainty }) as Finding;
    expect(
      sortFindings([f('low', 'confirmed'), f('high', 'suspected'), f('high', 'confirmed')]).map(
        (x) => `${x.severity}/${x.certainty}`,
      ),
    ).toEqual(['high/confirmed', 'high/suspected', 'low/confirmed']);
  });

  it('colors evidence statuses by what they mean', () => {
    expect(statusColor('counterexample')).toBe('red');
    expect(statusColor('passed')).toBe('green');
    expect(statusColor('timeout')).toBe('yellow');
    expect(statusColor('weak_or_incomplete')).toBe('yellow');
    expect(statusColor('something new')).toBe('yellow');
  });

  it('removes defaults the user did not write', () => {
    const field = (k: string) =>
      SECTIONS.flatMap((s) => s.fields).find((f) => f.path.join('.') === k) ?? expect.fail(k);
    const min = field('formal.integerDomain.min');
    // A required field edited and reset leaves no integerDomain behind when the file had none.
    expect(tidy({}, resetField(setField({}, min, '-5'), min), min)).toEqual({});
    expect(tidy({}, setField({}, min, '-5'), min)).toEqual({
      formal: { integerDomain: { min: '-5', max: '10000' } },
    });
    // A file that had the object keeps it.
    const saved = { formal: { integerDomain: { min: '-5', max: '10000' } } };
    expect(tidy(saved, resetField(saved, min), min)).toEqual({
      formal: { integerDomain: { min: '-10000', max: '10000' } },
    });
    const timeout = field('mutation.timeoutMs');
    expect(tidy({}, setField({}, timeout, 120_000), timeout)).toEqual({});
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
