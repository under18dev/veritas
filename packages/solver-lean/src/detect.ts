import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leanToolCandidates, runCommand } from '@veritas/core';

export interface LeanInstallation {
  available: boolean;
  /** Resolved `lean` executable (the toolchain binary, not the elan proxy, when it can be resolved). */
  lean: string | null;
  lake: string | null;
  /** First line of `lean --version`. */
  version: string | null;
  detail: string;
}

export interface LeanToolOptions {
  leanPath?: string;
  lakePath?: string;
}

const exe = (tool: string) => (process.platform === 'win32' ? `${tool}.exe` : tool);

async function firstLine(command: string, args: string[]): Promise<string | null> {
  const result = await runCommand(command, args, { cwd: tmpdir(), timeoutMs: 30_000 });
  if (result.spawnError || result.exitCode !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0]?.trim() || null;
}

/**
 * Find a working `lean` and `lake`: explicit paths only when given, otherwise the PATH and then elan's
 * install directory (`~/.elan/bin`). The elan proxy is resolved to the toolchain's own binaries through
 * `lean --print-prefix`, so builds do not depend on elan's toolchain resolution (which may want network).
 */
export async function detectLean(options: LeanToolOptions = {}): Promise<LeanInstallation> {
  const leanCandidates = options.leanPath ? [options.leanPath] : leanToolCandidates('lean');
  let lean: string | null = null;
  let version: string | null = null;
  for (const candidate of leanCandidates) {
    version = await firstLine(candidate, ['--version']);
    if (version) {
      lean = candidate;
      break;
    }
  }
  if (!lean || !version) {
    return {
      available: false,
      lean: null,
      lake: null,
      version: null,
      detail: `lean not found or not runnable (tried ${leanCandidates.join(', ')})`,
    };
  }
  if (!/^Lean \(version 4\./.test(version)) {
    return { available: false, lean, lake: null, version, detail: `unsupported Lean version: ${version}` };
  }
  const prefix = await firstLine(lean, ['--print-prefix']);
  const toolchainBin = prefix ? path.join(prefix, 'bin') : null;
  if (toolchainBin && existsSync(path.join(toolchainBin, exe('lean'))))
    lean = path.join(toolchainBin, exe('lean'));

  const lakeCandidates = options.lakePath
    ? [options.lakePath]
    : [
        ...(toolchainBin && existsSync(path.join(toolchainBin, exe('lake')))
          ? [path.join(toolchainBin, exe('lake'))]
          : []),
        ...leanToolCandidates('lake'),
      ];
  let lake: string | null = null;
  for (const candidate of lakeCandidates) {
    if (await firstLine(candidate, ['--version'])) {
      lake = candidate;
      break;
    }
  }
  if (!lake) {
    return {
      available: false,
      lean,
      lake: null,
      version,
      detail: `lake not found or not runnable (tried ${lakeCandidates.join(', ')})`,
    };
  }
  return { available: true, lean, lake, version, detail: `${version}; lake at ${lake}` };
}
