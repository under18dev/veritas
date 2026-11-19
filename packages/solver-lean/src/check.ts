import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type CommandResult, runCommand } from '@veritas/core';
import { z } from 'zod';
import { detectLean, type LeanInstallation, type LeanToolOptions } from './detect.js';

export const LeanCheckStatus = z.enum([
  'kernel_checked',
  'rejected',
  'failed',
  'timeout',
  'unavailable',
  'error',
]);
export type LeanCheckStatus = z.infer<typeof LeanCheckStatus>;

/** Result of building a Lean project and auditing the axioms of the requested theorems. */
export const LeanCheck = z.object({
  status: LeanCheckStatus,
  /** Axioms each requested theorem depends on, as reported by `#print axioms` (empty if never reached). */
  axioms: z.record(z.string(), z.array(z.string())),
  reasons: z.array(z.string()),
  /** Redacted and capped. */
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  leanVersion: z.string().nullable(),
});
export type LeanCheck = z.infer<typeof LeanCheck>;

/** Lean's standard axioms. Anything else (sorryAx, native_decide's Lean.ofReduceBool, ad-hoc axioms) is rejected. */
export const ALLOWED_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'] as const;

/**
 * Source tokens that are never accepted. Besides proof holes, extra axioms and trusted-code escapes, this
 * includes meta-programming and import-time code, which could otherwise rewrite how the audit itself reports.
 */
export const FORBIDDEN_TOKENS = [
  'sorry',
  'admit',
  'axiom',
  'native_decide',
  'unsafe',
  'implemented_by',
  'extern',
  'opaque',
  'initialize',
  'builtin_initialize',
  'macro',
  'macro_rules',
  'elab',
  'elab_rules',
  'syntax',
  'run_cmd',
  'run_elab',
  'run_meta',
] as const;

const FORBIDDEN = new RegExp(
  `(?<![A-Za-z0-9_'.])(${FORBIDDEN_TOKENS.map((t) => t.replace('.', '\\.')).join('|')})(?![A-Za-z0-9_'])`,
  'g',
);

/** Settings that skip the kernel or pass arbitrary options to Lean, in sources or in the Lake configuration. */
const KERNEL_BYPASS = /skipKernelTC|\b(moreLeanArgs|weakLeanArgs|leanOptions|moreServerOptions)\b/g;

const THEOREM = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MODULE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OUTPUT_CAP = 64 * 1024;
const SKIP_DIRS = new Set(['.lake', '.git', 'node_modules']);

export interface CheckLeanProjectOptions extends LeanToolOptions {
  theorems: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** A previous `detectLean` result, to avoid probing the toolchain again. */
  installation?: LeanInstallation;
}

interface SourceScan {
  modules: string[];
  findings: string[];
}

function scanSources(dir: string): SourceScan {
  const modules: string[] = [];
  const findings: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (lstatSync(path.join(dir, relPath)).isSymbolicLink()) {
        findings.push(`${relPath}: symbolic links are not accepted in a Lean project`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      const isLean = entry.name.endsWith('.lean');
      if (!isLean && relPath !== 'lakefile.toml') continue;
      const text = readFileSync(path.join(dir, relPath), 'utf8');
      text.split('\n').forEach((line, i) => {
        const tokens = [...(isLean ? line.matchAll(FORBIDDEN) : []), ...line.matchAll(KERNEL_BYPASS)];
        for (const match of tokens) findings.push(`${relPath}:${i + 1}: forbidden token \`${match[0]}\``);
      });
      if (!isLean) continue;
      if (relPath === 'lakefile.lean') continue;
      const segments = relPath.slice(0, -'.lean'.length).split('/');
      if (segments.every((s) => MODULE_SEGMENT.test(s))) modules.push(segments.join('.'));
    }
  };
  walk('');
  return { modules, findings };
}

function cap(text: string): string {
  return text.length <= OUTPUT_CAP
    ? text
    : `${text.slice(0, OUTPUT_CAP)}\n[... ${text.length - OUTPUT_CAP} characters truncated]`;
}

const stripQuotes = (name: string) => name.replace(/[«»]/g, '');

/** Parse `#print axioms` output; repeated reports for one theorem are merged, never overwritten. */
export function parseAxioms(output: string): Record<string, string[]> {
  const result: Record<string, Set<string>> = {};
  const add = (name: string, axioms: string[]) => {
    const key = stripQuotes(name);
    result[key] ??= new Set();
    for (const a of axioms) result[key].add(stripQuotes(a));
  };
  for (const m of output.matchAll(/'([^'\n]+)' depends on axioms: \[([^\]]*)\]/g)) {
    add(
      m[1] as string,
      (m[2] as string)
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    );
  }
  for (const m of output.matchAll(/'([^'\n]+)' does not depend on any axioms/g)) add(m[1] as string, []);
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, [...v].sort()]));
}

function describeAxiom(name: string): string {
  if (name === 'sorryAx') return 'sorryAx (the proof contains `sorry`/`admit` or an elaboration error)';
  if (name === 'Lean.ofReduceBool' || name === 'Lean.trustCompiler' || /\._native\.|native_decide/.test(name))
    return `${name} (native_decide / compiler-trusted evaluation)`;
  return `${name} (not one of Lean's standard axioms)`;
}

/**
 * Build a Lean project with `lake build` and audit `#print axioms` for each theorem.
 * `kernel_checked` only if the sources pass the token scan, the build succeeds and every theorem's
 * axioms are a subset of {propext, Classical.choice, Quot.sound}.
 * When the scan rejects the sources, Lean still runs (if available) so the axioms are reported,
 * but the result stays `rejected` whatever Lean says.
 */
export async function checkLeanProject(dir: string, options: CheckLeanProjectOptions): Promise<LeanCheck> {
  const started = Date.now();
  const reasons: string[] = [];
  let stdout = '';
  let stderr = '';
  const result = (status: LeanCheckStatus, axioms: Record<string, string[]>, leanVersion: string | null) =>
    LeanCheck.parse({
      status,
      axioms,
      reasons,
      stdout: cap(stdout),
      stderr: cap(stderr),
      durationMs: Date.now() - started,
      leanVersion,
    });

  if (options.theorems.length === 0) {
    reasons.push('no theorems to check');
    return result('error', {}, null);
  }
  const badName = options.theorems.find((t) => !THEOREM.test(t));
  if (badName !== undefined) {
    reasons.push(`invalid theorem name ${JSON.stringify(badName)}`);
    return result('error', {}, null);
  }
  let scan: SourceScan;
  try {
    scan = scanSources(dir);
  } catch (error) {
    reasons.push(`cannot read the project: ${(error as Error).message}`);
    return result('error', {}, null);
  }
  const rejectedBySource = scan.findings.length > 0;
  reasons.push(...scan.findings);
  if (scan.modules.length === 0) {
    reasons.push('no Lean modules found');
    return result(rejectedBySource ? 'rejected' : 'error', {}, null);
  }

  const lean = options.installation ?? (await detectLean(options));
  if (!lean.available || !lean.lake) {
    reasons.push(`Lean unavailable: ${lean.detail}`);
    return result(rejectedBySource ? 'rejected' : 'unavailable', {}, lean.version);
  }
  const binDir = path.dirname(lean.lean as string);
  const env = { PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter) };
  const run = (args: string[], timeoutMs: number, input?: string): Promise<CommandResult> =>
    runCommand(lean.lake as string, args, {
      cwd: dir,
      timeoutMs: Math.max(1, timeoutMs),
      env,
      maxOutputBytes: 2 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(input !== undefined ? { input } : {}),
    });
  const failure = (step: string, r: CommandResult): LeanCheckStatus | null => {
    if (r.timedOut) {
      reasons.push(`${step} timed out after ${r.durationMs} ms`);
      return 'timeout';
    }
    if (options.signal?.aborted) {
      reasons.push(`${step} was cancelled`);
      return 'error';
    }
    if (r.spawnError) {
      reasons.push(`${step} could not start: ${r.spawnError}`);
      return 'error';
    }
    if (r.exitCode !== 0) {
      reasons.push(`${step} failed with exit code ${r.exitCode ?? `signal ${r.signal}`}`);
      return 'failed';
    }
    return null;
  };
  const final = (status: LeanCheckStatus, axioms: Record<string, string[]> = {}) =>
    result(rejectedBySource ? 'rejected' : status, axioms, lean.version);

  const build = await run(['build'], options.timeoutMs);
  stdout += `$ lake build\n${build.stdout}`;
  stderr += build.stderr;
  const buildFailure = failure('lake build', build);
  if (buildFailure) {
    const errors = `${build.stdout}\n${build.stderr}`
      .split('\n')
      .filter((l) => /error/i.test(l))
      .slice(0, 20);
    reasons.push(...errors.map((l) => l.trim()));
    return final(buildFailure);
  }

  const remaining = options.timeoutMs - (Date.now() - started);
  if (remaining <= 0) {
    reasons.push('time budget exhausted before the axiom audit');
    return final('timeout');
  }
  const sentinel = `veritas-axiom-audit-${randomBytes(12).toString('hex')}`;
  const audit = [
    ...scan.modules.map((m) => `import ${m}`),
    ...options.theorems.map(
      (t) =>
        `#print axioms ${t
          .split('.')
          .map((s) => `«${s}»`)
          .join('.')}`,
    ),
    `#print "${sentinel}"`,
    '',
  ].join('\n');
  const check = await run(['env', 'lean', '--stdin'], remaining, audit);
  stdout += `\n$ lake env lean --stdin  (axiom audit)\n${check.stdout}`;
  stderr += check.stderr;
  const checkFailure = failure('axiom audit', check);
  const axioms = parseAxioms(check.stdout);
  const relevant = Object.fromEntries(
    options.theorems.flatMap((t) => (axioms[t] ? [[t, axioms[t]] as const] : [])),
  );
  if (checkFailure) {
    reasons.push(
      ...`${check.stdout}\n${check.stderr}`
        .split('\n')
        .filter((l) => /error/i.test(l))
        .slice(0, 20)
        .map((l) => l.trim()),
    );
    return final(checkFailure, relevant);
  }
  if (!check.stdout.includes(sentinel)) {
    reasons.push('the axiom audit did not run to completion');
    return final('failed', relevant);
  }
  let missing = false;
  let disallowed = false;
  for (const theorem of options.theorems) {
    if (!(theorem in axioms)) {
      reasons.push(`no axiom report for ${theorem}`);
      missing = true;
      continue;
    }
    const extra = (axioms[theorem] ?? []).filter((a) => !(ALLOWED_AXIOMS as readonly string[]).includes(a));
    if (extra.length > 0) {
      reasons.push(`${theorem} depends on ${extra.map(describeAxiom).join(', ')}`);
      disallowed = true;
    }
  }
  return final(disallowed ? 'rejected' : missing ? 'failed' : 'kernel_checked', relevant);
}
