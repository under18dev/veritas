import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  hasFileNamed,
  importsModule,
  type PackageJson,
  scriptRunsNodeWith,
  type TestRunnerInstallation,
} from '@under18dev/veritas-core';

/**
 * Test runners whose package in package.json shows that the project's tests run with them: a project that declares
 * one of them and has a file importing `node:test` is not taken for a `node --test` project on that file alone.
 */
export const OTHER_TEST_RUNNERS = [
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'tape',
  'jasmine',
  'uvu',
] as const;

/** Source files that may import `node:test`. */
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/** Files bigger than this are not read for an import of `node:test`. */
const MAX_BYTES = 512 * 1024;

/** The package.json scripts that run `node --test`, by name, the `test` script first. */
function nodeTestScripts(packageJson: PackageJson | null): string[] {
  const scripts = packageJson?.scripts;

  if (!scripts || typeof scripts !== 'object') return [];

  return Object.entries(scripts as Record<string, unknown>)
    .filter(([, script]) => scriptRunsNodeWith(script, '--test'))
    .map(([name]) => name)
    .sort((a, b) => (a === 'test' ? -1 : b === 'test' ? 1 : a.localeCompare(b)));
}

/** The other test runners package.json declares (dependencies or devDependencies). */
function declaredOtherRunners(packageJson: PackageJson | null): string[] {
  const deps = {
    ...((packageJson?.dependencies as object | undefined) ?? {}),
    ...((packageJson?.devDependencies as object | undefined) ?? {}),
  };

  return OTHER_TEST_RUNNERS.filter((name) => name in deps);
}

/** Whether a source file of the project (outside `node_modules`, `dist`, `.git`, `.veritas`) imports `node:test`. */
function importsNodeTest(root: string): boolean {
  return hasFileNamed(root, (name, parent) => {
    if (!SOURCE.test(name)) return false;

    try {
      const text = readFileSync(path.join(parent, name), 'utf8');

      return text.length <= MAX_BYTES && importsModule(text, ['node:test']);
    } catch {
      return false;
    }
  });
}

/**
 * How a project uses Node's built-in test runner, without running anything. It is always installed (it is the
 * Node.js that runs Veritas), so what counts is evidence: a package.json script that runs `node --test`, or, when
 * package.json declares no other test runner, a file that imports `node:test`.
 */
export function detectNodeTest(root: string, packageJson: PackageJson | null): TestRunnerInstallation {
  const scripts = nodeTestScripts(packageJson);
  const others = declaredOtherRunners(packageJson);
  const imports = others.length === 0 && importsNodeTest(root);
  const testScript = scripts.includes('test');
  const evidence = [
    ...scripts.map((name) =>
      name === 'test' ? 'the test script runs node --test' : `the "${name}" script runs node --test`,
    ),
    ...(imports ? ['a file imports node:test'] : []),
  ];
  const version = process.versions.node;
  const found =
    evidence.length > 0
      ? evidence.join(', ')
      : others.length > 0
        ? `no script runs node --test, and package.json declares ${others.join(', ')}`
        : 'no script runs node --test and no file imports node:test';

  return {
    name: 'node_test',
    declared: false,
    installedVersion: version,
    configFile: null,
    testScript,
    evidence,
    importsOnly: imports && scripts.length === 0,
    reason: `Node.js test runner: ${found}; built into Node.js ${version}`,
  };
}
