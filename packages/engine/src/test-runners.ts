import {
  type BundledTools,
  chooseTestRunner,
  type DoctorReport,
  detectProject as detectProjectWith,
  type InitOptions,
  type InitResult,
  initProject as initProjectWith,
  type ProjectInfo,
  readPackageJson,
  runDoctor as runDoctorWith,
  selectTestRunner,
  type TestRunnerChoice,
  type TestRunnerProvider,
  VeritasConfig,
} from '@under18dev/veritas-core';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';

/** The test runner providers this installation brings; the first is the default. */
export const TEST_RUNNERS: readonly TestRunnerProvider[] = [vitestTestRunner];

const DEFAULT_FRAMEWORK = VeritasConfig.parse({}).analysis.testFramework;

/**
 * The provider of the test runner a configuration names (`analysis.testFramework`), or of the default one when there
 * is no configuration. A configuration without `testFramework` names the default (Vitest). Every runner-specific step
 * of a run goes through this provider.
 */
export function testRunnerFor(
  config: Pick<VeritasConfig, 'analysis'> | null | undefined,
): TestRunnerProvider {
  return selectTestRunner(TEST_RUNNERS, config?.analysis?.testFramework ?? DEFAULT_FRAMEWORK);
}

/** The test runner the project at `root` uses, found from its files without running anything (see `chooseTestRunner`). */
export function detectTestRunner(root: string): TestRunnerChoice {
  return chooseTestRunner(TEST_RUNNERS, root, readPackageJson(root));
}

/**
 * The provider for a project: the one `config` names, or without a configuration (before `init`) the one detection
 * finds in the project.
 */
export function testRunnerForProject(
  root: string,
  config: VeritasConfig | null | undefined,
): TestRunnerProvider {
  return config ? testRunnerFor(config) : detectTestRunner(root).provider;
}

/** Inspect a project without running any of its code, for the test runner `config` names (the detected one without). */
export function detectProject(root: string, config: VeritasConfig | null = null): ProjectInfo {
  return detectProjectWith(root, testRunnerForProject(root, config));
}

/**
 * Detect the project and write `.veritas/config.json`. Never overwrites without `force`. The test runner is the one
 * `options.config` names, or the one detection finds; the result says which and why.
 */
export function initProject(root: string, options: InitOptions = {}): InitResult {
  const detected = detectTestRunner(root);
  // A configuration that names the detected runner (the one `init` proposed) keeps detection's reason.
  const selection =
    options.config && options.testRunnerConfirmed
      ? {
          provider: testRunnerFor(options.config),
          reason: `more than one test runner was found; ${testRunnerFor(options.config).displayName} was chosen when asked`,
          ambiguous: false,
        }
      : options.config && options.config.analysis.testFramework !== detected.provider.name
        ? {
            provider: testRunnerFor(options.config),
            reason: `analysis.testFramework is "${options.config.analysis.testFramework}" in the given configuration`,
            ambiguous: false,
          }
        : detected;

  return initProjectWith(root, selection, options);
}

/**
 * Check capabilities and features; pass `null` as `config` to check without a configuration (for the detected test
 * runner). Pass `bundledTools()` as `bundled` so that the tools installed with Veritas are found, as `veritas doctor`
 * does.
 */
export function runDoctor(
  root: string,
  config: VeritasConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  bundled: BundledTools = {},
): Promise<DoctorReport> {
  return runDoctorWith(root, config, testRunnerForProject(root, config), env, bundled);
}
