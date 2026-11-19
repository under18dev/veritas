import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FunctionModel, PropertyIR, Sort } from '@veritas/core';
import { type Binding, thresholdProperty, translateFunction } from '@veritas/formal-core';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DOMAIN = { min: '-10000', max: '10000' };

/** Copy discount-boundary outside the monorepo (without its node_modules). */
export function fixture(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-pbt-')));
  cpSync(path.join(REPO, 'fixtures/discount-boundary'), dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.mutator'),
  });
  return dir;
}

/** README rule "total >= 1000 receives 100, otherwise 0" over the model of `file#discountAmount`. */
export function discountProperty(root: string, file: string): { ir: PropertyIR; bindings: Binding[] } {
  const translated = translateFunction({
    file,
    source: readFileSync(path.join(root, file), 'utf8'),
    exportName: 'discountAmount',
    domain: DOMAIN,
  });
  if (translated.status !== 'translated')
    throw new Error(`translation failed: ${JSON.stringify(translated)}`);
  const ir = thresholdProperty({
    implementation: translated,
    param: 'total',
    operator: '>=',
    value: '1000',
    whenTrue: '100',
    whenFalse: '0',
    domain: DOMAIN,
  });
  return {
    ir,
    bindings: [
      { modelName: 'discountAmount', modulePath: path.join(root, file), exportName: 'discountAmount' },
    ],
  };
}

/**
 * `forall x in DOMAIN: f(x) >= 0` where `f` is an opaque model bound to `exportName` in a module written
 * into the project. Used for implementations outside the translatable subset.
 */
export function opaqueProperty(
  root: string,
  source: string,
  options: { exportName?: string; returns?: Sort; file?: string } = {},
): { ir: PropertyIR; bindings: Binding[] } {
  const file = options.file ?? 'src/impl.ts';
  const returns = options.returns ?? 'int';
  const modulePath = path.join(root, file);
  writeFileSync(modulePath, source);
  const model: FunctionModel = {
    name: 'f',
    symbol: `${file}#f`,
    params: [{ name: 'x', sort: 'int' }],
    returns,
    body: null,
  };
  const call = { kind: 'call' as const, fn: 'f', args: [{ kind: 'var' as const, name: 'x' }] };
  const ir: PropertyIR = {
    irVersion: 1,
    params: [{ name: 'x', sort: 'int', domain: DOMAIN }],
    preconditions: [],
    functions: [model],
    body:
      returns === 'int'
        ? { kind: 'binary', op: '>=', left: call, right: { kind: 'int', value: '0' } }
        : { kind: 'binary', op: '==', left: call, right: { kind: 'bool', value: true } },
  };
  return { ir, bindings: [{ modelName: 'f', modulePath, exportName: options.exportName ?? 'f' }] };
}
