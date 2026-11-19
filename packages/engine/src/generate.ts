import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSymbolId, resolveInsideRoot, VeritasError } from '@under18dev/veritas-core';
import { generateVitestFile } from '@under18dev/veritas-property-testing';
import { defaultSeed, openProject } from './project.js';
import { listProperties } from './spec.js';

export interface GeneratedTest {
  propertyId: string;
  /** Project-relative path the file is written to (under .veritas/generated-tests, never into the test suite). */
  file: string;
  content: string;
  experimental: boolean;
}

/**
 * Generate Vitest + fast-check test files for formalized properties of the latest run. Files are proposals:
 * they are written under `.veritas/generated-tests/` and never added to the project's test suite here.
 */
export async function generateTests(
  root: string,
  options: { propertyId?: string; dryRun?: boolean; force?: boolean; allowCodeConfig?: boolean } = {},
): Promise<GeneratedTest[]> {
  const { config } = await openProject(root, { allowCodeConfig: options.allowCodeConfig });
  const { properties } = listProperties(root);
  const selected = properties.filter(
    (p) => p.ir && (options.propertyId ? p.id === options.propertyId : true),
  );
  if (options.propertyId && selected.length === 0) {
    throw new VeritasError(
      'user',
      'PROPERTY_NOT_FORMALIZED',
      `property ${options.propertyId} has no formal model`,
      'run `veritas spec show <id>` to see why',
    );
  }
  const outDir = path.join('.veritas', 'generated-tests');
  const generated = selected.map((p) => {
    const { file, name } = parseSymbolId(p.targetSymbols[0] as string);
    const target = path.posix.join(outDir.split(path.sep).join('/'), `${p.id}.test.ts`);
    const importPath = path.posix.relative(path.posix.dirname(target), file).replace(/^(?!\.)/, './');
    const seed = config.pbt.seed ?? defaultSeed(p.id);
    const experimental = p.status !== 'accepted';
    const content = generateVitestFile({
      propertyId: p.id,
      ir: p.ir as NonNullable<typeof p.ir>,
      bindings: [{ modelName: name, importPath, exportName: name }],
      seed,
      numRuns: config.pbt.numRuns,
      experimental,
    });
    return { propertyId: p.id, file: target, content, experimental };
  });
  if (options.dryRun) return generated;
  // A file someone changed after it was generated is never replaced without --force; nothing is written then.
  const changed = generated.filter((g) => {
    const abs = resolveInsideRoot(root, g.file);
    return existsSync(abs) && readFileSync(abs, 'utf8') !== g.content;
  });
  if (changed.length > 0 && !options.force) {
    throw new VeritasError(
      'user',
      'GENERATED_TEST_CHANGED',
      `generated test file(s) differ from what would be written: ${changed.map((g) => g.file).join(', ')}`,
      'keep your changes elsewhere, or rerun with --force to replace them',
    );
  }
  for (const g of generated) {
    const abs = resolveInsideRoot(root, g.file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, g.content);
  }
  return generated;
}
