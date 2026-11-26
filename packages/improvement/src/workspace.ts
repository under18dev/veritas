import {
  chmodSync,
  cpSync,
  type Dirent,
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
import { homedir } from 'node:os';
import path from 'node:path';
import { hashValue, resolveInsideRoot, sha256, VeritasError } from '@under18dev/veritas-core';
import type { PatchFile } from './schema.js';

/** Directories that are tool state or dependencies, not project content. */
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.veritas', '.mutator']);

/** Visit every entry of a project tree except ignored directories (and links named like them), without following links. */
function walkTree(root: string, visit: (relPath: string, abs: string, entry: Dirent) => void): void {
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      visit(relPath, abs, entry);

      if (entry.isDirectory()) walk(abs, relPath);
    }
  };
  walk(root, '');
}

/** sha256 per project file (symlinks by their target text), keyed by POSIX relative path. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  walkTree(root, (relPath, abs, entry) => {
    if (entry.isSymbolicLink()) out.set(relPath, `symlink:${readlinkSync(abs)}`);
    else if (entry.isFile()) out.set(relPath, sha256(readFileSync(abs)));
  });

  return out;
}

function describeEntry(abs: string): string {
  const s = lstatSync(abs, { bigint: true });

  if (s.isDirectory()) return `dir|${s.ino}|${s.mode}`;
  const target = s.isSymbolicLink() ? readlinkSync(abs) : '';

  return `${s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'other'}|${s.size}|${s.mtimeNs}|${s.ctimeNs}|${s.ino}|${s.mode}|${target}`;
}

/**
 * Metadata of every entry of a project tree (same exclusions as `snapshotTree`), keyed by POSIX relative path. A file
 * rewritten and then restored keeps its content but not its change time, which ordinary file APIs cannot set on macOS
 * and Linux (Windows lets a process set it). Directories are recorded by identity only: tool output in an ignored
 * directory updates the times of its parent.
 */
export function statTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  walkTree(root, (relPath, abs) => {
    out.set(relPath, describeEntry(abs));
  });

  return out;
}

/**
 * Metadata of the package entries of a workspace's own `node_modules` directory (each package link, the links in each
 * `@scope` directory, and `.bin`), keyed by POSIX relative path. The test runner and mutator are resolved from these
 * links, so code that swaps one for a package of its own could forge the measurement. Other hidden entries are
 * caches the tools write while they run (`.vite`, `.vitest`).
 */
export function statWorkspaceModules(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const modules = path.join(dir, 'node_modules');

  if (!existsSync(modules) && !isLink(modules)) return out;
  out.set('node_modules', describeEntry(modules));
  const walk = (abs: string, rel: string, scope: boolean) => {
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.') && !(name === '.bin' && !scope)) continue;
      const child = path.join(abs, name);
      const entry = describeEntry(child);
      out.set(`${rel}/${name}`, entry);

      if (!scope && name.startsWith('@') && entry.startsWith('dir|')) walk(child, `${rel}/${name}`, true);
    }
  };

  if (describeEntry(modules).startsWith('dir|')) walk(modules, 'node_modules', false);

  return out;
}

function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
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
 * Paths that differ between two snapshots of a tree other than the given new files with exactly their content:
 * anything else created, changed or deleted, and a given file that is missing, differs or already existed.
 */
export function unexpectedChanges(
  before: Map<string, string>,
  after: Map<string, string>,
  files: PatchFile[],
): string[] {
  const expected = new Map(files.map((f) => [f.path, sha256(f.content)]));
  const out = new Set(
    diffSnapshots(before, after).filter(
      (p) => !(expected.has(p) && !before.has(p) && after.get(p) === expected.get(p)),
    ),
  );

  for (const [p, h] of expected) if (before.has(p) || after.get(p) !== h) out.add(p);

  return [...out].sort();
}

/**
 * Where isolated copies are made: `veritas/improve` in the user's cache directory (`$XDG_CACHE_HOME` or `~/.cache` on
 * POSIX, `%LOCALAPPDATA%` on Windows), not the system temporary directory. Code in the copy resolves modules (test
 * imports, mutator plugins, Jest's own lookups) by walking up its parent directories; on Linux the temporary
 * directory is shared by every user, so another user could plant a `node_modules` there that the copy would load.
 * The parents of the user's cache directory are the user's own home and directories only root can write to.
 */
export function workspaceBase(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    process.platform === 'win32'
      ? env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
      : env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), '.cache');

  return path.join(base, 'veritas', 'improve');
}

/** Create `workspaceBase()` private to the user (0700), refusing one that is a link or owned by someone else. */
function privateBase(): string {
  const base = workspaceBase();
  mkdirSync(base, { recursive: true, mode: 0o700 });

  if (process.platform !== 'win32') {
    const s = lstatSync(base);

    if (!s.isDirectory() || s.uid !== process.getuid?.()) {
      throw new VeritasError(
        'user',
        'IMPROVE_UNSAFE_WORKSPACE_DIR',
        `${base} is not a directory owned by the current user, so isolated copies cannot be made there`,
        'remove it, or point XDG_CACHE_HOME to a directory you own',
      );
    }

    if ((s.mode & 0o077) !== 0) chmodSync(base, 0o700);
  }

  return realpathSync(base);
}

/**
 * Copy the project into a fresh directory under `workspaceBase()`, leaving out dependencies and tool state, and link
 * `node_modules` so the project's own test runner and mutator are used without reinstalling.
 */
export function createWorkspace(root: string): string {
  const dir = realpathSync(mkdtempSync(path.join(privateBase(), 'veritas-improve-')));
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
