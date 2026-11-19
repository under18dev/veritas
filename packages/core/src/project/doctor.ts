import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VeritasConfig } from '../config/schema.js';
import { runCommand } from '../process.js';
import { sandboxBlocksNetwork } from '../sandbox.js';
import type { Capability, CapabilityName } from '../schema/run.js';
import { detectProject, resolvePackageVersion } from './detect.js';

/** Which features depend on which capabilities. `required` missing => disabled; `optional` missing => degraded. */
export const FEATURES: Record<string, { required: CapabilityName[]; optional: CapabilityName[] }> = {
  init: { required: ['node'], optional: ['git'] },
  discover: { required: ['node'], optional: ['git', 'network', 'llm'] },
  analyze: { required: ['node', 'typescript'], optional: ['llm'] },
  mutate: { required: ['node', 'vitest', 'mutator'], optional: ['git'] },
  'test generate': { required: ['node', 'fast_check', 'vitest'], optional: ['llm'] },
  'prove (z3)': { required: ['node', 'z3'], optional: [] },
  'prove (lean)': { required: ['node', 'lean'], optional: [] },
  improve: { required: ['node', 'vitest', 'sandbox'], optional: ['mutator', 'z3', 'llm'] },
  report: { required: ['node'], optional: [] },
};

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

async function versionOf(command: string, args: string[], root: string): Promise<string | null> {
  const result = await runCommand(command, args, { cwd: root, timeoutMs: 10_000 });
  if (result.spawnError || result.exitCode !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0] ?? null;
}

/** Resolve a package from the project first, then from the Veritas installation itself. */
function packageVersion(
  root: string,
  name: string,
): { version: string | null; from: 'project' | 'veritas' | null } {
  const fromProject = resolvePackageVersion(root, name);
  if (fromProject) return { version: fromProject, from: 'project' };
  const fromSelf = resolvePackageVersion(path.dirname(fileURLToPath(import.meta.url)), name);
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

  const mutator = packageVersion(root, '@mizchi/mutator');
  add(
    'mutator',
    mutator.version ? 'available' : 'unavailable',
    mutator.version ? `@mizchi/mutator resolved from ${mutator.from}` : '@mizchi/mutator not installed',
    mutator.version,
  );

  const fc = packageVersion(root, 'fast-check');
  add(
    'fast_check',
    fc.version ? 'available' : 'unavailable',
    fc.version ? `resolved from ${fc.from}` : 'fast-check not installed',
    fc.version,
  );

  const z3wasm = packageVersion(root, 'z3-solver');
  const z3native = await versionOf('z3', ['--version'], root);
  add(
    'z3',
    z3wasm.version || z3native ? 'available' : 'unavailable',
    [z3wasm.version ? `z3-solver (wasm) ${z3wasm.version}` : null, z3native ? `native ${z3native}` : null]
      .filter(Boolean)
      .join('; ') || 'neither z3-solver nor a z3 executable found',
    z3wasm.version ?? z3native,
  );

  const lean = await versionOf('lean', ['--version'], root);
  const lake = await versionOf('lake', ['--version'], root);
  add(
    'lean',
    lean && lake ? 'available' : 'unavailable',
    lean && lake ? 'lean and lake found' : 'lean/lake not found (install via elan)',
    lean,
  );

  const provider = config?.llm.provider ?? 'none';
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);
  add(
    'llm',
    provider === 'none' ? 'disabled' : hasKey ? 'available' : 'unavailable',
    provider === 'none'
      ? 'no LLM provider configured; rule-based analysis only'
      : hasKey
        ? `${provider} configured, API key present`
        : `${provider} configured but ANTHROPIC_API_KEY is not set`,
  );

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
  const netIsolated = sandboxBlocksNetwork();
  add(
    'sandbox',
    !sandboxOk ? 'unavailable' : netIsolated ? 'available' : 'degraded',
    !sandboxOk
      ? 'cannot create temporary workspaces'
      : netIsolated
        ? 'permission-model sandbox: no writes, child processes or network'
        : 'permission-model sandbox without network isolation (requires Node.js 25+)',
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
