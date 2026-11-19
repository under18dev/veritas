import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveInsideRoot, type VeritasConfig, VeritasError } from '@veritas/core';

export interface SelectedFile {
  /** POSIX path relative to the project root. */
  path: string;
  absolute: string;
  content: string;
}

export interface Selection {
  files: SelectedFile[];
  diagnostics: { file: string; message: string }[];
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$|\.d\.[^.]+\.ts$/;
const ALWAYS_EXCLUDED = ['**/node_modules/**', '**/.veritas/**'];

const toPosix = (p: string) => p.split('\\').join('/');
const matchesAny = (file: string, patterns: readonly string[]) =>
  patterns.some((pattern) => path.posix.matchesGlob(file, pattern));

/**
 * Pick the source files to analyze: the explicit list, or `analysis.include` minus `analysis.exclude`.
 * Test files (`analysis.testInclude`) and declaration files are never source code, even when listed.
 */
export function selectFiles(root: string, config: VeritasConfig, explicit?: string[]): Selection {
  const diagnostics: Selection['diagnostics'] = [];
  const excluded = [...config.analysis.exclude, ...ALWAYS_EXCLUDED];
  let candidates: string[];
  if (explicit) {
    candidates = explicit.map((file) => {
      if (path.isAbsolute(file) || path.win32.isAbsolute(file)) {
        throw new VeritasError('user', 'PATH_NOT_RELATIVE', `expected a project-relative path: ${file}`);
      }
      return path.posix.normalize(toPosix(file));
    });
  } else {
    candidates = globSync(config.analysis.include, { cwd: root }).map(toPosix);
  }

  const seen = new Set<string>();
  const files: SelectedFile[] = [];
  for (const file of [...candidates].sort()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // Throws for traversal and symlinks escaping the root; explicit paths are user input.
    let absolute: string;
    try {
      absolute = resolveInsideRoot(root, file);
    } catch (error) {
      if (explicit) throw error;
      diagnostics.push({ file, message: `skipped: ${(error as Error).message}` });
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(file) || DECLARATION_FILE.test(file)) {
      if (explicit) diagnostics.push({ file, message: 'skipped: not a TypeScript/JavaScript source file' });
      continue;
    }
    if (matchesAny(file, config.analysis.testInclude)) {
      if (explicit) diagnostics.push({ file, message: 'skipped: test file, not analyzed as source' });
      continue;
    }
    if (matchesAny(file, excluded)) {
      if (explicit) diagnostics.push({ file, message: 'skipped: matches analysis.exclude' });
      continue;
    }
    let content: string;
    try {
      if (!statSync(absolute).isFile()) {
        diagnostics.push({ file, message: 'skipped: not a regular file' });
        continue;
      }
      content = readFileSync(absolute, 'utf8');
    } catch (error) {
      diagnostics.push({
        file,
        message: `skipped: cannot read file (${(error as NodeJS.ErrnoException).code})`,
      });
      continue;
    }
    files.push({ path: file, absolute, content });
  }
  return { files, diagnostics };
}
