import { lstatSync } from 'node:fs';
import path from 'node:path';
import { resolveInsideRoot } from '@under18dev/veritas-core';
import type { PatchFile } from './schema.js';

export interface PatchRules {
  testInclude: string[];
  maxPatchFiles: number;
}

/** Directories that never receive patch files. */
const FORBIDDEN_DIRS = new Set(['node_modules', '.git', '.veritas', '.mutator']);

/** Focus, skip and todo markers in Vitest/Jest style, including the `x`/`f` aliases. */
const DISABLING = [
  /\.\s*(?:skip|only|todo|skipIf|runIf)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe|ftest)\s*\(/,
];

function isMarkdownOrReadme(file: string): boolean {
  const base = path.posix.basename(file).toLowerCase();
  return base.startsWith('readme') || /\.(md|mdx|markdown|rst|txt)$/.test(base);
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Mechanical safety check of a patch before anything is written, even into the isolated workspace.
 * Returns the list of violations; an empty list means the patch only adds new test files inside `root`.
 */
export function validatePatch(root: string, files: PatchFile[], rules: PatchRules): string[] {
  const problems: string[] = [];
  if (files.length === 0) problems.push('the patch contains no file');
  if (files.length > rules.maxPatchFiles) {
    problems.push(`the patch has ${files.length} files, more than maxPatchFiles (${rules.maxPatchFiles})`);
  }
  const seen = new Set<string>();
  for (const file of files) {
    const p = file.path;
    const label = JSON.stringify(p);
    if (file.operation !== 'add') {
      problems.push(
        `${label}: operation "${file.operation}" is not allowed; only new test files may be added`,
      );
    }
    if (
      p === '' ||
      p.includes('\0') ||
      p.includes('\\') ||
      path.posix.isAbsolute(p) ||
      /^[A-Za-z]:/.test(p) ||
      p.split('/').some((s) => s === '..' || s === '.' || s === '')
    ) {
      problems.push(`${label}: not a normalized relative path inside the project`);
      continue;
    }
    if (seen.has(p)) problems.push(`${label}: listed more than once`);
    seen.add(p);
    if (p.split('/').some((s) => FORBIDDEN_DIRS.has(s))) {
      problems.push(`${label}: inside a directory that is never patched`);
    }
    if (isMarkdownOrReadme(p)) problems.push(`${label}: documentation and README files are never changed`);
    if (!rules.testInclude.some((glob) => path.posix.matchesGlob(p, glob))) {
      problems.push(`${label}: not a test file (does not match analysis.testInclude)`);
    }
    let absolute: string;
    try {
      absolute = resolveInsideRoot(root, p);
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`);
      continue;
    }
    if (exists(absolute)) problems.push(`${label}: already exists; existing files are never edited`);
    for (const pattern of DISABLING) {
      if (pattern.test(file.content)) {
        problems.push(`${label}: contains a skip/only/todo marker (${pattern.source})`);
        break;
      }
    }
  }
  return problems;
}
