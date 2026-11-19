import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ContentCache,
  canonicalJson,
  ExitCode,
  evaluatePolicy,
  type Finding,
  type FormalClaim,
  hashValue,
  newRunId,
  PropertyIR,
  PUBLIC_SCHEMAS,
  parseConfig,
  RunStore,
  readEnvelope,
  redact,
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

describe('config', () => {
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
    const cache = new ContentCache(root);
    const key = cache.key({ k: 1 });
    cache.set('logs', key, { line: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    expect(JSON.stringify(cache.get('logs', key))).not.toContain('ghp_');
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
    const cache = new ContentCache(tmp());
    const key = cache.key({ source: 'a' });
    expect(cache.get('ast', key)).toBeUndefined();
    cache.set('ast', key, { ok: true });
    expect(cache.get('ast', key)).toEqual({ ok: true });
    expect(cache.key({ source: 'b' })).not.toBe(key);
    expect(() => cache.set('../x', key, 1)).toThrow();
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
