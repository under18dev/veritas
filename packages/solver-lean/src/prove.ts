import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type FormalClaim,
  type PropertyIR,
  type RunStore,
  stableId,
  type VerificationStatus,
  VeritasError,
} from '@under18dev/veritas-core';
import { SEMANTIC_GAPS } from '@under18dev/veritas-formal-core';
import { z } from 'zod';
import { checkLeanProject, LeanCheck, LeanCheckStatus } from './check.js';
import { detectLean, type LeanToolOptions } from './detect.js';
import { irToLean, irUsesDivision, type LeanStrategy, leanProofStrategies, PROOF_NAMESPACE } from './emit.js';

export interface ProveWithLeanOptions extends LeanToolOptions {
  propertyId: string;
  ir: PropertyIR;
  /** Budget for each proof attempt (build plus axiom audit). */
  timeoutMs: number;
  store?: RunStore;
  signal?: AbortSignal;
}

export const LeanAttempt = z.object({
  strategy: z.string(),
  status: LeanCheckStatus,
  reasons: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  source: z.string(),
});
export type LeanAttempt = z.infer<typeof LeanAttempt>;

export interface LeanProveResult {
  claim: FormalClaim;
  check: LeanCheck;
  attempts: LeanAttempt[];
  /** The strategy whose proof the kernel accepted, if any. */
  strategy: string | null;
}

export const LEAN_ASSUMPTIONS = [
  'integers are mathematical integers (Lean `Int`) restricted to the stated domains',
  'functions are pure and terminate',
];

export const LEAN_MODEL_GAP =
  'the Lean model is generated from the property IR; its correspondence to the TypeScript implementation is a separate, unproven verification obligation';

const DIVISION_GAP =
  'Lean defines integer division and modulo by zero as 0, whereas JavaScript produces NaN or Infinity; division by zero is outside the modelled semantics';

const LAKEFILE = `name = "veritas_proof"\ndefaultTargets = ["${PROOF_NAMESPACE}"]\n\n[[lean_lib]]\nname = "${PROOF_NAMESPACE}"\n`;

const CLAIM_STATUS: Record<LeanCheckStatus, VerificationStatus> = {
  kernel_checked: 'proven_within_model',
  rejected: 'unknown',
  failed: 'unknown',
  timeout: 'timeout',
  unavailable: 'unsupported',
  error: 'error',
};

/** When no attempt is kernel checked, the most severe outcome describes the claim. */
const SEVERITY: LeanCheckStatus[] = ['rejected', 'error', 'timeout', 'failed', 'unavailable'];

/**
 * Translate the IR to Lean, try each deterministic tactic strategy in order and keep the first proof that
 * `lake build` compiles and whose axioms pass the audit. The claim is `proven_within_model` with
 * `kernel_checked` assurance only then; Lean being absent gives `unsupported`, never a pass.
 */
export async function proveWithLean(options: ProveWithLeanOptions): Promise<LeanProveResult> {
  const started = Date.now();
  const claimId = stableId('C', {
    engine: 'lean',
    kind: 'conformance',
    propertyId: options.propertyId,
    ir: options.ir,
  });
  const theoremName = `conformance_${claimId.replace(/[^A-Za-z0-9]/g, '_')}`;
  const theorem = `${PROOF_NAMESPACE}.${theoremName}`;
  const semanticGaps = [LEAN_MODEL_GAP, ...SEMANTIC_GAPS];
  const assumptions = [...LEAN_ASSUMPTIONS];
  const attempts: LeanAttempt[] = [];

  const finish = (
    check: LeanCheck,
    extra: {
      strategy?: string | null;
      engineVersion?: string | null;
      input?: string;
      output?: string;
      status?: VerificationStatus;
    } = {},
  ): LeanProveResult => {
    const status = extra.status ?? CLAIM_STATUS[check.status];
    const claim: FormalClaim = {
      id: claimId,
      propertyId: options.propertyId,
      kind: 'conformance',
      status,
      engine: 'lean',
      engineVersion: extra.engineVersion ?? check.leanVersion ?? 'unavailable',
      assurance: check.status === 'kernel_checked' ? 'kernel_checked' : 'none',
      modelId: stableId('M', options.ir.functions),
      assumptions,
      scope: {
        params: options.ir.params,
        preconditions: options.ir.preconditions,
        statement: 'forall params within their domains: preconditions imply body',
        theorem,
        strategy: extra.strategy ?? null,
        axioms: check.axioms[theorem] ?? null,
        leanCheck: check.status,
        reasons: check.reasons,
      },
      semanticGaps,
      ...(extra.input ? { solverInputArtifact: extra.input } : {}),
      ...(extra.output ? { solverOutputArtifact: extra.output } : {}),
      reproduction: extra.input
        ? `lake build (in ${path.posix.dirname(extra.input)}), then #print axioms ${theorem}`
        : 'rerun with an artifact store to keep the Lean project',
      semanticValidation: 'not_attempted',
      durationMs: Date.now() - started,
    };

    return { claim, check, attempts, strategy: extra.strategy ?? null };
  };
  const plainCheck = (status: LeanCheckStatus, reasons: string[], leanVersion: string | null): LeanCheck => ({
    status,
    axioms: {},
    reasons,
    stdout: '',
    stderr: '',
    durationMs: Date.now() - started,
    leanVersion,
  });

  let strategies: LeanStrategy[];

  try {
    strategies = leanProofStrategies(options.ir);
    irToLean(options.ir, { theoremName });
  } catch (error) {
    if (!(error instanceof VeritasError)) throw error;
    semanticGaps.push(`not translated to Lean: ${error.message}`);

    return finish(plainCheck('error', [`IR rejected: ${error.message}`], null), { status: 'unsupported' });
  }

  if (irUsesDivision(options.ir)) semanticGaps.push(DIVISION_GAP);

  const lean = await detectLean(options);

  if (!lean.available) {
    assumptions.push('Lean did not run');

    return finish(plainCheck('unavailable', [`Lean unavailable: ${lean.detail}`], lean.version));
  }

  const relDir = `proofs/lean/${claimId}`;
  const dir = options.store
    ? options.store.pathFor(relDir)
    : mkdtempSync(path.join(tmpdir(), 'veritas-lean-'));

  try {
    mkdirSync(dir, { recursive: true });
    const write = (name: string, content: string): string | undefined => {
      if (options.store) return options.store.writeText(`${relDir}/${name}`, content);
      writeFileSync(path.join(dir, name), content);

      return undefined;
    };
    write('lakefile.toml', LAKEFILE);
    let winner: { check: LeanCheck; strategy: string } | null = null;
    const checks: LeanCheck[] = [];
    let input: string | undefined;

    for (const strategy of strategies) {
      const source = irToLean(options.ir, { theoremName, strategy });
      input = write(`${PROOF_NAMESPACE}.lean`, source);
      const check = await checkLeanProject(dir, {
        theorems: [theorem],
        timeoutMs: options.timeoutMs,
        installation: lean,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      checks.push(check);
      attempts.push({
        strategy: strategy.name,
        status: check.status,
        reasons: check.reasons,
        durationMs: check.durationMs,
        source,
      });

      if (check.status === 'kernel_checked') {
        winner = { check, strategy: strategy.name };
        break;
      }

      if (options.signal?.aborted || check.status === 'unavailable') break;
    }

    let check: LeanCheck;

    if (winner) {
      check = winner.check;
      assumptions.push(
        `proof found by the deterministic tactic strategy ${winner.strategy} and accepted by the Lean kernel`,
        `axioms used: ${(check.axioms[theorem] ?? []).join(', ') || 'none'} (all standard)`,
      );
    } else {
      const status = SEVERITY.find((s) => checks.some((c) => c.status === s)) ?? 'error';
      const last = checks.at(-1);
      check = LeanCheck.parse({
        status,
        axioms: checks.find((c) => c.status === status)?.axioms ?? {},
        reasons: attempts.flatMap((a) => a.reasons.map((r) => `${a.strategy}: ${r}`)),
        stdout: last?.stdout ?? '',
        stderr: last?.stderr ?? '',
        durationMs: Date.now() - started,
        leanVersion: lean.version,
      });
      assumptions.push('no generated proof was accepted; the property is neither proven nor refuted by Lean');
    }

    let output: string | undefined;

    if (options.store) {
      options.store.write(`${relDir}.attempts.json`, z.array(LeanAttempt), attempts);
      output = options.store.writeText(
        `${relDir}.out`,
        `-- ${lean.version}; status ${check.status}; ${check.durationMs} ms\n` +
          `${check.reasons.map((r) => `-- ${r}`).join('\n')}\n${check.stdout}\n${check.stderr}`,
      );
    }

    return finish(check, {
      strategy: winner?.strategy ?? null,
      engineVersion: lean.version,
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    });
  } finally {
    if (!options.store) rmSync(dir, { recursive: true, force: true });
  }
}
