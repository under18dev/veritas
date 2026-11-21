import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, runCommand } from './process.js';
import { logEvent, nodeMemoryFlags, outOfMemory, relativeToRoot, runContext } from './run-context.js';

export type EncodedValue =
  | { t: 'number'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'string'; v: string }
  | { t: 'bigint'; v: string }
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'other'; v: string }
  | { t: 'throw'; v: string }
  /** Arguments only: a plain object or array built from encoded members (records and bounded arrays). */
  | { t: 'object'; v: Record<string, EncodedValue> }
  | { t: 'array'; v: EncodedValue[] };

export interface SandboxResult {
  status: 'ok' | 'error' | 'timeout';
  results: EncodedValue[];
  error: string | null;
  /** Isolation actually in force for this execution. */
  isolation: { filesystemWrite: false; childProcess: false; network: boolean };
  durationMs: number;
}

/** Network is denied by the permission model only on Node.js 25+, which added `--allow-net`. */
export function sandboxBlocksNetwork(version = process.versions.node): boolean {
  return Number(version.split('.')[0]) >= 25;
}

/** The Node.js that runs sandboxed project code. */
export interface SandboxRuntime {
  node: string;
  version: string;
  networkIsolated: boolean;
}

const runtimes = new Map<string, SandboxRuntime>();

/**
 * Pick the Node.js for sandboxed execution: this one on 25+, otherwise `VERITAS_SANDBOX_NODE` or the `node` on
 * PATH if either is 25+ (for example the Action runtime on Node 24 with a newer Node set up for the job).
 * Without one, the returned runtime is this Node.js with `networkIsolated: false`.
 */
export function sandboxRuntime(
  env: NodeJS.ProcessEnv = process.env,
  self: { node: string; version: string } = { node: process.execPath, version: process.versions.node },
): SandboxRuntime {
  const key = `${self.node}|${self.version}|${env.VERITAS_SANDBOX_NODE ?? ''}|${env.PATH ?? env.Path ?? ''}`;
  const cached = runtimes.get(key);

  if (cached) return cached;
  let runtime: SandboxRuntime = {
    node: self.node,
    version: self.version,
    networkIsolated: sandboxBlocksNetwork(self.version),
  };

  if (!runtime.networkIsolated) {
    const candidates = [env.VERITAS_SANDBOX_NODE, resolveCommand('node', { env })?.command].filter(
      (c): c is string => Boolean(c),
    );

    for (const node of candidates) {
      const probe = spawnSync(node, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env,
      });
      const version = probe.status === 0 ? probe.stdout.trim().replace(/^v/, '') : '';

      if (version && sandboxBlocksNetwork(version)) {
        runtime = { node, version, networkIsolated: true };
        break;
      }
    }
  }
  runtimes.set(key, runtime);

  return runtime;
}

/** Why sandboxed execution is refused, or null when it may run. */
export function sandboxRefusal(runtime: SandboxRuntime, allowNetworkWithoutIsolation = false): string | null {
  if (runtime.networkIsolated || allowNetworkWithoutIsolation) return null;

  return `project code is not run: Node.js ${runtime.version} cannot block network access from it; use Node.js 25+ (or set VERITAS_SANDBOX_NODE to one), or set sandbox.allowNetworkWithoutIsolation`;
}

/**
 * Call `exportName` from `modulePath` once per argument list, in a separate Node.js process running under
 * the permission model: read access to `root` only, no writes, no child processes, no workers, no network
 * (Node 25+), no code generation from strings. TypeScript modules run through Node's type stripping.
 */
export async function callInSandbox(options: {
  root: string;
  modulePath: string;
  exportName: string;
  calls: EncodedValue[][];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Run even when no Node.js 25+ is available to block network access (explicit opt-in). */
  allowNetworkWithoutIsolation?: boolean;
  /** V8 heap limit of the child in MiB; defaults to the run's `limits.memoryMb`. */
  memoryMb?: number;
}): Promise<SandboxResult> {
  const result = await sandboxCall(options);
  logEvent('debug', `sandbox call ${options.exportName}: ${result.status}`, {
    event: 'sandbox',
    module: relativeToRoot(options.modulePath),
    exportName: options.exportName,
    calls: options.calls.length,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
  });

  return result;
}

async function sandboxCall(options: Parameters<typeof callInSandbox>[0]): Promise<SandboxResult> {
  const sandbox = sandboxRuntime();
  const refusal = sandboxRefusal(sandbox, options.allowNetworkWithoutIsolation);

  if (refusal)
    return {
      status: 'error',
      results: [],
      error: refusal,
      isolation: { filesystemWrite: false, childProcess: false, network: false },
      durationMs: 0,
    };
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The permission model compares real paths, so symlinked roots (e.g. /var -> /private/var) must be resolved.
  const runner = realpathSync(
    path.join(here, `sandbox-runner${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`),
  );
  const root = realpathSync(options.root);
  const modulePath = realpathSync(options.modulePath);
  const memoryMb = options.memoryMb ?? runContext()?.memoryMb;
  const args = [
    ...nodeMemoryFlags(memoryMb),
    '--permission',
    `--allow-fs-read=${root}`,
    `--allow-fs-read=${runner}`,
    '--disallow-code-generation-from-strings',
    '--disable-warning=ExperimentalWarning',
    runner,
  ];
  const result = await runCommand(sandbox.node, args, {
    label: 'sandbox',
    cwd: root,
    timeoutMs: options.timeoutMs,
    input: JSON.stringify({
      module: modulePath,
      exportName: options.exportName,
      calls: options.calls,
    }),
    signal: options.signal,
    envAllowlist: ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP'],
  });
  const isolation = {
    filesystemWrite: false as const,
    childProcess: false as const,
    network: sandbox.networkIsolated,
  };
  const base = { isolation, durationMs: result.durationMs, results: [] as EncodedValue[] };

  if (result.timedOut)
    return { ...base, status: 'timeout', error: `execution exceeded ${options.timeoutMs} ms` };

  if (result.spawnError) return { ...base, status: 'error', error: result.spawnError };

  try {
    const parsed = JSON.parse(result.stdout) as { ok: boolean; results?: EncodedValue[]; error?: string };

    if (!parsed.ok) return { ...base, status: 'error', error: parsed.error ?? 'sandbox failed' };

    return { ...base, status: 'ok', results: parsed.results ?? [], error: null };
  } catch {
    if (outOfMemory(result.stderr))
      return {
        ...base,
        status: 'error',
        error: `sandboxed execution ran out of memory (limit ${memoryMb ?? 'default'} MiB, limits.memoryMb)`,
      };
    const detail = result.stderr.split('\n').find((l) => /Error/.test(l)) ?? result.stderr.slice(0, 500);

    return {
      ...base,
      status: 'error',
      error: `sandboxed execution failed (exit ${result.exitCode}): ${detail.trim()}`,
    };
  }
}
