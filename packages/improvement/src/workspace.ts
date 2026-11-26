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
import { homedir, hostname, userInfo } from 'node:os';
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

function unsafeBase(base: string, why: string): VeritasError {
  return new VeritasError(
    'user',
    'IMPROVE_UNSAFE_WORKSPACE_DIR',
    `isolated copies cannot be made in ${base}: ${why}`,
    'point XDG_CACHE_HOME (LOCALAPPDATA on Windows) to a directory of your own outside the project',
  );
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);

  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of `p`, resolving the longest prefix of it that exists. */
function realpathOfExisting(p: string): string {
  const rest: string[] = [];

  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      if (path.dirname(current) === current) return path.resolve(p);
      rest.unshift(path.basename(current));
    }
  }
}

/**
 * Whether group `gid` is the private group of the user (user private groups, the default on Debian and Ubuntu, where
 * a umask of 002 makes directories group-writable): it is the user's primary group, `/etc/group` names it after the
 * user with no other members, and no other account in `/etc/passwd` has it as primary group. A group that cannot be
 * found in those files (directory services) is not taken as private.
 */
export function isPrivateGroup(
  gid: number,
  user: { username: string; uid: number; gid: number },
  files: { group: string; passwd: string },
): boolean {
  if (gid !== user.gid) return false;
  const group = files.group
    .split('\n')
    .map((line) => line.split(':'))
    .find((fields) => fields.length >= 4 && Number(fields[2]) === gid);

  if (!group || group[0] !== user.username) return false;
  const members = (group[3] ?? '').split(',').filter((m) => m.trim() !== '');

  if (members.some((m) => m.trim() !== user.username)) return false;

  return !files.passwd
    .split('\n')
    .map((line) => line.split(':'))
    .some((fields) => fields.length >= 4 && Number(fields[3]) === gid && Number(fields[2]) !== user.uid);
}

function privateGroupOfUser(gid: number): boolean {
  try {
    const info = userInfo();

    return isPrivateGroup(
      gid,
      { username: info.username, uid: info.uid, gid: info.gid },
      { group: readFileSync('/etc/group', 'utf8'), passwd: readFileSync('/etc/passwd', 'utf8') },
    );
  } catch {
    return false;
  }
}

/**
 * Create `workspaceBase()` private to the user (0700) and return its real path. Refused, before anything is created,
 * when it lies in the project (the copy would copy itself). On POSIX also refused when it is a link or not the user's,
 * or when a directory above it belongs to another user than the user or root, can be written by every user (as a
 * shared temporary directory can, sticky or not), or can be written by a group other than the user's private group:
 * others could then put a `node_modules` where code in the copy looks for modules.
 */
function privateBase(root: string): string {
  const base = workspaceBase();
  const realRoot = realpathSync(root);

  if (within(realpathOfExisting(base), realRoot)) throw unsafeBase(base, 'it is inside the project');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const realBase = realpathSync(base);

  if (within(realBase, realRoot)) throw unsafeBase(realBase, 'it is inside the project');

  if (process.platform === 'win32') return realBase;
  const uid = process.getuid?.();
  const s = lstatSync(base);

  if (!s.isDirectory() || s.uid !== uid)
    throw unsafeBase(base, 'it is not a directory owned by the current user');

  if ((s.mode & 0o077) !== 0) chmodSync(base, 0o700);

  for (let dir = path.dirname(realBase); ; dir = path.dirname(dir)) {
    const a = lstatSync(dir);

    if (a.uid !== uid && a.uid !== 0)
      throw unsafeBase(realBase, `${dir} above it belongs to another user (uid ${a.uid})`);

    if ((a.mode & 0o002) !== 0)
      throw unsafeBase(
        realBase,
        `${dir} above it can be written by every user; run \`chmod o-w ${dir}\` if it is yours`,
      );

    if ((a.mode & 0o020) !== 0 && !privateGroupOfUser(a.gid))
      throw unsafeBase(
        realBase,
        `${dir} above it can be written by its group (gid ${a.gid}), which is not your private group; run \`chmod g-w ${dir}\``,
      );

    if (path.dirname(dir) === dir) break;
  }

  return realBase;
}

const COPY_NAME = /^veritas-improve-[A-Za-z0-9]{6}$/;
const OWNER_SUFFIX = '.owner';
/** A copy without an owner record (made before records existed) is removed after this long. */
const UNOWNED_STALE_MS = 24 * 60 * 60 * 1000;
/** A copy made on another host sharing this cache directory is removed after this long. */
const FOREIGN_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Where this process runs, to tell whether the process named in an owner record can be checked from here: the host
 * name, and on Linux the boot id and the pid namespace (containers on one host share the boot id and may share a
 * host name, but not the pid namespace).
 */
export function workspaceMachine(): { host: string; bootId: string | null; pidNamespace: string | null } {
  let pidNamespace: string | null = null;

  try {
    pidNamespace = process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : null;
  } catch {
    pidNamespace = null;
  }

  return {
    host: hostname(),
    bootId: process.platform === 'linux' ? readOrNull('/proc/sys/kernel/random/boot_id') : null,
    pidNamespace,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove copies left behind by an apply that ended without cleaning up (killed, or a crash). Each copy has an owner
 * record next to it (`<copy>.owner`: process id and host). A copy is removed only when its process on this host is
 * gone; a copy of another host (a cache directory shared over the network) or without a record only once it is old.
 * A running apply's copy is never removed: its process is alive (a reused process id keeps a copy, never the reverse).
 */
export function removeStaleWorkspaces(base: string, now = Date.now()): string[] {
  const removed: string[] = [];
  const here = workspaceMachine();
  let entries: string[];

  try {
    entries = readdirSync(base);
  } catch {
    return removed;
  }

  for (const name of entries) {
    const dir = path.join(base, name);

    if (name.endsWith(OWNER_SUFFIX)) {
      // A record whose copy is gone.
      if (
        COPY_NAME.test(name.slice(0, -OWNER_SUFFIX.length)) &&
        !existsSync(dir.slice(0, -OWNER_SUFFIX.length))
      )
        rmSync(dir, { force: true });
      continue;
    }

    if (!COPY_NAME.test(name)) continue;
    let stale: boolean;

    try {
      const age = now - lstatSync(dir).mtimeMs;
      let owner: { pid?: unknown; host?: unknown; bootId?: unknown; pidNamespace?: unknown } | null = null;

      try {
        owner = JSON.parse(readFileSync(dir + OWNER_SUFFIX, 'utf8'));
      } catch {
        owner = null;
      }

      stale =
        owner === null || typeof owner.pid !== 'number'
          ? age > UNOWNED_STALE_MS
          : owner.host === here.host &&
              owner.bootId === here.bootId &&
              owner.pidNamespace === here.pidNamespace
            ? !processAlive(owner.pid)
            : age > FOREIGN_STALE_MS;
    } catch {
      continue;
    }

    if (stale) {
      removeWorkspace(dir);
      removed.push(dir);
    }
  }

  return removed;
}

/**
 * Copy the project into a fresh directory under `workspaceBase()`, leaving out dependencies and tool state, and link
 * `node_modules` so the project's own test runner and mutator are used without reinstalling.
 */
export function createWorkspace(root: string): string {
  const base = privateBase(root);
  removeStaleWorkspaces(base);
  const dir = realpathSync(mkdtempSync(path.join(base, 'veritas-improve-')));

  try {
    const owner = {
      pid: process.pid,
      ...workspaceMachine(),
      // When the owning process started: with the pid, it tells a reused pid apart when reading the record by hand.
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
    writeFileSync(dir + OWNER_SUFFIX, JSON.stringify(owner), { mode: 0o600 });
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
  } catch (error) {
    // A partial copy holds project files (possibly secrets such as .env): never leave one behind.
    removeWorkspace(dir);
    throw error;
  }
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
  rmSync(dir + OWNER_SUFFIX, { force: true });
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
