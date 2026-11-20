import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashValue, resolveInsideRoot, sha256, VeritasError } from '@under18dev/veritas-core';
import type { PatchFile } from './schema.js';

/** Directories that are tool state or dependencies, not project content. */
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.veritas', '.mutator']);

/** sha256 per project file (symlinks by their target text), keyed by POSIX relative path. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(abs, relPath);
      } else if (entry.isSymbolicLink()) {
        if (!IGNORED_DIRS.has(entry.name)) out.set(relPath, `symlink:${readlinkSync(abs)}`);
      } else if (entry.isFile()) {
        out.set(relPath, sha256(readFileSync(abs)));
      }
    }
  };
  walk(root, '');

  return out;
}

export function treeHash(snapshot: Map<string, string>): string {
  return hashValue([...snapshot.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function projectHash(root: string): string {
  return treeHash(snapshotTree(root));
}

/** Paths whose hash differs between two snapshots (added, removed or changed). */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();

  for (const [p, h] of before) if (after.get(p) !== h) changed.add(p);

  for (const p of after.keys()) if (!before.has(p)) changed.add(p);

  return [...changed].sort();
}

/**
 * Copy the project into a fresh temporary directory, leaving out dependencies and tool state, and link
 * `node_modules` so the project's own Vitest and mutator are used without reinstalling.
 */
export function createWorkspace(root: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-improve-')));
  const realRoot = realpathSync(root);
  cpSync(realRoot, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(realRoot, src);

      return rel === '' || !rel.split(path.sep).some((s) => IGNORED_DIRS.has(s));
    },
  });
  const escaping = linksLeaving(dir);
  if (escaping.length > 0) {
    removeWorkspace(dir);
    throw new VeritasError(
      'user',
      'IMPROVE_UNSAFE_LINK',
      `the project has links outside the project, which the isolated run could write through: ${escaping.join(', ')}`,
      'replace them with real files or directories before applying an improvement',
    );
  }
  const modules = path.join(realRoot, 'node_modules');

  if (existsSync(modules)) linkPackages(modules, path.join(dir, 'node_modules'));

  return dir;
}

/** Copied symbolic links (kept verbatim) whose target is not inside `dir`, as `path -> target`. */
function linksLeaving(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const rel = path.relative(dir, path.resolve(current, target));
        if (rel.startsWith('..') || path.isAbsolute(rel))
          out.push(`${path.relative(dir, abs).split(path.sep).join('/')} -> ${target}`);
      } else if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return out;
}

export function removeWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface WriteRecord {
  files: string[];
  dirs: string[];
}

/**
 * Create each file exclusively (fails if anything already exists at the path, including a symlink).
 * On any error, everything written so far is removed again and the error is rethrown.
 */
export function writeNewFiles(root: string, files: PatchFile[]): WriteRecord {
  const record: WriteRecord = { files: [], dirs: [] };

  try {
    for (const file of files) {
      const abs = resolveInsideRoot(root, file.path);
      const missing: string[] = [];

      for (let d = path.dirname(abs); !existsSync(d); d = path.dirname(d)) missing.unshift(d);

      for (const d of missing) {
        mkdirSync(d);
        record.dirs.push(d);
      }
      // Re-check after creating directories: a directory swapped for a symlink must not redirect the write.
      resolveInsideRoot(root, file.path);
      writeFileSync(abs, file.content, { flag: 'wx' });
      record.files.push(abs);
    }

    return record;
  } catch (error) {
    undoWrites(record);
    throw error;
  }
}

/** Remove written files and the directories created for them (deepest first). Returns paths that could not be removed. */
export function undoWrites(record: WriteRecord): string[] {
  const failed: string[] = [];

  for (const file of [...record.files].reverse()) {
    try {
      if (lstatSync(file).isFile()) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(file);
    }
  }

  for (const dir of [...record.dirs].reverse()) {
    try {
      rmdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(dir);
    }
  }
  record.files = [];
  record.dirs = [];

  return failed;
}

/**
 * Link each installed package (and `.bin`) individually into a real `node_modules` directory of the workspace.
 * Tools write caches into `node_modules` (`.vite`, `.vitest-cache`); with a real directory those writes stay in
 * the workspace instead of reaching the project through a link.
 */
function linkPackages(from: string, to: string): void {
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    const source = path.join(from, entry);

    if (entry.startsWith('@')) {
      linkPackages(source, path.join(to, entry));
      continue;
    }
    symlinkSync(realpathSync(source), path.join(to, entry), 'junction');
  }
}
