import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ARTIFACT_INDEX_FILE,
  ArtifactIndex,
  ContentCache,
  canonicalJson,
  ExitCode,
  evaluatePolicy,
  type Finding,
  type FormalClaim,
  hashValue,
  initProject,
  leanToolCandidates,
  loadConfig,
  newRunId,
  openCache,
  PropertyIR,
  PUBLIC_SCHEMAS,
  parseConfig,
  pruneRuns,
  RunStore,
  readEnvelope,
  redact,
  redactArgs,
  resolveInsideRoot,
  runStages,
  SCHEMA_VERSION,
  type Stage,
  type StageResult,
  stableId,
  VeritasConfig,
  VeritasError,
} from '../src/index.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'veritas-core-'));
const SECRET = Buffer.alloc(32, 7);
/** openCache with a key file in a fresh directory, never the developer's own cache key. */
const keyEnv = () => ({ VERITAS_CACHE_KEY_FILE: path.join(tmp(), 'cache-key') });

describe('config', () => {
  it('bounds the modelled array length', () => {
    expect(parseConfig({}, null).formal.maxArrayLength).toBe(3);
    expect(parseConfig({ formal: { maxArrayLength: 8 } }, null).formal.maxArrayLength).toBe(8);

    for (const maxArrayLength of [0, 9, 2.5])
      expect(() => parseConfig({ formal: { maxArrayLength } }, null), String(maxArrayLength)).toThrow(
        /maxArrayLength/,
      );
  });

  it('rejects a configuration written for another schema version', () => {
    expect(() => parseConfig({ schemaVersion: '999.0.0' }, null)).toThrow(/schema version/);
    expect(parseConfig({ schemaVersion: '1.0.0' }, null).schemaVersion).toBe('1.0.0');
  });

  it('neither writes nor reads the configuration through a .veritas symlink that leaves the project', async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'p', devDependencies: { vitest: '5.1.1' } }),
    );
    symlinkSync(outside, path.join(root, '.veritas'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => initProject(root, { force: true })).toThrow(/escapes the project root/);
    expect(existsSync(path.join(outside, 'config.json'))).toBe(false);
    writeFileSync(path.join(outside, 'config.json'), 'secret-token-value');
    await expect(loadConfig(root)).rejects.toThrow(/escapes the project root/);
  });

  it('fills safe defaults: network sources off, no auto-apply, z3 bounded domain', () => {
    const config = parseConfig({}, null);
    expect(config.sources.web.enabled).toBe(false);
    expect(config.sources.github.enabled).toBe(false);
    expect(config.improvement.autoApply).toBe(false);
    expect(config.improvement.testFilesOnly).toBe(true);
    expect(config.formal.integerDomain).toEqual({ min: '-10000', max: '10000' });
  });

  it('round-trips through JSON unchanged', () => {
    const config = parseConfig({ analysis: { include: ['lib/**/*.ts'] } }, null);
    expect(parseConfig(JSON.parse(JSON.stringify(config)), null)).toEqual(config);
  });

  it('reports every invalid field with its path as a user error', () => {
    try {
      parseConfig({ improvement: { autoApply: true }, unknownKey: 1 }, 'x.json');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VeritasError);
      const e = error as VeritasError;
      expect(e.exitCode).toBe(ExitCode.UserError);
      expect(e.message).toContain('improvement.autoApply');
      expect(e.message).toContain('unknownKey');
    }
  });

  it('rejects settings Veritas cannot enforce instead of ignoring them', () => {
    expect(() => parseConfig({ mutation: { maxMutants: 5 } }, 'x.json')).toThrow(/maxMutants/);
  });

  it('accepts only the enforced value for settings that are invariants', () => {
    for (const [input, key] of [
      [{ analysis: { requireApprovalForNormativeClaims: false } }, 'requireApprovalForNormativeClaims'],
      [{ improvement: { testFilesOnly: false } }, 'testFilesOnly'],
      [{ storage: { storePrompts: true } }, 'storePrompts'],
    ] as const)
      expect(() => parseConfig(input, 'x.json'), key).toThrow(new RegExp(key));
    const defaults = parseConfig({}, null);
    expect(defaults.analysis.requireApprovalForNormativeClaims).toBe(true);
    expect(defaults.storage.storePrompts).toBe(false);
  });
});

describe('paths', () => {
  it('rejects traversal and symlink escapes, accepts paths inside the root', () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(path.join(root, 'src'));
    symlinkSync(outside, path.join(root, 'link'));
    expect(resolveInsideRoot(root, 'src/a.ts')).toMatch(/src[/\\]a\.ts$/);
    expect(() => resolveInsideRoot(root, '../escape')).toThrow(/escapes the project root/);
    expect(() => resolveInsideRoot(root, path.join(outside, 'x'))).toThrow(/escapes/);
    expect(() => resolveInsideRoot(root, 'link/new-file.ts')).toThrow(/escapes/);
    expect(() => resolveInsideRoot(root, 'a\0b')).toThrow(/NUL/);
  });

  it('accepts absolute paths under a root that is itself reached through a symlink', () => {
    const real = tmp();
    mkdirSync(path.join(real, 'src'));
    const link = path.join(tmp(), 'proj');
    symlinkSync(real, link);
    expect(resolveInsideRoot(link, path.join(link, 'src/a.ts'))).toBe(path.join(link, 'src/a.ts'));
    expect(resolveInsideRoot(link, path.join(real, 'src/a.ts'))).toBe(path.join(real, 'src/a.ts'));
    expect(() => resolveInsideRoot(link, path.join(link, '..', 'x'))).toThrow(/escapes/);
  });
});

describe('redaction', () => {
  it('removes token formats and secret-looking env values', () => {
    const text = 'key sk-ant-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz and plain text';
    const out = redact(text, { MY_API_KEY: 'supersecretvalue' });
    expect(out).not.toContain('sk-ant-abcdefghijklmnop');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('plain text');
    expect(redact('value supersecretvalue', { MY_API_KEY: 'supersecretvalue' })).toBe('value [REDACTED]');
  });

  it('removes URL credentials, HTTP auth values and the values of secret command-line flags', () => {
    expect(redact('fetch https://alice:s3cr3tpass@example.com/x', {})).toBe(
      'fetch https://[REDACTED]@example.com/x',
    );
    expect(redact('Authorization: Bearer abcdefgh12345678', {})).not.toContain('abcdefgh12345678');
    // In an Authorization header every value is a credential, whatever its shape.
    expect(redact('curl -H "Bearer abcdefghijklmnop"', {})).toBe('curl -H "Bearer [REDACTED]"');
    for (const short of ['auth=shortsecret', 'token=abc', 'https://h/x?token=short&page=2'])
      expect(redact(short, {})).not.toMatch(/shortsecret|=abc|=short/);
    expect(redact('https://h/x?token=short&page=2', {})).toBe('https://h/x?[REDACTED]&page=2');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz', {})).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redact('authorization="Basic dXNlcjpwYXNz"', {})).toBe('authorization="Basic [REDACTED]"');
    // Prose is left alone.
    for (const prose of ['Basic authentication is required', 'Token budget exhausted', 'auth: required'])
      expect(redact(prose, {})).toBe(prose);
    expect(
      redactArgs(['--token', 'arbitrary-value-1', '--root', '/p', '--authorization=xyz123456789abc'], {}),
    ).toEqual(['--token', '[REDACTED]', '--root', '/p', '--[REDACTED]']);
  });
});

describe('ids and hashing', () => {
  it('orders run ids by creation time, also within one millisecond', () => {
    const now = new Date('2026-11-19T09:11:47.123Z');
    const ids = [newRunId(now), newRunId(now), newRunId(new Date('2026-11-19T09:11:47.124Z'))];
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^run-20261119T091147123Z-000-[0-9a-f]{6}$/);
  });

  it('is stable regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableId('P', { a: 1, b: 2 })).toBe(stableId('P', { b: 2, a: 1 }));
    expect(stableId('P', { a: 1 })).not.toBe(stableId('P', { a: 2 }));
  });
});

describe('run store', () => {
  const ctx = { configHash: hashValue({}), sourceHash: hashValue([]), gitCommit: null };

  it('keeps the newest runs and removes older ones, never the current one or anything else', () => {
    const root = tmp();
    const runs = path.join(root, '.veritas/runs');
    const ids = [
      'run-20261101T000000000Z-000-aaaaaa',
      'run-20261102T000000000Z-000-bbbbbb',
      'run-20261103T000000000Z-000-cccccc',
    ];
    for (const id of ids) mkdirSync(path.join(runs, id, 'proofs'), { recursive: true });
    mkdirSync(path.join(runs, 'notes'), { recursive: true });
    writeFileSync(path.join(runs, 'run-keep.txt'), 'not a run directory');
    const outside = tmp();
    symlinkSync(
      outside,
      path.join(runs, 'run-20261031T000000000Z-000-dddddd'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // The current run is kept even when it is not among the newest by name.
    expect(pruneRuns(root, 2, ids[0] as string)).toEqual([ids[1]]);
    expect(existsSync(path.join(runs, ids[0] as string))).toBe(true);
    expect(existsSync(path.join(runs, ids[1] as string))).toBe(false);
    expect(existsSync(path.join(runs, ids[2] as string))).toBe(true);
    expect(existsSync(path.join(runs, 'notes'))).toBe(true);
    expect(existsSync(path.join(runs, 'run-keep.txt'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('writes validated, enveloped artifacts with full metadata and reads them back', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    const schema = z.object({ n: z.number() });
    store.write('sample.json', schema, { n: 1 });
    const env = store.read('sample.json', schema);
    expect(env.data).toEqual({ n: 1 });
    expect(Object.keys(env.meta).sort()).toEqual(
      ['configHash', 'createdAt', 'gitCommit', 'runId', 'schemaVersion', 'sourceHash', 'toolVersion'].sort(),
    );
  });

  it('refuses invalid artifacts, foreign schema versions and paths outside the run', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    expect(() => store.write('bad.json', z.object({ n: z.number() }), { n: 'x' } as never)).toThrow(/schema/);
    const file = store.pathFor('old.json');
    writeFileSync(file, JSON.stringify({ meta: { schemaVersion: '0.1.0' }, data: {} }));
    expect(() => readEnvelope(file, z.object({}))).toThrow(/schema version/);
    expect(() => store.pathFor('../../../escape.json')).toThrow(/escapes/);
  });

  it('redacts secrets before writing', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    store.write('s.json', z.object({ t: z.string() }), { t: 'token sk-ant-abcdefghijklmnopqrst' });
    expect(readFileSync(store.pathFor('s.json'), 'utf8')).not.toContain('sk-ant-');
  });

  it('redacts raw text artifacts and cache entries', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    store.writeText('solver.log', 'out sk-ant-abcdefghijklmnopqrst');
    expect(readFileSync(store.pathFor('solver.log'), 'utf8')).not.toContain('sk-ant-');
    const cache = new ContentCache(root, SECRET);
    const key = cache.key({ k: 1 });
    cache.set('logs', key, { line: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    expect(JSON.stringify(cache.get('logs', key, z.object({ line: z.string() })))).not.toContain('ghp_');
  });

  it('gives raw text and external-tool files the run metadata and a hash through the artifact index', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    store.writeText('proofs/c.smt2', '(check-sat)\n');
    mkdirSync(store.pathFor('mutation/sub'), { recursive: true });
    writeFileSync(store.pathFor('mutation/sub/report.json'), '{"x":1}');
    expect(store.recordExternal('mutation')).toEqual(['mutation/sub/report.json']);
    const index = store.read(ARTIFACT_INDEX_FILE, ArtifactIndex);
    expect(index.meta.runId).toBe('run-test');
    expect(index.data.map((e) => [e.path, e.kind, e.sha256])).toEqual([
      ['mutation/sub/report.json', 'external', createHash('sha256').update('{"x":1}').digest('hex')],
      ['proofs/c.smt2', 'text', createHash('sha256').update('(check-sat)\n').digest('hex')],
    ]);
  });

  it('rejects artifacts with incomplete metadata', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    const file = store.pathFor('forged.json');
    writeFileSync(file, JSON.stringify({ meta: { schemaVersion: SCHEMA_VERSION }, data: {} }));
    expect(() => readEnvelope(file, z.object({}))).toThrow(/metadata/);
  });

  it('applies registered migrations to older artifacts', () => {
    const root = tmp();
    const store = new RunStore(root, 'run-test', ctx);
    const file = store.pathFor('old.json');
    const meta = { ...store.meta(), schemaVersion: '0.9.0' };
    writeFileSync(file, JSON.stringify({ meta, data: { count: '3' } }));
    const migration = {
      from: '0.9.0',
      to: SCHEMA_VERSION,
      migrate: (e: { meta: Record<string, unknown>; data: unknown }) => ({
        meta: e.meta,
        data: { n: Number((e.data as { count: string }).count) },
      }),
    };
    expect(readEnvelope(file, z.object({ n: z.number() }), [migration]).data).toEqual({ n: 3 });
    expect(() => readEnvelope(file, z.object({ n: z.number() }), [])).toThrow(/no migration/);
  });

  it('caches by content key', () => {
    const cache = new ContentCache(tmp(), SECRET);
    const schema = z.object({ ok: z.boolean() });
    const key = cache.key({ source: 'a' });
    expect(cache.get('ast', key, schema)).toBeUndefined();
    cache.set('ast', key, { ok: true });
    expect(cache.get('ast', key, schema)).toEqual({ ok: true });
    expect(cache.key({ source: 'b' })).not.toBe(key);
    expect(() => cache.set('../x', key, 1)).toThrow();
  });

  it('ignores entries it did not write: forged, tampered or written with another key', () => {
    const root = tmp();
    const env = keyEnv();
    const cache = openCache(root, { cache: { enabled: true } }, env).cache as ContentCache;
    const schema = z.object({ verdict: z.string() });
    const key = cache.key({ smt: '(check-sat)' });
    const file = path.join(root, '.veritas/cache/solver', key.slice(0, 2), `${key}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ verdict: 'unsat' }));
    expect(cache.get('solver', key, schema)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ mac: '0'.repeat(64), value: { verdict: 'unsat' } }));
    expect(cache.get('solver', key, schema)).toBeUndefined();
    cache.set('solver', key, { verdict: 'sat' });
    expect(cache.get('solver', key, schema)).toEqual({ verdict: 'sat' });
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...entry, value: { verdict: 'unsat' } }));
    expect(cache.get('solver', key, schema)).toBeUndefined();
    cache.set('solver', key, { verdict: 'sat' });
    expect(new ContentCache(root, Buffer.alloc(32, 9)).get('solver', key, schema)).toBeUndefined();
    // The key is created once, outside the project, and reused.
    expect(readFileSync(env.VERITAS_CACHE_KEY_FILE)).toHaveLength(32);
    expect(openCache(root, { cache: { enabled: true } }, env).cache?.get('solver', key, schema)).toEqual({
      verdict: 'sat',
    });
  });

  it('tightens a cache key that others can read to 0600 (POSIX modes)', () => {
    const env = keyEnv();
    writeFileSync(env.VERITAS_CACHE_KEY_FILE, Buffer.alloc(32, 3), { mode: 0o644 });
    chmodSync(env.VERITAS_CACHE_KEY_FILE, 0o644);
    expect(openCache(tmp(), { cache: { enabled: true } }, env).cache).toBeInstanceOf(ContentCache);

    if (process.platform !== 'win32') expect(statSync(env.VERITAS_CACHE_KEY_FILE).mode & 0o777).toBe(0o600);
  });

  it('treats an entry that does not match its schema as a miss', () => {
    const cache = new ContentCache(tmp(), SECRET);
    const key = cache.key({ source: 'a' });
    cache.set('ast', key, { ok: 'forged' });
    expect(cache.get('ast', key, z.object({ ok: z.boolean() }))).toBeUndefined();
  });

  it('opens the cache unless it is disabled or tracked by git', () => {
    const root = tmp();
    const env = keyEnv();
    expect(openCache(root, { cache: { enabled: true } }, env).cache).toBeInstanceOf(ContentCache);
    const disabled = openCache(root, { cache: { enabled: false } }, env);
    expect(disabled.cache).toBeNull();
    expect(disabled.message).toMatch(/disabled/);
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git(['init', '-q']);
    const cache = new ContentCache(root, SECRET);
    cache.set('solver', cache.key({ smt: 'x' }), { verdict: 'unsat' });
    expect(openCache(root, { cache: { enabled: true } }, env).cache).toBeInstanceOf(ContentCache);
    git(['add', '-f', '.veritas/cache']);
    const tracked = openCache(root, { cache: { enabled: true } }, env);
    expect(tracked.cache).toBeNull();
    expect(tracked.message).toMatch(/tracked by git/);
  });
});

describe('pipeline', () => {
  const baseCtx = () => {
    const root = tmp();

    return {
      root,
      config: VeritasConfig.parse({}),
      store: new RunStore(root, 'run-p', {
        configHash: hashValue({}),
        sourceHash: hashValue([]),
        gitCommit: null,
      }),
      signal: new AbortController().signal,
      log: () => {},
    };
  };

  it('turns a throwing stage into an error result and skips its dependents', async () => {
    const stages: Stage[] = [
      { name: 'index', dependsOn: [], run: async () => ({ status: 'succeeded', output: 1 }) },
      {
        name: 'discover',
        dependsOn: ['index'],
        run: async () => {
          throw new Error('boom');
        },
      },
      { name: 'spec', dependsOn: ['discover'], run: async () => ({ status: 'succeeded' }) },
    ];
    const results = await runStages(stages, baseCtx());
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'error', 'skipped']);
    expect(results[1]?.messages[0]).toContain('boom');
  });

  it('passes outputs of earlier stages to later ones', async () => {
    let seen: unknown;
    const stages: Stage[] = [
      { name: 'index', dependsOn: [], run: async () => ({ status: 'succeeded', output: 42 }) },
      {
        name: 'analyze',
        dependsOn: ['index'],
        run: async (c) => {
          seen = c.outputs.get('index');

          return { status: 'succeeded' };
        },
      },
    ];
    await runStages(stages, baseCtx());
    expect(seen).toBe(42);
  });
});

describe('policy', () => {
  const stage = (status: StageResult['status']): StageResult => ({
    stage: 'prove',
    status,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    artifacts: [],
    messages: [],
    usage: { llmTokens: 0, solverMs: 0, mutants: 0, testRuns: 0 },
  });
  const finding = (certainty: Finding['certainty']): Finding => ({
    id: 'F-1',
    kind: 'counterexample',
    title: 't',
    severity: 'high',
    certainty,
    locations: [],
    propertyIds: [],
    sourceIds: [],
    testIds: [],
    mutantIds: [],
    claimIds: [],
    explanation: ['x'],
    nextActions: [],
  });
  const policy = VeritasConfig.parse({}).policy;

  it('enforces maxNewSurvivors and minPropertyCoverage, and never passes them unmeasured', () => {
    const mutate = { ...stage('succeeded'), stage: 'mutate' as const };
    const survivors = [{ status: 'survived' }, { status: 'killed' }, { status: 'survived' }] as never[];
    const strict = { ...policy, maxNewSurvivors: 1 };
    expect(evaluatePolicy(strict, [], [mutate], [], { mutants: survivors })).toMatchObject({
      exitCode: ExitCode.PolicyFailure,
      reasons: [expect.stringMatching(/2 surviving mutant\(s\), more than policy.maxNewSurvivors 1/)],
    });
    expect(
      evaluatePolicy({ ...policy, maxNewSurvivors: 2 }, [], [mutate], [], { mutants: survivors }).verdict,
    ).toBe('pass');
    const unmeasured = evaluatePolicy(strict, [], [stage('succeeded')], [], {});
    expect(unmeasured.verdict).toBe('pass_with_warnings');
    expect(unmeasured.reasons.join(' ')).toMatch(/no mutation results/);
    expect(
      evaluatePolicy({ ...strict, inconclusiveBehavior: 'fail' }, [], [stage('succeeded')]).exitCode,
    ).toBe(ExitCode.Inconclusive);

    const properties = [
      { id: 'P-1', status: 'accepted' },
      { id: 'P-2', status: 'accepted' },
      { id: 'P-3', status: 'proposed' },
    ] as never[];
    const assessments = [
      { propertyIds: ['P-1'], outcome: 'meaningful_with_evidence' },
      { propertyIds: ['P-2', 'P-3'], outcome: 'weak_or_incomplete' },
    ] as never[];
    const coverage = (min: number) =>
      evaluatePolicy({ ...policy, minPropertyCoverage: min }, [], [stage('succeeded')], [], {
        properties,
        assessments,
      });
    expect(coverage(0.75)).toMatchObject({
      exitCode: ExitCode.PolicyFailure,
      reasons: [expect.stringMatching(/1 of 2 accepted properties have a meaningful test/)],
    });
    expect(coverage(0.5).verdict).toBe('pass');
    expect(
      evaluatePolicy({ ...policy, minPropertyCoverage: 0.5 }, [], [stage('succeeded')], [], {
        properties: [],
        assessments: [],
      }).verdict,
    ).toBe('pass_with_warnings');
  });

  it('fails only on confirmed violations', () => {
    expect(evaluatePolicy(policy, [finding('confirmed')], [stage('succeeded')]).exitCode).toBe(
      ExitCode.PolicyFailure,
    );
    expect(evaluatePolicy(policy, [finding('suspected')], [stage('succeeded')]).exitCode).toBe(
      ExitCode.Success,
    );
  });

  it.each(['partial', 'skipped', 'unsupported', 'timeout', 'cancelled'] as const)(
    'never reports a %s stage as a clean pass',
    (status) => {
      const warn = evaluatePolicy(policy, [], [stage(status)]);
      expect(warn.verdict).toBe('pass_with_warnings');
      expect(warn.reasons.join(' ')).toContain(status);
      const strict = evaluatePolicy({ ...policy, inconclusiveBehavior: 'fail' }, [], [stage(status)]);
      expect(strict.exitCode).toBe(ExitCode.Inconclusive);
    },
  );

  it.each(['error', 'failed'] as const)('treats a %s stage as a tool error', (status) => {
    expect(evaluatePolicy(policy, [], [stage(status)]).exitCode).toBe(ExitCode.ToolError);
  });

  it.each(['unknown', 'timeout', 'unsupported', 'semantic_mismatch', 'error'] as const)(
    'treats a %s formal claim as inconclusive, not proven',
    (status) => {
      const claim: FormalClaim = {
        id: 'C-1',
        propertyId: 'P-1',
        kind: 'conformance',
        status,
        engine: 'z3',
        engineVersion: '4',
        assurance: 'none',
        modelId: 'm',
        assumptions: [],
        scope: {},
        semanticGaps: [],
        semanticValidation: 'not_attempted',
        durationMs: 0,
      };
      const strict = evaluatePolicy(
        { ...policy, inconclusiveBehavior: 'fail' },
        [],
        [stage('succeeded')],
        [claim],
      );
      expect(strict.exitCode).toBe(ExitCode.Inconclusive);
      expect(evaluatePolicy(policy, [], [stage('succeeded')], [claim]).verdict).toBe('pass_with_warnings');
    },
  );

  it('passes cleanly only when everything succeeded', () => {
    expect(evaluatePolicy(policy, [], [stage('succeeded')])).toEqual({
      exitCode: 0,
      verdict: 'pass',
      reasons: [],
    });
  });
});

describe('schemas', () => {
  it('rejects an IR domain whose min exceeds max', () => {
    const ir = {
      irVersion: 1,
      preconditions: [],
      functions: [],
      body: { kind: 'bool', value: true },
      params: [{ name: 'x', sort: 'int', domain: { min: '5', max: '1' } }],
    };
    expect(PropertyIR.safeParse(ir).success).toBe(false);
  });

  it('exports every public schema as JSON Schema', () => {
    for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) {
      const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      expect(json, name).toHaveProperty('$schema');
    }
  });
});

describe('doctor', () => {
  it('looks for Lean on the PATH first, then in the elan install directories', () => {
    const exe = process.platform === 'win32' ? 'lean.exe' : 'lean';
    const home = path.join(tmpdir(), 'home');
    expect(leanToolCandidates('lean', { HOME: home })).toEqual([
      'lean',
      path.join(home, '.elan', 'bin', exe),
    ]);
    const elanHome = path.join(tmpdir(), 'elan');
    expect(leanToolCandidates('lean', { HOME: home, ELAN_HOME: elanHome })).toEqual([
      'lean',
      path.join(elanHome, 'bin', exe),
      path.join(home, '.elan', 'bin', exe),
    ]);
    expect(leanToolCandidates('lake', { HOME: home }).at(-1)).toMatch(
      /[\\/]\.elan[\\/]bin[\\/]lake(\.exe)?$/,
    );
  });
});
