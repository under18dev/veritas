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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a package.json script runs one of `commands`, as a word or as the path of the command's file. */
export function scriptRuns(script: unknown, commands: readonly string[]): boolean {
  if (typeof script !== 'string' || commands.length === 0) return false;
  const names = commands.map(escapeRegExp).join('|');

  return new RegExp(`(?:^|[\\s;&|()'"/=])(?:${names})(?:\\.[cm]?js)?(?=$|[\\s;&|()'"])`).test(script);
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
  const testScript = scriptRuns(scripts?.test, signals.commands);
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
   * More than one runner shows up and the test script does not tell them apart: the order of the providers decided,
   * and the user should confirm or set `analysis.testFramework`.
   */
  ambiguous: boolean;
  /** What detection found for every available runner, in the providers' order. */
  installations: TestRunnerInstallation[];
}

/**
 * The runner a project uses, from what detection finds, without running anything. Runners with evidence (a config
 * file, a package.json key or dependency, the test script) are candidates; without any, those installed are. Among
 * several, the one the `test` script runs wins; if that does not decide, the first in `providers` is chosen and the
 * choice is marked ambiguous. With no candidate at all the first provider is returned, so that its NOT_FOUND error
 * says what is missing.
 */
export function chooseTestRunner(
  providers: readonly TestRunnerProvider[],
  root: string,
  packageJson: PackageJson | null,
): TestRunnerChoice {
  const first = providers[0] ?? selectTestRunner(providers, 'vitest');
  const installations = providers.map((provider) => provider.detection.detect(root, packageJson));
  const all = providers.map((provider, index) => ({
    provider,
    installation: installations[index] as TestRunnerInstallation,
  }));
  const withEvidence = all.filter(({ installation }) => installation.evidence.length > 0);
  const candidates =
    withEvidence.length > 0 ? withEvidence : all.filter(({ installation }) => installation.installedVersion);
  const found = (installation: TestRunnerInstallation) =>
    installation.evidence.length > 0
      ? installation.evidence.join(', ')
      : `${installation.installedVersion ? 'installed' : 'not installed'}, with nothing in package.json or config files`;
  const [chosen, second] = candidates;

  if (!chosen) {
    return {
      provider: first,
      reason: `no supported test runner (${providers.map((p) => p.displayName).join(', ')}) was found`,
      ambiguous: false,
      installations,
    };
  }

  if (!second) {
    return {
      provider: chosen.provider,
      reason: `${chosen.provider.displayName} is the only test runner found (${found(chosen.installation)})`,
      ambiguous: false,
      installations,
    };
  }
  const names = candidates.map(({ provider }) => provider.displayName).join(' and ');
  const scripted = candidates.filter(({ installation }) => installation.testScript);

  if (scripted.length === 1 && scripted[0]) {
    return {
      provider: scripted[0].provider,
      reason: `${names} were found; the test script runs ${scripted[0].provider.displayName}`,
      ambiguous: false,
      installations,
    };
  }

  return {
    provider: chosen.provider,
    reason: `${names} were found and the test script does not tell them apart, so ${chosen.provider.displayName} was chosen as the default; set analysis.testFramework if the project runs its tests with another`,
    ambiguous: true,
    installations,
  };
}
