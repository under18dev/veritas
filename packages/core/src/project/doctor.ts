import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VeritasConfig } from '../config/schema.js';
import { runCommand } from '../process.js';
import { sandboxRuntime } from '../sandbox.js';
import type { Capability, CapabilityName } from '../schema/run.js';
import { detectProject, resolvePackageVersion } from './detect.js';
import { llmAvailability } from './llm.js';

/** Which features depend on which capabilities. `required` missing => disabled; `optional` missing => degraded. */
export const FEATURES: Record<string, { required: CapabilityName[]; optional: CapabilityName[] }> = {
  init: { required: ['node'], optional: ['git'] },
  discover: { required: ['node'], optional: ['git', 'network', 'llm'] },
  analyze: { required: ['node', 'typescript'], optional: ['llm'] },
  mutate: { required: ['node', 'vitest', 'mutator'], optional: ['git'] },
  'test generate': { required: ['node', 'fast_check', 'vitest'], optional: ['llm'] },
  'prove (z3)': { required: ['node', 'z3'], optional: ['sandbox'] },
  'prove (lean)': { required: ['node', 'lean'], optional: [] },
  improve: { required: ['node', 'vitest', 'sandbox'], optional: ['mutator', 'z3', 'llm'] },
  report: { required: ['node'], optional: [] },
};

/**
 * Vitest versions mutation testing works with. @mizchi/mutator declares Vitest 5; Vitest 4 projects run, while on
 * Vitest 3 and earlier its test runner integration fails before any mutant is tried.
 */
export const MUTATOR_MIN_VITEST_MAJOR = 4;
export const MUTATOR_DECLARED_VITEST_MAJOR = 5;

export function vitestMajor(version: string | null): number | null {
  const major = version ? Number.parseInt(version, 10) : Number.NaN;

  return Number.isNaN(major) ? null : major;
}

export interface FeatureStatus {
  feature: string;
  state: 'enabled' | 'degraded' | 'disabled';
  missing: CapabilityName[];
}

export interface DoctorReport {
  root: string;
  os: { platform: string; arch: string; release: string };
  capabilities: Capability[];
  features: FeatureStatus[];
}

/**
 * Where to look for a Lean toolchain executable: the PATH first, then elan's default install
 * directories (`$ELAN_HOME/bin`, `~/.elan/bin`), which are often not on the PATH of non-login shells.
 */
export function leanToolCandidates(tool: 'lean' | 'lake', env: NodeJS.ProcessEnv = process.env): string[] {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [env.ELAN_HOME ? path.join(env.ELAN_HOME, 'bin') : null, path.join(home, '.elan', 'bin')];
  const candidates = [tool, ...dirs.filter((d): d is string => d !== null).map((d) => path.join(d, exe))];

  return [...new Set(candidates)];
}

async function firstVersion(candidates: string[], args: string[], root: string): Promise<string | null> {
  for (const command of candidates) {
    const version = await versionOf(command, args, root);

    if (version) return version;
  }

  return null;
}

async function versionOf(command: string, args: string[], root: string): Promise<string | null> {
  const result = await runCommand(command, args, { cwd: root, timeoutMs: 10_000 });

  if (result.spawnError || result.exitCode !== 0) return null;

  return (result.stdout || result.stderr).trim().split('\n')[0] ?? null;
}

/**
 * Versions of the tools the Veritas installation brings itself, as the packages that run them resolve them
 * (mutation-adapter, property-testing, solver-z3). `core` cannot see their dependencies under a strict layout
 * (pnpm), so the caller that depends on those packages passes them in.
 */
export type BundledTools = Partial<Record<'@mizchi/mutator' | 'fast-check' | 'z3-solver', string | null>>;

/** Resolve a package from the project first, then from the Veritas installation itself. */
function packageVersion(
  root: string,
  name: string,
  bundled: BundledTools = {},
): { version: string | null; from: 'project' | 'veritas' | null } {
  const fromProject = resolvePackageVersion(root, name);

  if (fromProject) return { version: fromProject, from: 'project' };
  const fromSelf =
    bundled[name as keyof BundledTools] ??
    resolvePackageVersion(path.dirname(fileURLToPath(import.meta.url)), name);

  return fromSelf ? { version: fromSelf, from: 'veritas' } : { version: null, from: null };
}

function affects(name: CapabilityName): string[] {
  return Object.entries(FEATURES)
    .filter(([, f]) => f.required.includes(name) || f.optional.includes(name))
    .map(([feature]) => feature);
}

export async function runDoctor(
  root: string,
  config: VeritasConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  bundled: BundledTools = {},
): Promise<DoctorReport> {
  const project = detectProject(root);
  const caps: Capability[] = [];
  const add = (name: CapabilityName, state: Capability['state'], detail: string, version?: string | null) =>
    caps.push({ name, state, detail, affects: affects(name), ...(version ? { version } : {}) });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(
    'node',
    nodeMajor >= 24 ? 'available' : 'unavailable',
    nodeMajor >= 24 ? 'Node.js >= 24' : 'Node.js 24 or later is required',
    process.versions.node,
  );

  const git = await versionOf('git', ['--version'], root);
  add(
    'git',
    git && project.git ? 'available' : git ? 'degraded' : 'unavailable',
    !git
      ? 'git executable not found'
      : project.git
        ? 'git repository detected'
        : 'not a git repository; --since and commit metadata disabled',
    git,
  );

  add(
    'package_manager',
    project.packageManager === 'unknown' ? 'degraded' : 'available',
    project.packageManager === 'unknown' ? 'no lockfile found' : `detected from lockfile`,
    project.packageManager,
  );

  const ts = packageVersion(root, 'typescript');
  add(
    'typescript',
    ts.version ? 'available' : 'unavailable',
    ts.version ? `resolved from ${ts.from}` : 'typescript not resolvable',
    ts.version,
  );

  const vitest = project.vitest.installedVersion;
  add(
    'vitest',
    vitest ? 'available' : 'unavailable',
    vitest
      ? 'resolved from project'
      : project.vitest.declared
        ? 'declared but not installed; run your package manager install'
        : 'Vitest not found in project',
    vitest,
  );

  const mutator = packageVersion(root, '@mizchi/mutator', bundled);
  const tooOld = (vitestMajor(vitest) ?? MUTATOR_MIN_VITEST_MAJOR) < MUTATOR_MIN_VITEST_MAJOR;
  add(
    'mutator',
    mutator.version && !tooOld ? 'available' : 'unavailable',
    !mutator.version
      ? '@mizchi/mutator not installed'
      : tooOld
        ? `@mizchi/mutator needs Vitest ${MUTATOR_MIN_VITEST_MAJOR} or later; the project has Vitest ${vitest}`
        : `@mizchi/mutator resolved from ${mutator.from}`,
    mutator.version,
  );

  const fc = packageVersion(root, 'fast-check', bundled);
  add(
    'fast_check',
    fc.version ? 'available' : 'unavailable',
    fc.version ? `resolved from ${fc.from}` : 'fast-check not installed',
    fc.version,
  );

  // `prove` runs the z3-solver WebAssembly build; a native z3 executable alone does not make it available.
  const z3wasm = packageVersion(root, 'z3-solver', bundled);
  add(
    'z3',
    z3wasm.version ? 'available' : 'unavailable',
    z3wasm.version ? `z3-solver (wasm) resolved from ${z3wasm.from}` : 'z3-solver (wasm) not installed',
    z3wasm.version,
  );

  const lean = await firstVersion(leanToolCandidates('lean', env), ['--version'], root);
  const lake = await firstVersion(leanToolCandidates('lake', env), ['--version'], root);
  add(
    'lean',
    lean && lake ? 'available' : 'unavailable',
    lean && lake ? 'lean and lake found' : 'lean/lake not found on PATH or in ~/.elan/bin (install via elan)',
    lean,
  );

  const llm = await llmAvailability(config?.llm.provider ?? 'none', env, root, {
    allowCodexFileReads: config?.llm.allowCodexFileReads ?? false,
  });
  add('llm', llm.state, llm.detail);

  const networkWanted = Boolean(config?.sources.web.enabled || config?.sources.github.enabled);
  add(
    'network',
    networkWanted ? 'available' : 'disabled',
    networkWanted ? 'network sources enabled by config' : 'network access disabled (default)',
  );

  let sandboxOk = false;

  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'veritas-doctor-'));
    accessSync(dir, constants.W_OK);
    rmSync(dir, { recursive: true, force: true });
    sandboxOk = true;
  } catch {
    sandboxOk = false;
  }
  const runtime = sandboxRuntime(env);
  const allowed = config?.sandbox.allowNetworkWithoutIsolation ?? false;
  const via = runtime.node === process.execPath ? '' : ` (Node.js ${runtime.version} at ${runtime.node})`;
  add(
    'sandbox',
    !sandboxOk ? 'unavailable' : runtime.networkIsolated ? 'available' : allowed ? 'degraded' : 'unavailable',
    !sandboxOk
      ? 'cannot create temporary workspaces'
      : runtime.networkIsolated
        ? `restricted process (permission model; defence in depth, the project's code is trusted): no writes, child processes or network${via}`
        : allowed
          ? `restricted process WITHOUT network isolation (Node.js ${runtime.version}; allowed by sandbox.allowNetworkWithoutIsolation)`
          : `project code is not run: Node.js ${runtime.version} cannot block network access; use Node.js 25+ or set VERITAS_SANDBOX_NODE`,
  );

  const stateOf = new Map(caps.map((c) => [c.name, c.state]));
  const usable = (n: CapabilityName) => stateOf.get(n) === 'available' || stateOf.get(n) === 'degraded';
  const features: FeatureStatus[] = Object.entries(FEATURES).map(([feature, deps]) => {
    const missingRequired = deps.required.filter((n) => !usable(n));
    const missingOptional = deps.optional.filter((n) => stateOf.get(n) !== 'available');

    return {
      feature,
      state: missingRequired.length ? 'disabled' : missingOptional.length ? 'degraded' : 'enabled',
      missing: [...missingRequired, ...missingOptional],
    };
  });

  return {
    root,
    os: { platform: process.platform, arch: process.arch, release: release() },
    capabilities: caps,
    features,
  };
}
