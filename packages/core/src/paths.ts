import { realpathSync } from 'node:fs';
import path from 'node:path';
import { VeritasError } from './exit-codes.js';

/**
 * Resolve `candidate` inside `root`, rejecting traversal (`..`), absolute escapes and symlinks
 * that point outside the root. The returned path is absolute.
 */
export function resolveInsideRoot(root: string, candidate: string): string {
  if (candidate.includes('\0')) {
    throw new VeritasError('user', 'PATH_INVALID', 'path contains a NUL byte');
  }
  const realRoot = realpathSync(root);
  const resolved = path.resolve(realRoot, candidate);
  assertContained(realRoot, resolved, candidate);
  const real = realpathOfExistingPrefix(resolved);
  assertContained(realRoot, real, candidate);
  return resolved;
}

function assertContained(root: string, target: string, original: string): void {
  const rel = path.relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new VeritasError('user', 'PATH_OUTSIDE_ROOT', `path escapes the project root: ${original}`);
}

/** realpath of the longest existing prefix, so not-yet-created files under a symlinked dir are caught. */
function realpathOfExistingPrefix(target: string): string {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Repository-relative POSIX path for reports and IDs, independent of the OS separator. */
export function toPosixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
