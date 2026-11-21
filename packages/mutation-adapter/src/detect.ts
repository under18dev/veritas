import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runCommand } from '@under18dev/veritas-core';
import type { MutatorDetection, MutatorOrigin } from './schema.js';

/** The mutator version this adapter is built and tested against. Others run with a warning. */
export const PINNED_MUTATOR_VERSION = '0.4.5';

/** Flags the adapter passes; a mutator whose `--help` lacks one of these is unsupported. */
export const REQUIRED_CAPABILITIES = ['--root', '--reporter', '--report-dir'] as const;

/** Flags used only when the caller asks for them. */
export const OPTIONAL_CAPABILITIES = [
  '--since',
  '--include',
  '--kill-matrix',
  '--only',
  '--config',
  '--[no-]typecheck',
  '--time-budget',
  'agent',
  'json',
] as const;

export interface DetectOptions {
  /** Explicit path to the mutator CLI script; skips resolution. */
  binPath?: string;
  /** Fall back to the mutator this adapter depends on when the project has none (default true). */
  fallbackToAdapter?: boolean;
  timeoutMs?: number;
}

interface Located {
  binPath: string;
  version: string | null;
  origin: MutatorOrigin;
}

/** Walk up from `start` looking for `node_modules/@mizchi/mutator`, as Node's resolver would. */
function findPackageDir(start: string): string | null {
  let dir = path.resolve(start);

  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@mizchi', 'mutator', 'package.json');

    if (existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
}

function adapterPackageDir(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@mizchi/mutator');
    let dir = path.dirname(entry);

    while (!existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir);

      if (parent === dir) return null;
      dir = parent;
    }

    return dir;
  } catch {
    // Not installed next to the adapter: the caller reports the binary as unavailable.
    return null;
  }
}

function fromPackageDir(dir: string, origin: MutatorOrigin): Located | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      bin?: string | Record<string, string>;
    };

    if (pkg.name !== '@mizchi/mutator') return null;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.mutator;

    if (!bin) return null;
    const binPath = path.resolve(dir, bin);

    if (!existsSync(binPath)) return null;

    return { binPath, version: typeof pkg.version === 'string' ? pkg.version : null, origin };
  } catch {
    // An unreadable or malformed package.json means this candidate is not a usable mutator.
    return null;
  }
}

/** Locate the mutator CLI: the project's own installation first, then the adapter's dependency. */
export function locateMutator(root: string, options: DetectOptions = {}): Located | null {
  if (options.binPath !== undefined) {
    if (!existsSync(options.binPath)) return null;
    const pkgDir = path.dirname(path.dirname(options.binPath));
    const fromPkg = fromPackageDir(pkgDir, 'explicit');

    return { binPath: path.resolve(options.binPath), version: fromPkg?.version ?? null, origin: 'explicit' };
  }
  const projectDir = findPackageDir(root);
  const project = projectDir ? fromPackageDir(projectDir, 'project') : null;

  if (project) return project;

  if (options.fallbackToAdapter === false) return null;
  const adapterDir = adapterPackageDir();

  return adapterDir ? fromPackageDir(adapterDir, 'adapter') : null;
}

/** Find mutator and confirm, from its own `--help`, which flags it supports. */
export async function detectMutator(root: string, options: DetectOptions = {}): Promise<MutatorDetection> {
  const located = locateMutator(root, options);

  if (!located) {
    return {
      available: false,
      version: null,
      binPath: null,
      origin: null,
      capabilities: [],
      detail:
        options.binPath !== undefined
          ? `mutator CLI not found at ${options.binPath}`
          : `@mizchi/mutator is not installed in ${root} or its parents${options.fallbackToAdapter === false ? '' : ', nor next to @under18dev/veritas-mutation-adapter'}`,
    };
  }
  const help = await runCommand(process.execPath, [located.binPath, '--help'], {
    label: 'mutator --help',
    cwd: root,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const base = { version: located.version, binPath: located.binPath, origin: located.origin };

  if (help.spawnError || help.timedOut || help.exitCode !== 0) {
    const why = help.spawnError ?? (help.timedOut ? 'timed out' : `exit code ${help.exitCode}`);

    return {
      ...base,
      available: false,
      capabilities: [],
      detail: `mutator --help failed (${why}): ${summarize(help.stderr)}`,
    };
  }
  const text = help.stdout + help.stderr;
  const capabilities = [...REQUIRED_CAPABILITIES, ...OPTIONAL_CAPABILITIES].filter((flag) =>
    new RegExp(`(^|[\\s,])${flag.replace(/[-[\]]/g, '\\$&')}(?=[\\s,)]|$)`, 'm').test(text),
  );
  const missing = REQUIRED_CAPABILITIES.filter((flag) => !capabilities.includes(flag));
  const versionNote =
    located.version === PINNED_MUTATOR_VERSION
      ? `pinned version ${PINNED_MUTATOR_VERSION}`
      : `version ${located.version ?? 'unknown'} differs from the pinned ${PINNED_MUTATOR_VERSION}`;

  if (missing.length > 0) {
    return {
      ...base,
      available: false,
      capabilities,
      detail: `mutator at ${located.binPath} lacks required flags: ${missing.join(', ')} (${versionNote})`,
    };
  }

  return {
    ...base,
    available: true,
    capabilities,
    detail: `mutator resolved from the ${located.origin === 'project' ? 'project' : located.origin === 'adapter' ? 'adapter dependency' : 'explicit path'} at ${located.binPath} (${versionNote})`,
  };
}

/** The last lines of a (already redacted) output stream, for diagnostics. */
export function summarize(text: string, maxLines = 15, maxChars = 2000): string {
  const lines = text.trim().split('\n');
  const tail = lines.slice(-maxLines).join('\n');

  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

/** Version of the @mizchi/mutator copy that comes with this package, or null when there is none. */
export function bundledMutatorVersion(): string | null {
  const dir = adapterPackageDir();

  if (!dir) return null;

  try {
    return (
      (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ??
      null
    );
  } catch {
    return null;
  }
}
