import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type DeclaredProperty,
  type IntDomain,
  type Property,
  parseSymbolId,
  resolveInsideRoot,
} from '@under18dev/veritas-core';
import { exportsFunction, holdsForAllProperty, translateFunction } from '@under18dev/veritas-formal-core';
import type { Formalization } from './formalize.js';
import { contentHash } from './registry.js';

/** Prefix of the property ids of declared properties: `D-<declaration id>`. */
export const DECLARED_PREFIX = 'D-';

/**
 * A declared target in the form of the code index's symbol ids: the file part project-relative and POSIX
 * (`./src/a.ts#f`, `src\a.ts#f` and `src/x/../a.ts#f` all become `src/a.ts#f`), so that it matches the symbols
 * tests and mutants are linked to, and so that spellings of the same file give the same property version. A path
 * that leaves the project (`../x.ts`) or is absolute keeps that form and is refused when it is formalized.
 */
export function normalizeTarget(target: string): string {
  const hash = target.lastIndexOf('#');
  const file = path.posix.normalize(target.slice(0, hash).replaceAll('\\', '/'));

  return `${file.startsWith('./') ? file.slice(2) : file}${target.slice(hash)}`;
}

/** The bounds a declared property is checked over, after the formal settings fill in what it leaves unset. */
export interface DeclaredDomain {
  integer: IntDomain;
  maxArrayLength: number;
}

/** The domain recorded on a declared property (see `declaredProperties`). */
export function declaredDomain(property: Property): DeclaredDomain | null {
  const domain = property.inputDomain as Partial<DeclaredDomain> & { kind?: unknown };

  if (property.origin !== 'human' || !domain.integer || typeof domain.maxArrayLength !== 'number')
    return null;

  return { integer: domain.integer, maxArrayLength: domain.maxArrayLength };
}

/**
 * The version of a declared property, derived from its content: the same declaration has the same version on
 * every machine, so an approval recorded for it stays valid in a fresh checkout and becomes stale as soon as the
 * description, target, kind or domain changes. (Discovered properties count versions against the previous run.)
 */
export function declaredVersion(property: Property): number {
  return Number.parseInt(contentHash(property).slice(0, 8), 16) + 1;
}

/**
 * Properties from the declarations of the configuration (`properties`). They come from a person (`origin:
 * human`), but are `proposed` like any other: only an approval recorded with `veritas spec accept` makes them
 * accepted. Nothing is checked here; whether the target exists and can be translated is decided when it is
 * formalized, and a target that cannot be is reported as unsupported, never dropped.
 */
export function declaredProperties(
  declared: readonly DeclaredProperty[],
  defaults: { integerDomain: IntDomain; maxArrayLength: number },
): Property[] {
  return declared.map((d) => {
    const integer = d.domain?.integer ?? defaults.integerDomain;
    const maxArrayLength = d.domain?.maxArrayLength ?? defaults.maxArrayLength;
    const name = d.target.slice(d.target.lastIndexOf('#') + 1);
    const property: Property = {
      id: `${DECLARED_PREFIX}${d.id}`,
      version: 1,
      description: d.description,
      template: 'state_invariant',
      targetSymbols: [normalizeTarget(d.target)],
      status: 'proposed',
      origin: 'human',
      sourceIds: [],
      assumptions: [`declared in the configuration as ${d.id}`],
      inputDomain: { kind: d.kind, integer: { min: integer.min, max: integer.max }, maxArrayLength },
      formalExpression: `for all inputs (integers in [${integer.min}, ${integer.max}], arrays of at most ${maxArrayLength} elements): ${name}(...) === true`,
      statementIds: [],
      citations: [`config properties: ${d.id}`],
      conflictsWith: [],
      confidence: {
        sourceQuality: 'primary',
        agreement: 'single_source',
        implementationAlignment: 'unknown',
        independence: 'independent',
        freshness: 'current',
      },
      implementationAgreement: 'unknown',
      experimental: false,
    };
    property.version = declaredVersion(property);

    return property;
  });
}

/**
 * Formalize a declared `holds_for_all` property: forall inputs within its domain, target(...) == true. The target
 * must be an exported function of a file inside the project, return a boolean and stay in the supported subset;
 * anything else is `not_formalizable` with the reason, which the prove stage reports as an unsupported claim.
 */
export function formalizeDeclared(options: { root: string; property: Property }): Formalization {
  const { property } = options;
  const domain = declaredDomain(property);
  const target = property.targetSymbols[0];

  if (!domain || target === undefined || property.targetSymbols.length !== 1)
    return { status: 'not_formalizable', reason: `${property.id} is not a declared property` };
  let file: string;
  let name: string;

  try {
    ({ file, name } = parseSymbolId(target));
  } catch {
    return { status: 'not_formalizable', reason: `invalid target ${target}` };
  }
  let absolute: string;

  try {
    absolute = resolveInsideRoot(options.root, file);
  } catch (error) {
    return { status: 'not_formalizable', reason: `target ${target}: ${(error as Error).message}` };
  }

  if (!existsSync(absolute) || !statSync(absolute).isFile())
    return { status: 'not_formalizable', reason: `target file ${file} does not exist` };
  const source = readFileSync(absolute, 'utf8');

  if (!exportsFunction(file, source, name))
    return { status: 'not_formalizable', reason: `${file} exports no function named ${name}` };
  const translated = translateFunction({
    file,
    source,
    exportName: name,
    domain: domain.integer,
    maxArrayLength: domain.maxArrayLength,
  });

  if (translated.status === 'not_found')
    return { status: 'not_formalizable', reason: `${file} exports no function named ${name}` };

  if (translated.status === 'unsupported') {
    const reason = translated.reasons.map((r) => `line ${r.line}: ${r.reason}`).join('; ');

    return { status: 'not_formalizable', reason: `outside the supported subset: ${reason}` };
  }

  if (translated.model.returns !== 'bool')
    return {
      status: 'not_formalizable',
      reason: `${name} returns a number; a holds_for_all property needs a function that returns a boolean`,
    };

  return {
    status: 'formalized',
    ir: holdsForAllProperty(translated, domain.integer),
    assumptions: [
      `formalized as: ${name} returns true for every input with integers in [${domain.integer.min}, ${domain.integer.max}] and arrays of at most ${domain.maxArrayLength} elements`,
    ],
    file,
    exportName: name,
  };
}
