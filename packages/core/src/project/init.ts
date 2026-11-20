import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODE_CONFIGS, JSON_CONFIG } from '../config/load.js';
import { VeritasConfig as ConfigSchema, type VeritasConfig } from '../config/schema.js';
import { VeritasError } from '../exit-codes.js';
import { resolveInsideRoot } from '../paths.js';
import { detectProject, type ProjectInfo } from './detect.js';

export interface InitOptions {
  force?: boolean;
  /** Write nothing; return the config that would be written. */
  dryRun?: boolean;
}

export interface InitResult {
  project: ProjectInfo;
  config: VeritasConfig;
  file: string;
  written: boolean;
  nextSteps: string[];
}

export function proposeConfig(project: ProjectInfo): VeritasConfig {
  return ConfigSchema.parse({
    $schema: 'https://veritas.invalid/schemas/config.json',
    project: { packageManager: project.packageManager, tsconfig: project.tsconfig },
    analysis: { include: project.sourceGlobs, testInclude: project.testGlobs },
  });
}

/** Detect the project and write `.veritas/config.json`. Never overwrites without `force`. */
export function initProject(root: string, options: InitOptions = {}): InitResult {
  const project = detectProject(root);

  if (!project.hasPackageJson) {
    throw new VeritasError(
      'user',
      'NO_PACKAGE_JSON',
      `no package.json in ${root}`,
      'run veritas in a Node.js project root',
    );
  }

  if (!project.vitest.declared && !project.vitest.installedVersion) {
    throw new VeritasError(
      'user',
      'VITEST_NOT_FOUND',
      'Vitest is not declared in package.json and not installed; Veritas currently supports Vitest projects only',
      `install it with \`${project.packageManager === 'unknown' ? 'npm' : project.packageManager} add -D vitest\` and rerun \`veritas init\``,
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
  const config = proposeConfig(project);
  const nextSteps = ['veritas doctor', 'veritas discover --offline', 'veritas run --profile quick --offline'];

  if (!project.vitest.installedVersion) nextSteps.unshift('install dependencies so Vitest can be resolved');

  if (!project.git) nextSteps.push('initialise git to enable --since and reproducible run metadata');

  if (options.dryRun) return { project, config, file, written: false, nextSteps };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(resolveInsideRoot(root, JSON_CONFIG), `${JSON.stringify(config, null, 2)}\n`);

  return { project, config, file, written: true, nextSteps };
}
