import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Expr, FormalClaim, type PropertyIR, RunStore, VeritasError } from '@under18dev/veritas-core';
import { thresholdProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_AXIOMS,
  checkLeanProject,
  detectLean,
  irToLean,
  LeanCheck,
  type LeanInstallation,
  leanProofStrategies,
  parseAxioms,
  proveWithLean,
} from '../src/index.js';

const LEAN_TIMEOUT = 120_000;
const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/discount-boundary');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'veritas-lean-test-'));
const missingBinary = path.join(tmpdir(), 'veritas-no-such-dir', 'lean');

let lean: LeanInstallation;
beforeAll(async () => {
  lean = await detectLean();
}, 600_000);

/** Tests below run the real Lean toolchain. They fail (never skip) when Lean is not installed. */
function requireLean(): void {
  expect(lean.available, `Lean 4 and lake are required for this test: ${lean.detail}`).toBe(true);
}

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number | string): Expr => ({ kind: 'int', value: String(value) });
const bin = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({
  kind: 'binary',
  op,
  left,
  right,
});

/** Translate discountAmount from a copy of a fixture file and state the README rule as a property. */
function discountIR(relativeFile: string): PropertyIR {
  const dir = tmp();
  const copy = path.join(dir, path.basename(relativeFile));
  copyFileSync(path.join(FIXTURE, relativeFile), copy);
  const translated = translateFunction({
    file: relativeFile,
    source: readFileSync(copy, 'utf8'),
    exportName: 'discountAmount',
    domain: { min: '-1000000', max: '1000000' },
  });
  if (translated.status !== 'translated') throw new Error(`translation failed: ${translated.status}`);
  return thresholdProperty({
    implementation: translated,
    param: 'total',
    operator: '>=',
    value: '1000',
    whenTrue: '100',
    whenFalse: '0',
  });
}

function storeFor(): RunStore {
  return new RunStore(tmp(), 'run-lean-test', { configHash: 'c', sourceHash: 's', gitCommit: null });
}

/** A hand-written Lake project with one library module `Proj`. */
function project(source: string): string {
  const dir = tmp();
  writeFileSync(
    path.join(dir, 'lakefile.toml'),
    'name = "proj"\ndefaultTargets = ["Proj"]\n\n[[lean_lib]]\nname = "Proj"\n',
  );
  writeFileSync(path.join(dir, 'Proj.lean'), source);
  return dir;
}

describe('irToLean', () => {
  it('emits defs over Int/Bool, exact literals and the bounded theorem, deterministically', () => {
    const ir = discountIR('candidates/pricing-fixed.ts');
    const a = irToLean(ir, { theoremName: 'discount_rule' });
    const b = irToLean(structuredClone(ir), { theoremName: 'discount_rule' });
    expect(a).toBe(b);
    expect(a).toContain('def «f_discountAmount» («v_total» : Int) : Int :=');
    expect(a).toContain('(if (decide («v_total» ≥ (1000 : Int))) then (100 : Int) else (0 : Int))');
    expect(a).toContain('theorem «discount_rule» :');
    expect(a).toContain('∀ («v_total» : Int),');
    expect(a).toContain('(-1000000 : Int) ≤ «v_total» →');
    expect(a).toContain('«v_total» ≤ (1000000 : Int) →');
    expect(a).not.toMatch(/\b(sorry|admit|axiom|native_decide)\b/);
  });

  it('keeps integer literals beyond the double range exact', () => {
    const ir: PropertyIR = {
      irVersion: 1,
      params: [{ name: 'x', sort: 'int', domain: { min: '-9007199254740991', max: '9007199254740991' } }],
      preconditions: [],
      functions: [],
      body: bin('<', v('x'), n('9007199254740993')),
    };
    const src = irToLean(ir, { theoremName: 't' });
    expect(src).toContain('(9007199254740993 : Int)');
    expect(src).toContain('(-9007199254740991 : Int) ≤ «v_x»');
  });

  it('rejects names that could inject Lean source', () => {
    const base: PropertyIR = {
      irVersion: 1,
      params: [{ name: 'x', sort: 'int', domain: { min: '0', max: '1' } }],
      preconditions: [],
      functions: [],
      body: bin('>=', v('x'), n(0)),
    };
    const injectedParam: PropertyIR = {
      ...base,
      params: [
        {
          name: 'x» : Int) : True := trivial\naxiom cheat : False\n#check («y',
          sort: 'int',
          domain: { min: '0', max: '1' },
        },
      ],
    };
    expect(() => irToLean(injectedParam, { theoremName: 't' })).toThrow(VeritasError);
    const injectedFn: PropertyIR = {
      ...base,
      functions: [
        {
          name: 'f»\naxiom cheat : False',
          symbol: 's',
          params: [],
          returns: 'bool',
          body: { kind: 'bool', value: true },
        },
      ],
    };
    expect(() => irToLean(injectedFn, { theoremName: 't' })).toThrow(VeritasError);
    const injectedFnParam: PropertyIR = {
      ...base,
      functions: [
        {
          name: 'f',
          symbol: 's',
          params: [{ name: 'a»)', sort: 'int' }],
          returns: 'bool',
          body: bin('>', v('a»)'), n(0)),
        },
      ],
    };
    expect(() => irToLean(injectedFnParam, { theoremName: 't' })).toThrow(VeritasError);
    expect(() => irToLean(base, { theoremName: 't» : True := trivial\naxiom x : False' })).toThrow(
      VeritasError,
    );
    expect(() => irToLean(base, { theoremName: '' })).toThrow(VeritasError);
  });

  it('rejects IR that the SMT backend rejects, and opaque functions', () => {
    const illSorted: PropertyIR = {
      irVersion: 1,
      params: [{ name: 'x', sort: 'int', domain: { min: '0', max: '1' } }],
      preconditions: [],
      functions: [],
      body: bin('+', v('x'), n(1)),
    };
    expect(() => irToLean(illSorted, { theoremName: 't' })).toThrow(/bool/);
    const unsafeDomain: PropertyIR = {
      ...illSorted,
      params: [{ name: 'x', sort: 'int', domain: { min: '0', max: '9007199254740992' } }],
      body: bin('>=', v('x'), n(0)),
    };
    expect(() => irToLean(unsafeDomain, { theoremName: 't' })).toThrow(/safe-integer/);
    const opaque: PropertyIR = {
      ...illSorted,
      functions: [
        { name: 'g', symbol: 's', params: [{ name: 'a', sort: 'int' }], returns: 'int', body: null },
      ],
      body: bin('>=', { kind: 'call', fn: 'g', args: [v('x')] }, n(0)),
    };
    expect(() => irToLean(opaque, { theoremName: 't' })).toThrow(/opaque/);
  });

  it('offers exhaustive decide only for tiny domains', () => {
    const tiny: PropertyIR = {
      irVersion: 1,
      params: [
        { name: 'x', sort: 'int', domain: { min: '-63', max: '63' } },
        { name: 'b', sort: 'bool' },
      ],
      preconditions: [],
      functions: [],
      body: { kind: 'bool', value: true },
    };
    expect(leanProofStrategies(tiny).map((s) => s.name)).toEqual([
      'unfold-split-omega',
      'simp-split-omega',
      'decide-enumerate',
    ]);
    const big: PropertyIR = {
      ...tiny,
      params: [
        { name: 'x', sort: 'int', domain: { min: '-64', max: '64' } },
        tiny.params[1] as PropertyIR['params'][number],
      ],
    };
    expect(leanProofStrategies(big).map((s) => s.name)).toEqual(['unfold-split-omega', 'simp-split-omega']);
  });
});

describe('parseAxioms', () => {
  it('parses wrapped lists, axiom-free theorems and merges repeated reports', () => {
    const out = [
      "'A.t' depends on axioms: [propext,\n Classical.choice, Quot.sound]",
      "'A.«u»' does not depend on any axioms",
      "'A.t' depends on axioms: [propext]",
      "'A.t' depends on axioms: [sorryAx]",
    ].join('\n');
    expect(parseAxioms(out)).toEqual({
      'A.t': ['Classical.choice', 'Quot.sound', 'propext', 'sorryAx'],
      'A.u': [],
    });
  });
});

describe('detectLean', () => {
  it('finds lean and lake (also in ~/.elan/bin)', () => {
    requireLean();
    expect(lean.version).toMatch(/^Lean \(version 4\./);
    expect(lean.lean && existsSync(lean.lean)).toBe(true);
    expect(lean.lake && existsSync(lean.lake)).toBe(true);
  });

  it('reports a missing binary as unavailable', async () => {
    const missing = await detectLean({ leanPath: missingBinary });
    expect(missing.available).toBe(false);
    expect(missing.lean).toBeNull();
  });
});

describe('checkLeanProject (real Lean)', () => {
  it(
    'kernel checks a valid proof that uses only standard axioms',
    async () => {
      requireLean();
      const dir = project(
        'theorem ok (n : Nat) : n + 0 = n := rfl\ntheorem ok2 (a b : Int) (h : a ≤ b) : a < b + 1 := by omega\n',
      );
      const check = await checkLeanProject(dir, { theorems: ['ok', 'ok2'], timeoutMs: LEAN_TIMEOUT });
      expect(LeanCheck.parse(check).status).toBe('kernel_checked');
      expect(check.leanVersion).toMatch(/^Lean/);
      for (const axioms of Object.values(check.axioms)) {
        expect(axioms.every((a) => (ALLOWED_AXIOMS as readonly string[]).includes(a))).toBe(true);
      }
      expect(Object.keys(check.axioms).sort()).toEqual(['ok', 'ok2']);
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects `sorry` and still reports sorryAx',
    async () => {
      requireLean();
      const dir = project('theorem bad : 1 = 2 := by sorry\n');
      const check = await checkLeanProject(dir, { theorems: ['bad'], timeoutMs: LEAN_TIMEOUT });
      expect(check.status).toBe('rejected');
      expect(check.reasons.join('\n')).toMatch(/forbidden token `sorry`/);
      expect(check.axioms.bad).toContain('sorryAx');
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects `admit`',
    async () => {
      requireLean();
      const dir = project('theorem bad : 1 = 2 := by admit\n');
      const check = await checkLeanProject(dir, { theorems: ['bad'], timeoutMs: LEAN_TIMEOUT });
      expect(check.status).toBe('rejected');
      expect(check.reasons.join('\n')).toMatch(/`admit`/);
      expect(check.axioms.bad).toContain('sorryAx');
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects a custom axiom used in a proof',
    async () => {
      requireLean();
      const dir = project('axiom cheat : False\ntheorem bad : 1 = 2 := cheat.elim\n');
      const check = await checkLeanProject(dir, { theorems: ['bad'], timeoutMs: LEAN_TIMEOUT });
      expect(check.status).toBe('rejected');
      expect(check.axioms.bad).toContain('cheat');
      expect(check.reasons.join('\n')).toMatch(/cheat \(not one of Lean's standard axioms\)/);
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects native_decide',
    async () => {
      requireLean();
      const dir = project('theorem big : 2 ^ 20 = 1048576 := by native_decide\n');
      const check = await checkLeanProject(dir, { theorems: ['big'], timeoutMs: LEAN_TIMEOUT });
      expect(check.status).toBe('rejected');
      expect(check.reasons.join('\n')).toMatch(/native_decide/);
      // Depending on the Lean release, native_decide shows up as Lean.ofReduceBool or as a generated
      // `<decl>._native.native_decide.ax_*` axiom; either way it is outside the standard set.
      const nonStandard = (check.axioms.big ?? []).filter(
        (a) => !(ALLOWED_AXIOMS as readonly string[]).includes(a),
      );
      expect(nonStandard.length).toBeGreaterThan(0);
      expect(check.reasons.join('\n')).toMatch(/depends on .*native_decide/);
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects a hole that slips past the source scan through the axiom audit',
    async () => {
      requireLean();
      const dir = project('theorem sneaky : 1 = 2 := sorryAx _ false\n');
      const check = await checkLeanProject(dir, { theorems: ['sneaky'], timeoutMs: LEAN_TIMEOUT });
      expect(check.reasons.join('\n')).not.toMatch(/forbidden token/);
      expect(check.status).toBe('rejected');
      expect(check.axioms.sneaky).toContain('sorryAx');
      expect(check.reasons.join('\n')).toMatch(/sorryAx/);
    },
    LEAN_TIMEOUT,
  );

  it(
    'rejects settings that skip the kernel, in sources or in the Lake configuration',
    async () => {
      requireLean();
      const inSource = project('set_option debug.skipKernelTC true in\ntheorem ok : 1 = 1 := rfl\n');
      const a = await checkLeanProject(inSource, { theorems: ['ok'], timeoutMs: LEAN_TIMEOUT });
      expect(a.status).toBe('rejected');
      expect(a.reasons.join('\n')).toMatch(/skipKernelTC/);
      const inLakefile = project('theorem ok : 1 = 1 := rfl\n');
      writeFileSync(
        path.join(inLakefile, 'lakefile.toml'),
        'name = "proj"\ndefaultTargets = ["Proj"]\n\n[[lean_lib]]\nname = "Proj"\nleanOptions = { debug.skipKernelTC = true }\n',
      );
      const b = await checkLeanProject(inLakefile, { theorems: ['ok'], timeoutMs: LEAN_TIMEOUT });
      expect(b.status).toBe('rejected');
      expect(b.reasons.join('\n')).toMatch(/lakefile\.toml:6: forbidden token/);
    },
    LEAN_TIMEOUT,
  );

  it('rejects symbolic links inside the project', async () => {
    const dir = project('theorem ok : 1 = 1 := rfl\n');
    const outside = tmp();
    writeFileSync(path.join(outside, 'Evil.lean'), 'theorem e : 1 = 1 := rfl\n');
    symlinkSync(outside, path.join(dir, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const check = await checkLeanProject(dir, {
      theorems: ['ok'],
      timeoutMs: LEAN_TIMEOUT,
      leanPath: missingBinary,
    });
    expect(check.status).toBe('rejected');
    expect(check.reasons.join('\n')).toMatch(/symbolic links/);
  });

  it(
    'reports a syntax error as failed',
    async () => {
      requireLean();
      const dir = project('theorem broken : 1 = 1 := by\n  exact (\n');
      const check = await checkLeanProject(dir, { theorems: ['broken'], timeoutMs: LEAN_TIMEOUT });
      expect(check.status).toBe('failed');
      expect(check.axioms).toEqual({});
      expect(check.reasons.join('\n')).toMatch(/lake build failed/);
    },
    LEAN_TIMEOUT,
  );

  it(
    'reports a wrong proof as failed and a missing theorem as failed',
    async () => {
      requireLean();
      const wrong = await checkLeanProject(project('theorem w : (1 : Int) = 2 := by omega\n'), {
        theorems: ['w'],
        timeoutMs: LEAN_TIMEOUT,
      });
      expect(wrong.status).toBe('failed');
      const missing = await checkLeanProject(project('theorem ok : 1 = 1 := rfl\n'), {
        theorems: ['notThere'],
        timeoutMs: LEAN_TIMEOUT,
      });
      expect(missing.status).toBe('failed');
    },
    LEAN_TIMEOUT,
  );

  it('rejects theorem names that would inject commands, without running Lean', async () => {
    const check = await checkLeanProject(project('theorem ok : 1 = 1 := rfl\n'), {
      theorems: ['ok\n#eval IO.println "x"'],
      timeoutMs: LEAN_TIMEOUT,
      leanPath: missingBinary,
    });
    expect(check.status).toBe('error');
    expect(check.reasons[0]).toMatch(/invalid theorem name/);
  });

  it('reports Lean unavailable, never a pass', async () => {
    const check = await checkLeanProject(project('theorem ok : 1 = 1 := rfl\n'), {
      theorems: ['ok'],
      timeoutMs: LEAN_TIMEOUT,
      leanPath: missingBinary,
    });
    expect(check.status).toBe('unavailable');
    const bad = await checkLeanProject(project('theorem bad : 1 = 2 := by sorry\n'), {
      theorems: ['bad'],
      timeoutMs: LEAN_TIMEOUT,
      leanPath: missingBinary,
    });
    expect(bad.status).toBe('rejected');
  });

  it(
    'reports a tiny time budget as timeout',
    async () => {
      requireLean();
      const check = await checkLeanProject(project('theorem ok : 1 = 1 := rfl\n'), {
        theorems: ['ok'],
        timeoutMs: 1,
      });
      expect(check.status).toBe('timeout');
    },
    LEAN_TIMEOUT,
  );
});

describe('proveWithLean (real Lean)', () => {
  it(
    'kernel checks the fixed discount implementation against the README rule',
    async () => {
      requireLean();
      const store = storeFor();
      const { claim, check, strategy, attempts } = await proveWithLean({
        propertyId: 'P-discount',
        ir: discountIR('candidates/pricing-fixed.ts'),
        timeoutMs: LEAN_TIMEOUT,
        store,
      });
      expect(FormalClaim.parse(claim)).toBeTruthy();
      expect(check.status).toBe('kernel_checked');
      expect(claim.status).toBe('proven_within_model');
      expect(claim.assurance).toBe('kernel_checked');
      expect(claim.engine).toBe('lean');
      expect(claim.engineVersion).toMatch(/^Lean \(version 4\./);
      expect(strategy).toBe('unfold-split-omega');
      expect(attempts).toHaveLength(1);
      const theorem = claim.scope.theorem as string;
      const axioms = check.axioms[theorem] ?? [];
      expect(axioms.every((a) => (ALLOWED_AXIOMS as readonly string[]).includes(a))).toBe(true);
      expect(claim.semanticGaps.join('\n')).toMatch(/correspondence to the TypeScript implementation/);
      expect(claim.semanticGaps.join('\n')).toMatch(/safe integer/);
      const dir = path.join(store.dir, 'proofs', 'lean', claim.id);
      expect(existsSync(path.join(dir, 'lakefile.toml'))).toBe(true);
      expect(readFileSync(path.join(dir, 'VeritasProof.lean'), 'utf8')).toContain('theorem «conformance_');
      expect(claim.solverInputArtifact).toBe(`proofs/lean/${claim.id}/VeritasProof.lean`);
      expect(existsSync(path.join(store.dir, claim.solverOutputArtifact as string))).toBe(true);
      expect(existsSync(path.join(store.dir, 'proofs', 'lean', `${claim.id}.attempts.json`))).toBe(true);
    },
    LEAN_TIMEOUT * 3,
  );

  it(
    'never proves the buggy implementation (the theorem is false)',
    async () => {
      requireLean();
      const { claim, check, strategy, attempts } = await proveWithLean({
        propertyId: 'P-discount',
        ir: discountIR('src/pricing.ts'),
        timeoutMs: LEAN_TIMEOUT,
      });
      expect(claim.status).toBe('unknown');
      expect(claim.assurance).toBe('none');
      expect(check.status).toBe('failed');
      expect(strategy).toBeNull();
      expect(attempts.map((a) => a.strategy)).toEqual(['unfold-split-omega', 'simp-split-omega']);
      expect(attempts.every((a) => a.status === 'failed')).toBe(true);
      expect(check.reasons.join('\n')).toMatch(/error/);
    },
    LEAN_TIMEOUT * 3,
  );

  it(
    'falls back to exhaustive decide on a tiny non-linear domain, with preconditions and booleans',
    async () => {
      requireLean();
      const square = (x: Expr) => bin('*', x, x);
      const ir: PropertyIR = {
        irVersion: 1,
        params: [
          { name: 'x', sort: 'int', domain: { min: '-6', max: '6' } },
          { name: 'flag', sort: 'bool' },
        ],
        preconditions: [bin('!=', v('x'), n(0))],
        functions: [
          {
            name: 'sq',
            symbol: 'src/m.ts#sq',
            params: [{ name: 'a', sort: 'int' }],
            returns: 'int',
            body: square(v('a')),
          },
        ],
        body: bin('or', v('flag'), bin('>=', { kind: 'call', fn: 'sq', args: [v('x')] }, n(1))),
      };
      const { claim, strategy } = await proveWithLean({ propertyId: 'P-sq', ir, timeoutMs: LEAN_TIMEOUT });
      expect(claim.status).toBe('proven_within_model');
      expect(claim.assurance).toBe('kernel_checked');
      expect(strategy).toBe('decide-enumerate');
    },
    LEAN_TIMEOUT * 4,
  );

  it(
    'leaves a true non-linear property on a large domain unknown rather than proven',
    async () => {
      requireLean();
      const ir: PropertyIR = {
        irVersion: 1,
        params: [{ name: 'x', sort: 'int', domain: { min: '-1000', max: '1000' } }],
        preconditions: [],
        functions: [],
        body: bin('>=', bin('*', v('x'), v('x')), bin('-', n(0), n(0))),
      };
      const { claim, check } = await proveWithLean({ propertyId: 'P-sq-big', ir, timeoutMs: LEAN_TIMEOUT });
      // True, but outside what omega handles and too large for enumeration: not proven, not refuted.
      expect(check.status).toBe('failed');
      expect(claim.status).toBe('unknown');
      expect(claim.assurance).toBe('none');
      expect(claim.assumptions.join('\n')).toMatch(/neither proven nor refuted/);
    },
    LEAN_TIMEOUT * 3,
  );

  it('reports Lean unavailable as unsupported', async () => {
    const { claim, check } = await proveWithLean({
      propertyId: 'P-discount',
      ir: discountIR('candidates/pricing-fixed.ts'),
      timeoutMs: LEAN_TIMEOUT,
      leanPath: missingBinary,
    });
    expect(check.status).toBe('unavailable');
    expect(claim.status).toBe('unsupported');
    expect(claim.assurance).toBe('none');
    expect(claim.engineVersion).toBe('unavailable');
    expect(check.reasons.join('\n')).toMatch(/Lean unavailable/);
  });

  it(
    'reports a tiny time budget as timeout',
    async () => {
      requireLean();
      const { claim, check } = await proveWithLean({
        propertyId: 'P-discount',
        ir: discountIR('candidates/pricing-fixed.ts'),
        timeoutMs: 1,
      });
      expect(check.status).toBe('timeout');
      expect(claim.status).toBe('timeout');
      expect(claim.assurance).toBe('none');
    },
    LEAN_TIMEOUT,
  );

  it('reports IR with injected names as unsupported without running Lean', async () => {
    const ir: PropertyIR = {
      irVersion: 1,
      params: [{ name: 'x»\naxiom cheat : False', sort: 'int', domain: { min: '0', max: '1' } }],
      preconditions: [],
      functions: [],
      body: { kind: 'bool', value: true },
    };
    const { claim, check } = await proveWithLean({ propertyId: 'P-x', ir, timeoutMs: LEAN_TIMEOUT });
    expect(claim.status).toBe('unsupported');
    expect(claim.assurance).toBe('none');
    expect(check.status).toBe('error');
    expect(check.reasons[0]).toMatch(/IR rejected/);
  });
});
