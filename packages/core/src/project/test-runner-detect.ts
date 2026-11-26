import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TestFramework } from '../config/schema.js';
import {
  type PackageJson,
  selectTestRunner,
  type TestRunnerInstallation,
  type TestRunnerProvider,
} from '../test-runner.js';
import { resolvePackageVersion } from './detect.js';

/** Where a runner can show up in a project, for `detectInstallation`. */
export interface InstallationSignals {
  readonly name: TestFramework;
  readonly displayName: string;
  /** The runner's npm package. */
  readonly packageName: string;
  /** The runner's own config files at the root, in the order the runner looks for them. */
  readonly configFiles: readonly string[];
  /**
   * Files that may hold the runner's config but also serve other tools (`vite.config.ts`): reported as the config
   * file when the runner is declared or installed, never counted as evidence on their own.
   */
  readonly sharedConfigFiles?: readonly string[];
  /** A package.json key holding the runner's config (`"jest"`), if it has one. */
  readonly packageJsonKey?: string;
  /** Commands that run the runner in a script (`jest`, also matched as the path `node_modules/jest/bin/jest.js`). */
  readonly commands: readonly string[];
}

/** Commands that run another command given after them, with their own options before it. */
const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'cross-env', 'dotenv', 'env', 'time', 'nyc', 'c8']);
/** Package managers, which run a binary directly or after `exec`, `run`, `dlx` or `x`. */
const MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const MANAGER_VERBS = new Set(['exec', 'run', 'dlx', 'x']);

/** The base name of a command word without a script extension (`node_modules/.bin/jest.cmd` is `jest`). */
function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(?:[cm]?js|cmd|ps1)$/, '');
}

/**
 * The command one command segment (no `&&`, `;` or `|` in it) runs, after environment assignments, launchers such as
 * `npx` or `cross-env` and package managers' `exec` or `run`: its name and the words after it; null without one.
 */
function segmentCommand(words: string[]): { name: string; args: string[] } | null {
  let i = 0;
  const skipOptions = () => {
    while (i < words.length && (words[i] as string).startsWith('-')) i++;
  };

  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++;
    const word = words[i];

    if (word === undefined) return null;
    const name = commandName(word);
    i++;

    if (LAUNCHERS.has(name)) {
      skipOptions();
      continue;
    }

    if (MANAGERS.has(name)) {
      if (MANAGER_VERBS.has(words[i] ?? '')) i++;
      skipOptions();
      continue;
    }

    return { name, args: words.slice(i) };
  }
}

/** Whether one command segment runs one of `wanted`, also as the file `node` runs. */
function segmentRuns(words: string[], wanted: ReadonlySet<string>): boolean {
  const command = segmentCommand(words);

  if (command === null) return false;

  if (command.name === 'node') {
    const file = command.args.find((arg) => !arg.startsWith('-'));

    return file !== undefined && wanted.has(commandName(file));
  }

  return wanted.has(command.name);
}

/** The words of each command segment of a script (split at `&&`, `||`, `;`, `|`), with quoted text emptied. */
function scriptSegments(script: string): string[][] {
  // Quoted text is an argument of its segment, never the command.
  const unquoted = script.replace(/"[^"]*"|'[^']*'/g, '""');

  return unquoted.split(/&&|\|\||[;|&]/).map((segment) => segment.trim().split(/\s+/).filter(Boolean));
}

/**
 * Whether a package.json script runs `node` with `flag` among its own options (`node --test`, `node --import tsx
 * --test test/`), through launchers as `scriptRuns` reads them. An option after the script file is the script's.
 */
export function scriptRunsNodeWith(script: unknown, flag: string): boolean {
  if (typeof script !== 'string') return false;

  return scriptSegments(script).some((words) => {
    const command = segmentCommand(words);

    if (command?.name !== 'node') return false;

    for (const [i, arg] of command.args.entries()) {
      if (arg === flag) return true;

      if (arg.startsWith('-')) continue;
      const previous = command.args[i - 1];

      // A word after an option written without `=` may be its value (`--import tsx`); any other is the script file.
      if (previous === undefined || !previous.startsWith('--') || previous.includes('=')) return false;
    }

    return false;
  });
}

/**
 * Whether a package.json script runs one of `commands` as a command: the first word of a command segment (after
 * `&&`, `||`, `;` or `|`), after environment assignments and launchers such as `npx`, `cross-env` or `pnpm exec`, or
 * the file `node` runs (`node --flag node_modules/jest/bin/jest.js`). A command named only as an argument
 * (`eslint --plugin=jest`) or in quotes (`echo "migrated from jest"`) does not count.
 */
export function scriptRuns(script: unknown, commands: readonly string[]): boolean {
  if (typeof script !== 'string' || commands.length === 0) return false;
  const wanted = new Set(commands);

  return scriptSegments(script).some((words) => segmentRuns(words, wanted));
}

/** Detect a runner from the usual signals: dependencies, `node_modules`, config files, package.json and scripts. */
export function detectInstallation(
  root: string,
  packageJson: PackageJson | null,
  signals: InstallationSignals,
): TestRunnerInstallation {
  const deps = {
    ...((packageJson?.dependencies as object | undefined) ?? {}),
    ...((packageJson?.devDependencies as object | undefined) ?? {}),
  };
  const declared = signals.packageName in deps;
  const installedVersion = resolvePackageVersion(root, signals.packageName);
  const present = (files: readonly string[] = []) =>
    files.find((f) => existsSync(path.join(root, f))) ?? null;
  const ownConfig = present(signals.configFiles);
  const sharedConfig = declared || installedVersion ? present(signals.sharedConfigFiles) : null;
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined;
  // The test script is evidence only for a runner the project also declares or installs: a script that runs a
  // runner the project does not have cannot be how its tests run.
  const testScript = (declared || installedVersion !== null) && scriptRuns(scripts?.test, signals.commands);
  const keyed =
    signals.packageJsonKey !== undefined &&
    packageJson !== null &&
    Object.hasOwn(packageJson, signals.packageJsonKey);
  const evidence = [
    ...(ownConfig ? [ownConfig] : []),
    ...(keyed ? [`a "${signals.packageJsonKey}" key in package.json`] : []),
    ...(testScript ? [`the test script runs ${signals.commands[0]}`] : []),
    ...(declared ? [`${signals.packageName} in package.json`] : []),
  ];
  const found = evidence.length > 0 ? evidence.join(', ') : 'nothing in package.json or config files';

  return {
    name: signals.name,
    declared,
    installedVersion,
    configFile: ownConfig ?? sharedConfig,
    testScript,
    evidence,
    reason: `${signals.displayName}: ${found}; ${installedVersion ? `${signals.packageName} ${installedVersion} is installed` : `${signals.packageName} is not installed`}`,
  };
}

/** Which runner a project uses, and why, as `chooseTestRunner` decides it. */
export interface TestRunnerChoice {
  provider: TestRunnerProvider;
  /** Why this runner was chosen, for people. */
  reason: string;
  /**
   * More than one runner was equally likely (see `chooseTestRunner`): the order of the providers decided, and the
   * user should confirm or set `analysis.testFramework`.
   */
  ambiguous: boolean;
  /** The equally likely runners when the choice is ambiguous, in the providers' order; otherwise the chosen one. */
  candidates: TestRunnerProvider[];
  /** What detection found for every available runner, in the providers' order. */
  installations: TestRunnerInstallation[];
}

interface Entry {
  provider: TestRunnerProvider;
  installation: TestRunnerInstallation;
}

/**
 * Installed in a way that tells something about the project: a runner built into Node.js (`node --test`) is always
 * there, so only evidence that the project uses it counts.
 */
const installed = ({ provider, installation }: Entry) =>
  installation.installedVersion !== null && (!provider.detection.builtIn || installation.evidence.length > 0);

const shows = (entry: Entry) => entry.installation.evidence.length > 0 || installed(entry);

function describe(entry: Entry): string {
  const { installation } = entry;

  if (installation.evidence.length === 0)
    return installed(entry) ? 'installed, with nothing in package.json or config files' : 'nothing';

  return `${installation.evidence.join(', ')}${installation.installedVersion ? '' : ', but not installed'}`;
}

/**
 * The runner a project uses, from what detection finds, without running anything. Runners the project can run come
 * first: installed ones, then (when none is installed) declared ones, then those only a config file or a package.json
 * key points at. Among the runners of the first group that has any, the one the `test` script runs wins, then the
 * only one with evidence (config file, package.json key or dependency); if that does not decide, the first in
 * `providers` is chosen and the choice is marked ambiguous. So a runner that is neither declared nor installed is
 * never chosen over one that is installed. A runner built into Node.js counts as installed only with evidence that the
 * project uses it. With nothing found at all the first provider is returned, so that its
 * NOT_FOUND error says what is missing.
 */
export function chooseTestRunner(
  providers: readonly TestRunnerProvider[],
  root: string,
  packageJson: PackageJson | null,
): TestRunnerChoice {
  const first = providers[0] ?? selectTestRunner(providers, 'vitest');
  const installations = providers.map((provider) => provider.detection.detect(root, packageJson));
  const all: Entry[] = providers.map((provider, index) => ({
    provider,
    installation: installations[index] as TestRunnerInstallation,
  }));
  const groups: [string, Entry[]][] = [
    ['installed', all.filter(installed)],
    ['declared in package.json', all.filter(({ installation }) => installation.declared)],
    ['configured', all.filter(({ installation }) => installation.evidence.length > 0)],
  ];
  const [state, group] = groups.find(([, entries]) => entries.length > 0) ?? ['', []];
  const others = (chosen: Entry) =>
    all
      .filter((entry) => entry !== chosen && shows(entry))
      .map((entry) => `; ${entry.provider.displayName} also shows up (${describe(entry)})`)
      .join('');
  const decided = (chosen: Entry, why: string): TestRunnerChoice => ({
    provider: chosen.provider,
    reason: `${why}${others(chosen)}`,
    ambiguous: false,
    candidates: [chosen.provider],
    installations,
  });
  const [only, second] = group;

  if (!only) {
    return {
      provider: first,
      reason: `no supported test runner (${providers.map((p) => p.displayName).join(', ')}) was found`,
      ambiguous: false,
      candidates: [first],
      installations,
    };
  }

  if (!second) {
    const alone = all.every((entry) => entry === only || !shows(entry));

    return decided(
      only,
      `${only.provider.displayName} is the only test runner ${alone ? 'found' : state} (${describe(only)})`,
    );
  }
  const names = group.map(({ provider }) => provider.displayName).join(' and ');
  const scripted = group.filter(({ installation }) => installation.testScript);

  if (scripted.length === 1 && scripted[0])
    return decided(
      scripted[0],
      `${names} are ${state}; the test script runs ${scripted[0].provider.displayName}`,
    );
  const withEvidence = group.filter(({ installation }) => installation.evidence.length > 0);

  if (withEvidence.length === 1 && withEvidence[0])
    return decided(
      withEvidence[0],
      `${names} are ${state}; only ${withEvidence[0].provider.displayName} has a config file or a dependency (${describe(withEvidence[0])})`,
    );

  return {
    provider: only.provider,
    reason: `${names} are ${state} and nothing tells them apart, so ${only.provider.displayName} was chosen as the default; set analysis.testFramework if the project runs its tests with another`,
    ambiguous: true,
    candidates: group.map(({ provider }) => provider),
    installations,
  };
}
