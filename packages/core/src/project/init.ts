import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODE_CONFIGS, JSON_CONFIG } from '../config/load.js';
import { VeritasConfig as ConfigSchema, type TestFramework, type VeritasConfig } from '../config/schema.js';
import { VeritasError } from '../exit-codes.js';
import { resolveInsideRoot } from '../paths.js';
import type { TestRunnerProvider } from '../test-runner.js';
import { detectProject, type ProjectInfo } from './detect.js';

export interface InitOptions {
  force?: boolean;
  /** Write nothing; return the config that would be written. */
  dryRun?: boolean;
  /** Write this configuration (validated) instead of the proposed one, e.g. after the user's answers. */
  config?: VeritasConfig;
  /** The user picked `config`'s test runner when asked (detection found several); it is no longer ambiguous. */
  testRunnerConfirmed?: boolean;
}

/** The test runner `init` configures, and why. */
export interface TestRunnerSelection {
  provider: TestRunnerProvider;
  /** Why this runner: what detection found, or that the given configuration names it. */
  reason: string;
  /** Detection found several runners and could not tell which one the project uses (see `chooseTestRunner`). */
  ambiguous: boolean;
}

export interface InitResult {
  project: ProjectInfo;
  /** The test runner written to `analysis.testFramework`, and why it was chosen. */
  testRunner: { name: TestFramework; reason: string; ambiguous: boolean };
  config: VeritasConfig;
  file: string;
  written: boolean;
  nextSteps: string[];
}

export function proposeConfig(project: ProjectInfo): VeritasConfig {
  return ConfigSchema.parse({
    $schema: 'https://veritas.invalid/schemas/config.json',
    project: { packageManager: project.packageManager, tsconfig: project.tsconfig },
    analysis: {
      include: project.sourceGlobs,
      testInclude: project.testGlobs,
      testFramework: project.testRunner.name,
    },
  });
}

/** Detect the project and write `.veritas/config.json`. Never overwrites without `force`. */
export function initProject(
  root: string,
  selection: TestRunnerSelection,
  options: InitOptions = {},
): InitResult {
  const runner = selection.provider;
  const project = detectProject(root, runner);

  if (!project.hasPackageJson) {
    throw new VeritasError(
      'user',
      'NO_PACKAGE_JSON',
      `no package.json in ${root}`,
      'run veritas in a Node.js project root',
    );
  }

  if (!project.testRunner.declared && !project.testRunner.installedVersion) {
    throw new VeritasError(
      'user',
      `${runner.name.toUpperCase()}_NOT_FOUND`,
      `${runner.displayName} is not declared in package.json and not installed; ${selection.reason}`,
      `install it with \`${project.packageManager === 'unknown' ? 'npm' : project.packageManager} add -D ${runner.detection.packageName}\` and rerun \`veritas init\``,
    );
  }
  // Refuse a `.veritas` (or config.json) symlink that points outside the project instead of writing through it.
  const file = resolveInsideRoot(root, JSON_CONFIG);
  const codeConfigs = CODE_CONFIGS.filter((f) => existsSync(path.join(root, f)));

  if (codeConfigs.length > 0) {
    throw new VeritasError(
      'user',
      'CODE_CONFIG_EXISTS',
      `a code configuration already exists: ${codeConfigs.join(', ')}; init only writes ${JSON_CONFIG}`,
      'keep using the existing file, or remove it yourself before running `veritas init`',
    );
  }
  const existing = [file, ...CODE_CONFIGS.map((f) => path.join(root, f))].filter((f) => existsSync(f));

  if (existing.length > 0 && !options.force) {
    throw new VeritasError(
      'user',
      'CONFIG_EXISTS',
      `configuration already exists: ${existing.map((f) => path.relative(root, f)).join(', ')}`,
      'pass --force to overwrite it',
    );
  }
  const config = options.config ? ConfigSchema.parse(options.config) : proposeConfig(project);
  const nextSteps = ['veritas doctor', 'veritas discover --offline', 'veritas run --profile quick --offline'];

  if (!project.testRunner.installedVersion)
    nextSteps.unshift(`install dependencies so ${runner.displayName} can be resolved`);

  if (!project.git) nextSteps.push('initialise git to enable --since and reproducible run metadata');

  const testRunner = { name: runner.name, reason: selection.reason, ambiguous: selection.ambiguous };

  if (selection.ambiguous)
    nextSteps.unshift(
      `check analysis.testFramework in ${JSON_CONFIG}: ${runner.displayName} was chosen, but more than one test runner was found`,
    );

  if (options.dryRun) return { project, testRunner, config, file, written: false, nextSteps };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(resolveInsideRoot(root, JSON_CONFIG), `${JSON.stringify(config, null, 2)}\n`);

  return { project, testRunner, config, file, written: true, nextSteps };
}
