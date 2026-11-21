import {
  type BundledTools,
  type DoctorReport,
  detectProject as detectProjectWith,
  type InitOptions,
  type InitResult,
  initProject as initProjectWith,
  type ProjectInfo,
  runDoctor as runDoctorWith,
  selectTestRunner,
  type TestRunnerProvider,
  VeritasConfig,
} from '@under18dev/veritas-core';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';

/** The test runner providers this installation brings. */
export const TEST_RUNNERS: readonly TestRunnerProvider[] = [vitestTestRunner];

const DEFAULT_FRAMEWORK = VeritasConfig.parse({}).analysis.testFramework;

/**
 * The provider of the test runner a configuration names (`analysis.testFramework`), or of the default one when there
 * is no configuration yet (`init`, or `doctor` before `init`). Every runner-specific step goes through this provider.
 */
export function testRunnerFor(
  config: Pick<VeritasConfig, 'analysis'> | null | undefined,
): TestRunnerProvider {
  return selectTestRunner(TEST_RUNNERS, config?.analysis?.testFramework ?? DEFAULT_FRAMEWORK);
}

/** Inspect a project without running any of its code, for the test runner `config` names (the default without). */
export function detectProject(root: string, config: VeritasConfig | null = null): ProjectInfo {
  return detectProjectWith(root, testRunnerFor(config));
}

/** Detect the project and write `.veritas/config.json`. Never overwrites without `force`. */
export function initProject(root: string, options: InitOptions = {}): InitResult {
  return initProjectWith(root, testRunnerFor(options.config), options);
}

/**
 * Check capabilities and features; pass `null` as `config` to check without a configuration. Pass `bundledTools()`
 * as `bundled` so that the tools installed with Veritas are found, as `veritas doctor` does.
 */
export function runDoctor(
  root: string,
  config: VeritasConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  bundled: BundledTools = {},
): Promise<DoctorReport> {
  return runDoctorWith(root, config, testRunnerFor(config), env, bundled);
}
