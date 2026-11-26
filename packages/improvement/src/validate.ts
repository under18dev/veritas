import { lstatSync } from 'node:fs';
import path from 'node:path';
import { resolveInsideRoot } from '@under18dev/veritas-core';
import ts from 'typescript';
import type { PatchFile } from './schema.js';

export interface PatchRules {
  testInclude: string[];
  maxPatchFiles: number;
}

/** Directories that never receive patch files. */
const FORBIDDEN_DIRS = new Set(['node_modules', '.git', '.veritas', '.mutator']);

/**
 * Focus, skip and todo markers in Vitest/Jest style, including the `x`/`f` aliases, and as test options (Vitest's and
 * Node's `{ skip: true }`, Node's `{ todo: 'reason' }`).
 */
const DISABLING = [
  /\.\s*(?:skip|only|todo|skipIf|runIf)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe|ftest)\s*\(/,
  /[{,]\s*['"]?(?:skip|only|todo)['"]?\s*:/,
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

    const pattern = DISABLING.find((candidate) => candidate.test(file.content));
    const marker = pattern ? pattern.source : disablingSyntax(p, file.content);

    if (marker !== null) problems.push(`${label}: contains a skip/only/todo marker (${marker})`);
  }

  return problems;
}

/** Members and option keys that skip, focus or mark a test todo (`it.skip`, `{ only: true }`). */
const DISABLING_NAMES = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf']);
/** Registration functions whose name skips or focuses (`xit`, `fdescribe`). */
const DISABLING_FUNCTIONS = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe', 'ftest']);

/** The text of a property name or element access written as a literal (`skip`, `'skip'`, `['skip']`), if any. */
function literalName(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;

  if (ts.isComputedPropertyName(name))
    return ts.isStringLiteralLike(name.expression) ? name.expression.text : '<computed>';

  return undefined;
}

/**
 * A skip, focus or todo marker the regular expressions miss, found in the syntax tree of a test file: a member read
 * through brackets (`it['skip']`), an options key written as a shorthand (`{ skip }`), a string or a computed key
 * (`{ ['only']: true }`, `{ [key]: true }`), or a spread that may bring one in (`{ ...options }`). Null when none.
 */
function disablingSyntax(file: string, content: string): string | null {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;

    if (ts.isElementAccessExpression(node)) {
      const name = literalName(node.argumentExpression);

      if (name !== undefined && DISABLING_NAMES.has(name)) found = `[${JSON.stringify(name)}]`;
    } else if (ts.isPropertyAccessExpression(node) && DISABLING_NAMES.has(node.name.text)) {
      found = `.${node.name.text}`;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (DISABLING_FUNCTIONS.has(node.expression.text)) found = `${node.expression.text}(`;
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          found = '{ ...spread }';
          break;
        }
        const name = literalName(property.name);

        if (name === '<computed>' || (name !== undefined && DISABLING_NAMES.has(name))) {
          found = `{ ${name === '<computed>' ? '[computed]' : name} }`;
          break;
        }
      }
    }

    if (found === null) ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}
