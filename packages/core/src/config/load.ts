import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { VeritasError } from '../exit-codes.js';
import { hashValue } from '../hash.js';
import { VeritasConfig } from './schema.js';

export const CONFIG_DIR = '.veritas';
export const JSON_CONFIG = path.join(CONFIG_DIR, 'config.json');
export const CODE_CONFIGS = ['veritas.config.ts', 'veritas.config.mjs', 'veritas.config.js'];

export interface LoadedConfig {
  config: VeritasConfig;
  file: string | null;
  hash: string;
}

export function formatIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`);
}

export function parseConfig(input: unknown, file: string | null): VeritasConfig {
  const result = VeritasConfig.safeParse(input);
  if (!result.success) {
    const lines = formatIssues(result.error.issues);
    throw new VeritasError(
      'user',
      'CONFIG_INVALID',
      `invalid configuration${file ? ` in ${file}` : ''}:\n  ${lines.join('\n  ')}`,
      'fix the listed fields or regenerate with `veritas init --force`',
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * Load configuration from `.veritas/config.json` or `veritas.config.{ts,mjs,js}`.
 * Code configs execute project code, so they are only loaded when `allowCodeConfig` is set.
 */
export async function loadConfig(
  root: string,
  options: { allowCodeConfig?: boolean } = {},
): Promise<LoadedConfig> {
  const jsonPath = path.join(root, JSON_CONFIG);
  const codePath = CODE_CONFIGS.map((f) => path.join(root, f)).find((f) => existsSync(f));
  if (existsSync(jsonPath) && codePath) {
    throw new VeritasError(
      'user',
      'CONFIG_AMBIGUOUS',
      `both ${JSON_CONFIG} and ${path.basename(codePath)} exist`,
      'keep only one configuration file',
    );
  }
  if (existsSync(jsonPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (error) {
      throw new VeritasError(
        'user',
        'CONFIG_PARSE',
        `cannot parse ${JSON_CONFIG}: ${(error as Error).message}`,
      );
    }
    const config = parseConfig(raw, JSON_CONFIG);
    return { config, file: jsonPath, hash: hashValue(config) };
  }
  if (codePath) {
    if (!options.allowCodeConfig) {
      throw new VeritasError(
        'user',
        'CONFIG_CODE_NOT_ALLOWED',
        `${path.basename(codePath)} executes code and is not loaded in this context`,
        `pass --allow-code-config, or use ${JSON_CONFIG}`,
      );
    }
    const mod = (await import(pathToFileURL(codePath).href)) as { default?: unknown };
    const config = parseConfig(mod.default, path.basename(codePath));
    return { config, file: codePath, hash: hashValue(config) };
  }
  throw new VeritasError('user', 'CONFIG_MISSING', `no configuration found in ${root}`, 'run `veritas init`');
}
