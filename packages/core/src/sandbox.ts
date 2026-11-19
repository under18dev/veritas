import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process.js';

export type EncodedValue =
  | { t: 'number'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'string'; v: string }
  | { t: 'bigint'; v: string }
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'other'; v: string }
  | { t: 'throw'; v: string };

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
}): Promise<SandboxResult> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = path.join(here, `sandbox-runner${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`);
  const args = [
    '--permission',
    `--allow-fs-read=${options.root}`,
    `--allow-fs-read=${runner}`,
    '--disallow-code-generation-from-strings',
    '--disable-warning=ExperimentalWarning',
    runner,
  ];
  const result = await runCommand(process.execPath, args, {
    cwd: options.root,
    timeoutMs: options.timeoutMs,
    input: JSON.stringify({
      module: options.modulePath,
      exportName: options.exportName,
      calls: options.calls,
    }),
    signal: options.signal,
    envAllowlist: ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP'],
  });
  const isolation = {
    filesystemWrite: false as const,
    childProcess: false as const,
    network: sandboxBlocksNetwork(),
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
    const detail = result.stderr.split('\n').find((l) => /Error/.test(l)) ?? result.stderr.slice(0, 500);
    return {
      ...base,
      status: 'error',
      error: `sandboxed execution failed (exit ${result.exitCode}): ${detail.trim()}`,
    };
  }
}
