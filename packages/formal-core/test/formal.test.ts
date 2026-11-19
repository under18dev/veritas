import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentCache, FormalClaim, hashValue, RunStore } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  applyMutation,
  detectionProperty,
  equivalenceProperty,
  proveProperty,
  restrictToInputs,
  type TranslationResult,
  thresholdProperty,
  translateFunction,
} from '../src/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOMAIN = { min: '-10000', max: '10000' };

function fixture(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
  cpSync(path.join(REPO, 'fixtures/discount-boundary'), dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.mutator'),
  });
  return dir;
}

function translated(result: TranslationResult) {
  if (result.status !== 'translated') throw new Error(`expected translation, got ${JSON.stringify(result)}`);
  return result;
}

function translateFile(root: string, file: string, exportName: string, modelName?: string) {
  return translateFunction({
    file,
    source: readFileSync(path.join(root, file), 'utf8'),
    exportName,
    domain: DOMAIN,
    modelName,
  });
}

const store = (root: string) =>
  new RunStore(root, 'run-formal', { configHash: hashValue({}), sourceHash: hashValue([]), gitCommit: null });

function inline(source: string, exportName = 'f') {
  return translateFunction({ file: 'src/x.ts', source, exportName, domain: DOMAIN });
}

describe('translation of the supported subset', () => {
  it('translates if/return into an ite model', () => {
    const root = fixture();
    const result = translated(translateFile(root, 'src/pricing.ts', 'discountAmount'));
    expect(result.model.symbol).toBe('src/pricing.ts#discountAmount');
    expect(result.model.body).toEqual({
      kind: 'ite',
      cond: {
        kind: 'binary',
        op: '>',
        left: { kind: 'var', name: 'total' },
        right: { kind: 'int', value: '1000' },
      },
      whenTrue: { kind: 'int', value: '100' },
      whenFalse: { kind: 'int', value: '0' },
    });
    expect(result.params).toEqual([{ name: 'total', sort: 'int', domain: DOMAIN }]);
  });

  it('handles const bindings, ternaries, helper calls and boolean logic', () => {
    const result = translated(
      inline(
        'function sq(a: number): number { return a * a; }\nexport function f(x: number, flag: boolean): boolean { const y = sq(x) - 1; return flag && (y >= 0 ? true : !flag); }',
      ),
    );
    expect(result.dependencies.map((d) => d.name)).toEqual(['f__sq']);
  });

  it.each([
    ['NaN', 'export function f(x: number): number { return NaN; }', 'NaN'],
    ['division', 'export function f(x: number): number { return x / 2; }', '/'],
    ['remainder', 'export function f(x: number): number { return x % 2; }', '%'],
    ['float literal', 'export function f(x: number): number { return x * 1.5; }', 'number'],
    ['loose equality', 'export function f(x: number): boolean { return x == 1; }', '=='],
    ['async', 'export async function f(x: number): Promise<number> { return x; }', 'async'],
    [
      'side effect',
      'export function f(x: number): number { console.log(x); return x; }',
      'ExpressionStatement',
    ],
    [
      'mutable variable',
      'export function f(x: number): number { let y = x; y = y + 1; return y; }',
      'let/var',
    ],
    ['loop', 'export function f(x: number): number { for (;;) { return x; } }', 'ForStatement'],
    ['external state', 'let c = 0;\nexport function f(x: number): number { return x + c; }', 'identifier'],
    ['Math call', 'export function f(x: number): number { return Math.abs(x); }', 'call'],
    ['untyped parameter', 'export function f(x): number { return x; }', 'type'],
    ['optional parameter', 'export function f(x?: number): number { return 1; }', 'parameter'],
    ['recursion', 'export function f(x: number): number { return x > 0 ? f(x - 1) : 0; }', 'recursion'],
  ])('reports %s as unsupported with a line number', (_name, source, construct) => {
    const result = inline(source);
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reasons[0]?.construct).toBe(construct);
      expect(result.reasons[0]?.line).toBeGreaterThan(0);
    }
  });

  it('reports a missing export as not_found', () => {
    expect(inline('export const g = 1;').status).toBe('not_found');
  });
});

describe('conformance proofs against the README rule (total >= 1000 => 100, otherwise 0)', () => {
  it('finds and replays the counterexample total = 1000 in JavaScript', async () => {
    const root = fixture();
    const impl = translated(translateFile(root, 'src/pricing.ts', 'discountAmount'));
    const ir = thresholdProperty({
      implementation: impl,
      param: 'total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      whenFalse: '0',
    });
    const runStore = store(root);
    const { claim, replay } = await proveProperty({
      kind: 'conformance',
      propertyId: 'P-discount',
      ir,
      root,
      bindings: [
        {
          modelName: 'discountAmount',
          modulePath: path.join(root, 'src/pricing.ts'),
          exportName: 'discountAmount',
        },
      ],
      timeoutMs: 10_000,
      store: runStore,
    });
    expect(FormalClaim.parse(claim)).toBeTruthy();
    expect(claim.status).toBe('counterexample_found');
    expect(claim.counterexample).toEqual({ total: '1000' });
    expect(claim.semanticValidation).toBe('confirmed');
    expect(replay[0]).toMatchObject({
      purpose: 'counterexample',
      model: '0',
      javascript: { t: 'number', v: '0' },
      agrees: true,
    });
    const smt = readFileSync(runStore.pathFor(claim.solverInputArtifact as string), 'utf8');
    expect(smt).toContain('(assert (<= (- 10000) |total| 10000))');
    expect(claim.assurance).toBe('none');
  }, 60_000);

  it('proves the candidate fix only within the model and states the domain', async () => {
    const root = fixture();
    const impl = translated(translateFile(root, 'candidates/pricing-fixed.ts', 'discountAmount'));
    const ir = thresholdProperty({
      implementation: impl,
      param: 'total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      whenFalse: '0',
    });
    const { claim } = await proveProperty({
      kind: 'conformance',
      propertyId: 'P-discount',
      ir,
      root,
      bindings: [
        {
          modelName: 'discountAmount',
          modulePath: path.join(root, 'candidates/pricing-fixed.ts'),
          exportName: 'discountAmount',
        },
      ],
      timeoutMs: 10_000,
      store: store(root),
    });
    expect(claim.status).toBe('proven_within_model');
    expect(claim.assurance).toBe('smt_bounded');
    expect(claim.semanticValidation).toBe('confirmed');
    expect(claim.counterexample).toBeUndefined();
    expect(JSON.stringify(claim.scope)).toContain('"min":"-10000"');
    expect(claim.semanticGaps.join(' ')).toMatch(/IEEE-754/);
  }, 60_000);
});

describe('semantic mismatch between the integer model and JavaScript numbers', () => {
  it('does not report proven when an intermediate value can leave the safe-integer range', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src/inc.ts'),
      'export function grows(x: number): boolean { return x + 1 > x; }\n',
    );
    const impl = translated(
      translateFunction({
        file: 'src/inc.ts',
        source: readFileSync(path.join(root, 'src/inc.ts'), 'utf8'),
        exportName: 'grows',
        domain: { min: '0', max: '9007199254740991' },
      }),
    );
    const ir = {
      irVersion: 1 as const,
      params: impl.params,
      preconditions: [],
      functions: [impl.model],
      body: {
        kind: 'binary' as const,
        op: '==' as const,
        left: { kind: 'call' as const, fn: 'grows', args: [{ kind: 'var' as const, name: 'x' }] },
        right: { kind: 'bool' as const, value: true },
      },
    };
    const { claim } = await proveProperty({
      kind: 'conformance',
      propertyId: 'P-grows',
      ir,
      root,
      bindings: [{ modelName: 'grows', modulePath: path.join(root, 'src/inc.ts'), exportName: 'grows' }],
      timeoutMs: 10_000,
    });
    expect(claim.status).toBe('semantic_mismatch');
    expect(claim.assurance).toBe('none');
    expect(claim.semanticGaps.join(' ')).toMatch(/safe-integer range/);
  }, 60_000);

  it.each([
    ['a counterexample', '0'],
    ['a proof', '7'],
  ])(
    'reports unknown instead of %s when the JavaScript cannot be run',
    async (_label, expected) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
      mkdirSync(path.join(root, 'src'));
      writeFileSync(
        path.join(root, 'src/broken.ts'),
        "throw new Error('cannot load');\nexport function f(x: number): number { return 7; }\n",
      );
      const model = translated(
        translateFunction({
          file: 'src/broken.ts',
          source: 'export function f(x: number): number { return 7; }\n',
          exportName: 'f',
          domain: DOMAIN,
        }),
      );
      const ir = {
        irVersion: 1 as const,
        params: model.params,
        preconditions: [],
        functions: [model.model],
        body: {
          kind: 'binary' as const,
          op: '==' as const,
          left: { kind: 'call' as const, fn: 'f', args: [{ kind: 'var' as const, name: 'x' }] },
          right: { kind: 'int' as const, value: expected },
        },
      };
      const { claim } = await proveProperty({
        kind: 'conformance',
        propertyId: 'P-broken',
        ir,
        root,
        bindings: [{ modelName: 'f', modulePath: path.join(root, 'src/broken.ts'), exportName: 'f' }],
        timeoutMs: 10_000,
      });
      expect(claim.status).toBe('unknown');
      expect(claim.assurance).toBe('none');
      expect(claim.counterexample).toBeUndefined();
      expect(claim.semanticGaps.join(' ')).toMatch(/could not be (replayed in|compared with) JavaScript/);
    },
    60_000,
  );

  it('reports semantic_mismatch, not a counterexample, when JavaScript disagrees with the model on replay', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
    mkdirSync(path.join(root, 'src'));
    // The real function always returns 0; the model (as if mistranslated) returns x.
    writeFileSync(path.join(root, 'src/zero.ts'), 'export function f(x: number): number { return 0; }\n');
    const model = translated(
      translateFunction({
        file: 'src/zero.ts',
        source: 'export function f(x: number): number { return x; }\n',
        exportName: 'f',
        domain: DOMAIN,
      }),
    );
    const ir = {
      irVersion: 1 as const,
      params: model.params,
      preconditions: [],
      functions: [model.model],
      body: {
        kind: 'binary' as const,
        op: '==' as const,
        left: { kind: 'call' as const, fn: 'f', args: [{ kind: 'var' as const, name: 'x' }] },
        right: { kind: 'int' as const, value: '0' },
      },
    };
    const { claim } = await proveProperty({
      kind: 'conformance',
      propertyId: 'P-zero',
      ir,
      root,
      bindings: [{ modelName: 'f', modulePath: path.join(root, 'src/zero.ts'), exportName: 'f' }],
      timeoutMs: 10_000,
    });
    expect(claim.status).toBe('semantic_mismatch');
    expect(claim.semanticValidation).toBe('mismatch');
    expect(claim.assurance).toBe('none');
  }, 60_000);
});

describe('mutants', () => {
  it('distinguishes the boundary mutant with input 1000', async () => {
    const root = fixture();
    const source = readFileSync(path.join(root, 'src/pricing.ts'), 'utf8');
    const mutated = applyMutation(source, {
      line: 3,
      column: 7,
      original: 'total > 1000',
      replacement: 'total >= 1000',
    });
    const orig = translated(translateFile(root, 'src/pricing.ts', 'discountAmount', 'original'));
    const mutant = translated(
      translateFunction({
        file: 'src/pricing.ts',
        source: mutated,
        exportName: 'discountAmount',
        domain: DOMAIN,
        modelName: 'mutant',
      }),
    );
    const { claim } = await proveProperty({
      kind: 'bounded_equivalence',
      propertyId: 'P-mutant',
      ir: equivalenceProperty(orig, mutant),
      root,
      bindings: [
        {
          modelName: 'original',
          modulePath: path.join(root, 'src/pricing.ts'),
          exportName: 'discountAmount',
        },
      ],
      timeoutMs: 10_000,
      mutantId: 'M-1',
    });
    expect(claim.status).toBe('counterexample_found');
    expect(claim.counterexample).toEqual({ total: '1000' });
  }, 60_000);

  it('proves a genuinely equivalent mutant equivalent only within the bounded domain', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
    mkdirSync(path.join(root, 'src'));
    const source = 'export function relu(x: number): number {\n  return x > 0 ? x : 0;\n}\n';
    writeFileSync(path.join(root, 'src/relu.ts'), source);
    const mutated = applyMutation(source, { line: 2, column: 10, original: 'x > 0', replacement: 'x >= 0' });
    const orig = translated(
      translateFunction({
        file: 'src/relu.ts',
        source,
        exportName: 'relu',
        domain: DOMAIN,
        modelName: 'original',
      }),
    );
    const mutant = translated(
      translateFunction({
        file: 'src/relu.ts',
        source: mutated,
        exportName: 'relu',
        domain: DOMAIN,
        modelName: 'mutant',
      }),
    );
    const { claim } = await proveProperty({
      kind: 'bounded_equivalence',
      propertyId: 'P-relu',
      ir: equivalenceProperty(orig, mutant),
      root,
      bindings: [{ modelName: 'original', modulePath: path.join(root, 'src/relu.ts'), exportName: 'relu' }],
      timeoutMs: 10_000,
      mutantId: 'M-2',
    });
    expect(claim.status).toBe('proven_within_model');
    expect(JSON.stringify(claim.scope)).toContain('"max":"10000"');
  }, 60_000);

  it('refuses to apply a mutation whose original text is not at the location', () => {
    expect(() =>
      applyMutation('a > b', { line: 1, column: 1, original: 'a < b', replacement: 'a <= b' }),
    ).toThrow(/not found/);
  });
});

describe('solver limits', () => {
  it('reports timeout or unknown instead of proven when the solver gives up', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
    const source =
      'export function f(a: number, b: number, c: number): boolean { return a * a * a * a + b * b * b * b !== c * c * c * c; }';
    const impl = translated(
      translateFunction({
        file: 'src/f.ts',
        source,
        exportName: 'f',
        domain: { min: '1', max: '100000000' },
      }),
    );
    const ir = {
      irVersion: 1 as const,
      params: impl.params,
      preconditions: [],
      functions: [impl.model],
      body: {
        kind: 'call' as const,
        fn: 'f',
        args: impl.params.map((p) => ({ kind: 'var' as const, name: p.name })),
      },
    };
    const { claim } = await proveProperty({
      kind: 'conformance',
      propertyId: 'P-hard',
      ir,
      root,
      bindings: [],
      timeoutMs: 200,
    });
    expect(['timeout', 'unknown']).toContain(claim.status);
    expect(claim.assurance).toBe('none');
  }, 60_000);
});

describe('solver result cache', () => {
  const discountIr = (root: string) =>
    thresholdProperty({
      implementation: translated(translateFile(root, 'src/pricing.ts', 'discountAmount')),
      param: 'total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      whenFalse: '0',
    });
  const proveDiscount = (root: string, cache: ContentCache, timeoutMs = 10_000) => {
    const runStore = store(root);
    return proveProperty({
      kind: 'conformance',
      propertyId: 'P-discount',
      ir: discountIr(root),
      root,
      bindings: [
        {
          modelName: 'discountAmount',
          modulePath: path.join(root, 'src/pricing.ts'),
          exportName: 'discountAmount',
        },
      ],
      timeoutMs,
      store: runStore,
      cache,
    }).then((result) => ({
      ...result,
      output: readFileSync(runStore.pathFor(result.claim.solverOutputArtifact as string), 'utf8'),
    }));
  };

  it('reuses a decisive result for the same query and still replays it in JavaScript', async () => {
    const root = fixture();
    const cache = new ContentCache(root, Buffer.alloc(32, 1));
    const first = await proveDiscount(root, cache);
    expect(first.output).not.toContain('reused from cache');
    const second = await proveDiscount(root, cache);
    expect(second.output).toMatch(/; result reused from cache [0-9a-f]{64}/);
    expect(second.claim.status).toBe('counterexample_found');
    expect(second.claim.counterexample).toEqual(first.claim.counterexample);
    expect(second.claim.durationMs).toBe(0);
    expect(second.replay[0]).toMatchObject({ purpose: 'counterexample', agrees: true });
    // Another time limit is another query.
    const other = await proveDiscount(root, cache, 9_000);
    expect(other.output).not.toContain('reused from cache');
  }, 60_000);

  it('misses when the implementation changes', async () => {
    const root = fixture();
    const cache = new ContentCache(root, Buffer.alloc(32, 1));
    await proveDiscount(root, cache);
    const file = path.join(root, 'src/pricing.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('total > 1000', 'total >= 1000'));
    const changed = await proveDiscount(root, cache);
    expect(changed.output).not.toContain('reused from cache');
    expect(changed.claim.status).toBe('proven_within_model');
  }, 60_000);

  it('never stores an undecided result', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-formal-')));
    cpSync(path.join(REPO, 'fixtures/solver-limits/src'), path.join(root, 'src'), { recursive: true });
    const source = readFileSync(path.join(root, 'src/cubes.ts'), 'utf8');
    const orig = translated(translateFile(root, 'src/cubes.ts', 'sumsTo33', 'original'));
    const never = translated(
      translateFunction({
        file: 'src/cubes.ts',
        source: source.replace(/return [^;]+;/, 'return 0;'),
        exportName: 'sumsTo33',
        domain: { min: '-100000000', max: '100000000' },
        modelName: 'mutant',
      }),
    );
    const cache = new ContentCache(root, Buffer.alloc(32, 1));
    const { claim } = await proveProperty({
      kind: 'bounded_equivalence',
      propertyId: 'P-cubes',
      ir: equivalenceProperty(orig, never, { min: '-100000000', max: '100000000' }),
      root,
      bindings: [],
      timeoutMs: 200,
      cache,
      mutantId: 'M-3',
    });
    expect(['timeout', 'unknown']).toContain(claim.status);
    expect(existsSync(path.join(root, '.veritas/cache/solver'))).toBe(false);
  }, 60_000);
});

describe('distinguishability and property detection', () => {
  const mutantOf = (root: string, replacement: string, modelName: string) => {
    const source = readFileSync(path.join(root, 'src/pricing.ts'), 'utf8');
    return translated(
      translateFunction({
        file: 'src/pricing.ts',
        source: applyMutation(source, { line: 3, column: 7, original: 'total > 1000', replacement }),
        exportName: 'discountAmount',
        domain: DOMAIN,
        modelName,
      }),
    );
  };
  const binding = (root: string, modelName: string) => ({
    modelName,
    modulePath: path.join(root, 'src/pricing.ts'),
    exportName: 'discountAmount',
  });

  it('checks only the inputs a test uses: 2000 and 10 cannot tell >= 1000 from > 1000, 1000 can', async () => {
    const root = fixture();
    const orig = translated(translateFile(root, 'src/pricing.ts', 'discountAmount', 'original'));
    const mutant = mutantOf(root, 'total >= 1000', 'mutant');
    const prove = (inputs: Record<string, string>[]) =>
      proveProperty({
        kind: 'distinguishability',
        propertyId: 'P-discount',
        ir: restrictToInputs(equivalenceProperty(orig, mutant, DOMAIN), inputs),
        root,
        bindings: [binding(root, 'original')],
        timeoutMs: 10_000,
        mutantId: 'M-1',
      });
    expect((await prove([{ total: '2000' }, { total: '10' }])).claim.status).toBe('proven_within_model');
    const found = (await prove([{ total: '10' }, { total: '1000' }])).claim;
    expect(found.status).toBe('counterexample_found');
    expect(found.counterexample).toEqual({ total: '1000' });
    expect(() => restrictToInputs(equivalenceProperty(orig, mutant, DOMAIN), [{ total: true }])).toThrow(
      /integer|int/,
    );
  }, 60_000);

  it('credits a property only with inputs where the original satisfies it and the mutant does not', async () => {
    const root = fixture();
    const impl = translated(translateFile(root, 'src/pricing.ts', 'discountAmount'));
    // A rule the original satisfies: totals above 1000 get 100.
    const ir = thresholdProperty({
      implementation: impl,
      param: 'total',
      operator: '>',
      value: '1000',
      whenTrue: '100',
    });
    const detect = (replacement: string) =>
      proveProperty({
        kind: 'property_detection',
        propertyId: 'P-above',
        ir: detectionProperty(ir, 'discountAmount', mutantOf(root, replacement, 'discountAmount__mutant')),
        root,
        bindings: [binding(root, 'discountAmount')],
        timeoutMs: 10_000,
        mutantId: 'M-x',
      });
    const detected = (await detect('total > 2000')).claim;
    expect(detected.status).toBe('counterexample_found');
    const t = BigInt(detected.counterexample?.total as string);
    expect(t > 1000n && t <= 2000n).toBe(true);
    // >= 1000 still gives 100 above 1000: the property cannot tell it apart.
    expect((await detect('total >= 1000')).claim.status).toBe('proven_within_model');
  }, 60_000);

  it('refuses a claim whose IR cannot be the relation its kind names', async () => {
    const root = fixture();
    const impl = translated(translateFile(root, 'src/pricing.ts', 'discountAmount'));
    const conformance = thresholdProperty({
      implementation: impl,
      param: 'total',
      operator: '>',
      value: '1000',
      whenTrue: '100',
    });
    const base = { propertyId: 'P', root, bindings: [], timeoutMs: 1000 };
    await expect(
      proveProperty({ ...base, kind: 'distinguishability', ir: conformance, mutantId: 'M-1' }),
    ).rejects.toThrow(/distinguishability claim refused/);
    await expect(
      proveProperty({ ...base, kind: 'property_detection', ir: conformance, mutantId: 'M-1' }),
    ).rejects.toThrow(/property_detection claim refused/);
    await expect(proveProperty({ ...base, kind: 'bounded_equivalence', ir: conformance })).rejects.toThrow(
      /mutant id is required/,
    );
    await expect(
      proveProperty({ ...base, kind: 'conformance', ir: conformance, mutantId: 'M-1' }),
    ).rejects.toThrow(/not a mutant/);
  });
});
