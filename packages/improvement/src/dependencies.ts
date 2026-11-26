import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gitRun } from '@under18dev/veritas-core';

/**
 * Stat snapshot of the installed dependencies that an isolated workspace reaches through its links, keyed by
 * absolute real path. The workspace links each package to its real location (see `createWorkspace`), so code run
 * there can write into the project's real dependencies; comparing two snapshots shows whether it did.
 *
 * Only metadata is read (no hashing). The change time is recorded because ordinary file APIs cannot set it on
 * macOS and Linux: restoring a file's content and modification time still changes it. (Windows lets a process set
 * it through `SetFileInformationByHandle`, so there the comparison is weaker.)
 */
export class DependencySnapshot extends Map<string, string> {
  /**
   * Links in a package linked from outside node_modules whose targets were not walked, as `link -> target`: they lead
   * out of the package's repository to something that is not a package (`logs -> /var/log`). Writes through them are
   * not detected; the caller must say so rather than imply they were checked.
   */
  get unchecked(): string[] {
    return [...this.uncheckedLinks].sort();
  }

  /** @internal */
  readonly uncheckedLinks = new Set<string>();
}

/** Entries walked at most; a larger snapshot is refused rather than cut short. */
export const MAX_DEPENDENCY_ENTRIES = 2_000_000;

const NODE_MODULES = 'node_modules';

/** Whether `p` is `dir` or inside it. */
function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);

  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The tree to walk for a real path: the outermost `node_modules` directory above it (a pnpm `.pnpm` store keeps a
 * package's dependencies next to it, not inside it), or the path itself when it is not inside one (a workspace
 * package linked from elsewhere).
 */
function treeRoot(real: string): string {
  const parts = real.split(path.sep);
  const i = parts.indexOf(NODE_MODULES);

  return i === -1 ? real : parts.slice(0, i + 1).join(path.sep) || path.sep;
}

function describe(abs: string): string {
  try {
    const s = lstatSync(abs, { bigint: true });
    // A directory is described by its entries, which are walked; its own times also change when a skipped cache
    // entry appears in it.
    if (s.isDirectory()) return `dir|${s.ino}|${s.mode}`;
    const type = s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : 'other';
    const target = s.isSymbolicLink() ? readlinkSync(abs) : '';

    // The change time and link count come last: see `sameEntry`.
    return `${type}|${s.size}|${s.mtimeNs}|${s.ino}|${s.mode}|${target}|${s.ctimeNs}|${s.nlink}`;
  } catch (error) {
    return `unreadable|${(error as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

/**
 * Snapshot every dependency tree reachable from `<root>/node_modules`: that directory (or the store it lives in),
 * and, transitively, the real location of every link found in a tree already reached: inside a `node_modules`
 * directory always, outside one only to dependency code (see `dependencyTarget`; the others are listed in
 * `unchecked`). Links are recorded, never followed
 * while walking; their targets are walked once each, by real path, so link cycles end. A hidden entry at the top of a `node_modules` directory (other than `.bin`) is walked
 * only when a link leads into it, as into a `.pnpm` or `.bun` store; the others are tool caches (`.vite`, `.cache`)
 * that the workspace does not link (it gets a `node_modules` directory of its own) and that tools running in the real
 * project may update at any time.
 */
export function snapshotDependencies(
  root: string,
  options: { maxEntries?: number } = {},
): DependencySnapshot {
  const maxEntries = options.maxEntries ?? MAX_DEPENDENCY_ENTRIES;
  const out = new DependencySnapshot();
  const realRoot = realpathSync(root);
  const modules = path.join(realRoot, NODE_MODULES);

  if (!existsSync(modules)) return out;
  const covered: string[] = [];
  const queue: string[] = [];
  const links: string[] = [];
  const skipped = new Set<string>();
  /** Queue the tree of a real path; true when it is new and the path lies below its root. */
  const cover = (real: string): boolean => {
    const tree = treeRoot(real);

    // A tree holding the project itself is never walked: the workspace is a copy of the project, not a link to it.
    if (inside(realRoot, tree) || covered.some((c) => inside(tree, c))) return false;
    covered.push(tree);
    queue.push(tree);

    return tree !== real;
  };
  const follow = (link: string) => {
    let real: string;

    try {
      real = realpathSync(link);
    } catch {
      return; // A dangling link reaches nothing; its own entry is recorded.
    }
    const into = [...skipped].find((dir) => inside(real, dir));

    if (into !== undefined) {
      skipped.delete(into);
      queue.push(into);
      return;
    }

    if (covered.some((c) => inside(real, c))) return;

    // Outside node_modules a link may lead anywhere (`logs -> /var/log`): only follow it to dependency code.
    if (!link.split(path.sep).includes(NODE_MODULES) && !dependencyTarget(link, real, realRoot)) {
      // Into the project: its files are copied, not shared, and the repository is compared before writing.
      if (!inside(real, realRoot)) out.uncheckedLinks.add(`${link} -> ${real}`);
      return;
    }

    try {
      if (statSync(real).isDirectory() || real.split(path.sep).includes(NODE_MODULES)) {
        // Follow the link again once its tree is walked: the target may lie in a hidden store skipped there.
        if (cover(real)) links.push(link);
      } else out.set(real, describe(real));
    } catch {
      /* removed meanwhile */
    }
  };
  const walk = (dir: string) => {
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch {
      return; // Recorded as unreadable by `describe`.
    }
    const modulesDir = path.basename(dir) === NODE_MODULES;
    const underModules = dir.split(path.sep).includes(NODE_MODULES);

    for (const name of entries) {
      const abs = path.join(dir, name);

      if (modulesDir && name.startsWith('.') && name !== '.bin') {
        skipped.add(abs);
        continue;
      }

      // In a package linked from outside any node_modules (`link:../lib`, a workspace package), hidden entries are
      // repository and tool state (`.git`, `.turbo`, `.cache`) that git and build tools update, not package code.
      if (!underModules && name.startsWith('.')) continue;
      const entry = describe(abs);
      out.set(abs, entry);

      if (out.size > maxEntries)
        throw new Error(
          `the installed dependencies have more than ${maxEntries} entries (reached through ${dir}), too many to check for changes`,
        );

      // A tree of its own (queued or walked already) inside this one is walked once, as itself.
      if (entry.startsWith('dir|')) {
        if (!covered.includes(abs)) walk(abs);
      } else if (entry.startsWith('link|')) links.push(abs);
    }
  };

  cover(realpathSync(modules));

  // Walk every queued tree before following links, so a link into a hidden store is seen after the store was skipped.
  for (;;) {
    const tree = queue.shift();

    if (tree !== undefined) {
      out.set(tree, describe(tree));
      walk(tree);
      continue;
    }
    const link = links.shift();

    if (link === undefined) break;
    follow(link);
  }

  return out;
}

/**
 * The git repository a path is in: the nearest directory above it with `.git`, below the user's home directory. The
 * home directory and its parents never count: a dotfiles repository there would make the whole home one repository.
 */
function repositoryRoot(start: string): string | null {
  let home: string;

  try {
    home = realpathSync(homedir());
  } catch {
    home = path.resolve(homedir());
  }

  for (let dir = start; !inside(home, dir); dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;

    if (path.dirname(dir) === dir) return null;
  }

  return null;
}

/** Whether git ignores `target` in `repository`; null when git cannot tell (not a repository, git missing). */
function gitIgnores(repository: string, target: string, project: string): boolean | null {
  // Through core's git options: `check-ignore` reads the index, which would start a file system monitor the
  // repository configures (core.fsmonitor), and this repository is not even the project's.
  const run = gitRun(repository, ['check-ignore', '-q', '--', target], {
    timeoutMs: 10_000,
    excluded: [project],
  });

  return run.status === 0 ? true : run.status === 1 ? false : null;
}

/**
 * Whether a link found outside node_modules leads to dependency code worth walking: into a node_modules directory, to
 * a package (a directory with a package.json), or to source git does not ignore elsewhere in the git repository the link is in (a
 * workspace package linking its sources from a sibling directory, `shared/src -> ../source`). A target in the same
 * repository is not followed when git ignores it (`logs -> ../logs`, build caches: they change on their own and are
 * not code the package ships) or when it holds the linking package itself (the repository root: walking it would walk
 * the whole repository). Outside a git repository, or when git cannot tell, it is not followed either.
 */
function dependencyTarget(link: string, real: string, project: string): boolean {
  if (real.split(path.sep).includes(NODE_MODULES) || existsSync(path.join(real, 'package.json'))) return true;
  const repository = repositoryRoot(path.dirname(link));

  if (repository === null || !inside(real, repository) || inside(path.dirname(link), real)) return false;

  return gitIgnores(repository, real, project) === false;
}

/**
 * Whether two descriptions of an entry are the same. A change of the change time together with the link count alone
 * is not a change: a package manager that hard-links files of a shared content-addressed store (pnpm on Linux, bun)
 * changes both when another project links the same file. Rewriting the file in place also changes its size or
 * modification time unless those are restored, and restoring them while keeping an extra hard link elsewhere is the
 * one way past this check; it is a safety net, not a security boundary.
 */
function sameEntry(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.split('|');
  const y = b.split('|');

  if (x[0] === 'dir' || x.length !== 8 || y.length !== 8) return false;

  return x.slice(0, 6).join('|') === y.slice(0, 6).join('|') && x[7] !== y[7];
}

/** Paths added, removed or changed between two dependency snapshots, sorted. */
export function diffDependencies(before: DependencySnapshot, after: DependencySnapshot): string[] {
  const changed = new Set<string>();

  for (const [p, v] of before) {
    const now = after.get(p);

    if (now === undefined || !sameEntry(v, now)) changed.add(p);
  }

  for (const p of after.keys()) if (!before.has(p)) changed.add(p);

  return [...changed].sort();
}
