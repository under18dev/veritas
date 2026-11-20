import { type Expr, type FunctionModel, PropertyIR } from '@under18dev/veritas-core';
import { boundaryValues } from './run.js';

export interface GenerateVitestOptions {
  propertyId: string;
  ir: PropertyIR;
  /** `importPath` is written verbatim into the import statement, relative to the generated file. */
  bindings: { modelName: string; importPath: string; exportName: string }[];
  seed: number;
  numRuns: number;
  experimental: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`${what} ${JSON.stringify(name)} is not a valid identifier`);

  return name;
}

/** Single-line text that is safe inside a `//` comment. */
const commentText = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');

const HELPERS = `function int(value: unknown, fn: string): bigint {
  // -0 is a safe integer and is read as 0; NaN, fractions and non-numbers are never coerced.
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(\`non_integer_result: \${fn} returned \${typeof value === 'string' ? JSON.stringify(value) : String(value)}\`);
  }
  return BigInt(value);
}

function bool(value: unknown, fn: string): boolean {
  if (typeof value !== 'boolean') throw new Error(\`non_boolean_result: \${fn} returned \${String(value)}\`);
  return value;
}

function arg(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(\`argument \${value} is outside the safe-integer range\`);
  return n;
}

// SMT-LIB (Euclidean) division and modulo, as in the Veritas IR.
function ediv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero is unspecified');
  const q = a / b;
  return a - q * b < 0n ? (b > 0n ? q - 1n : q + 1n) : q;
}

function emod(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('modulo by zero is unspecified');
  const m = a % b;
  return m < 0n ? m + (b < 0n ? -b : b) : m;
}`;

const OPS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '==': '===',
  '!=': '!==',
  and: '&&',
  or: '||',
};

/**
 * Self-contained Vitest + fast-check test file (returned as a string, never written) encoding the same
 * property, domains, boundary values, seed and run count as `runPropertyTest`.
 */
export function generateVitestFile(options: GenerateVitestOptions): string {
  const ir = PropertyIR.parse(options.ir);

  if (!Number.isInteger(options.seed)) throw new Error('seed must be an integer');

  if (!Number.isInteger(options.numRuns) || options.numRuns < 1) throw new Error('numRuns must be positive');
  const functions = new Map(ir.functions.map((f) => [f.name, f]));
  const bound = new Map<string, { local: string; model: FunctionModel }>();
  const imports: string[] = [];
  options.bindings.forEach((b, i) => {
    const model = functions.get(b.modelName);

    if (!model) throw new Error(`binding ${b.modelName} has no function model in the IR`);
    const local = `impl${i}`;
    bound.set(b.modelName, { local, model });
    imports.push(
      `import { ${ident(b.exportName, 'export name')} as ${local} } from ${JSON.stringify(b.importPath)};`,
    );
  });
  const modelNames = new Map<string, string>();
  ir.functions.forEach((f, i) => {
    if (!bound.has(f.name)) modelNames.set(f.name, `model${i}`);
  });

  const code = (expr: Expr, vars: Map<string, string>): string => {
    switch (expr.kind) {
      case 'var': {
        const v = vars.get(expr.name);

        if (!v) throw new Error(`unbound variable ${expr.name}`);

        return v;
      }
      case 'int':
        return expr.value.startsWith('-') ? `(${expr.value}n)` : `${expr.value}n`;
      case 'bool':
        return String(expr.value);
      case 'unary':
        return expr.op === 'not' ? `!(${code(expr.arg, vars)})` : `(-(${code(expr.arg, vars)}))`;
      case 'binary': {
        const l = code(expr.left, vars);
        const r = code(expr.right, vars);

        if (expr.op === 'implies') return `(!(${l}) || (${r}))`;

        if (expr.op === 'div') return `ediv(${l}, ${r})`;

        if (expr.op === 'mod') return `emod(${l}, ${r})`;

        return `(${l} ${OPS[expr.op]} ${r})`;
      }
      case 'ite':
        return `(${code(expr.cond, vars)} ? ${code(expr.whenTrue, vars)} : ${code(expr.whenFalse, vars)})`;
      case 'call': {
        const args = expr.args.map((a) => code(a, vars));
        const b = bound.get(expr.fn);

        if (b) {
          const scalar = new Map(
            b.model.params.map((p, i) => [p.name, p.sort === 'int' ? `arg(${args[i]})` : `${args[i]}`]),
          );
          const at = (name: string) => scalar.get(name) as string;
          // Records and arrays are rebuilt from their flattened model parameters.
          const jsArgs = b.model.jsParams
            ? b.model.jsParams.map((j) => {
                if (j.kind === 'scalar') return at(j.param);

                if (j.kind === 'record')
                  return `{ ${j.fields.map((f) => `${JSON.stringify(f.key)}: ${at(f.param)}`).join(', ')} }`;
                const length = args[b.model.params.findIndex((p) => p.name === j.length)];

                return `[${j.elements.map(at).join(', ')}].slice(0, Number(${length}))`;
              })
            : b.model.params.map((p) => at(p.name));
          const check = b.model.returns === 'int' ? 'int' : 'bool';

          return `${check}(${b.local}(${jsArgs.join(', ')}), ${JSON.stringify(expr.fn)})`;
        }
        const local = modelNames.get(expr.fn);

        if (!local || !functions.get(expr.fn)?.body) {
          throw new Error(`function ${expr.fn} is opaque and not bound`);
        }

        return `${local}(${args.join(', ')})`;
      }
    }
  };

  const models = ir.functions
    .filter((f) => modelNames.has(f.name))
    .map((f) => {
      const vars = new Map(f.params.map((p) => [p.name, `a_${ident(p.name, 'parameter')}`]));
      const params = f.params.map((p) => `a_${p.name}: ${p.sort === 'int' ? 'bigint' : 'boolean'}`);
      const body = f.body ? code(f.body, vars) : null;

      if (body === null) return null;

      return `// IR model of ${commentText(f.symbol || f.name)}\nfunction ${modelNames.get(f.name)}(${params.join(', ')}): ${f.returns === 'int' ? 'bigint' : 'boolean'} {\n  return ${body};\n}`;
    })
    .filter((m): m is string => m !== null);

  const vars = new Map(ir.params.map((p) => [p.name, `p_${ident(p.name, 'parameter')}`]));
  const boundaries = boundaryValues(ir);
  const arbitraries = ir.params.map((p) => {
    if (p.sort === 'bool') return `  ${p.name}: fc.boolean(),`;

    if (!Number.isSafeInteger(Number(p.domain.min)) || !Number.isSafeInteger(Number(p.domain.max))) {
      throw new Error(`domain of ${p.name} leaves the safe-integer range`);
    }
    const base = `fc.integer({ min: ${p.domain.min}, max: ${p.domain.max} })`;
    const extras = boundaries[p.name] ?? [];

    return extras.length > 0
      ? `  ${p.name}: fc.oneof(${base}, fc.constantFrom(${extras.join(', ')})),`
      : `  ${p.name}: ${base},`;
  });
  const bindingsOfInput = ir.params.map((p) =>
    p.sort === 'int'
      ? `      const p_${p.name} = BigInt(input.${p.name});`
      : `      const p_${p.name} = input.${p.name};`,
  );
  const preconditions = ir.preconditions.map((pre) => `      fc.pre(Boolean(${code(pre, vars)}));`);
  const domainLines = ir.params.map((p) =>
    p.sort === 'int'
      ? `//   ${p.name}: integer in [${p.domain.min}, ${p.domain.max}]`
      : `//   ${p.name}: boolean`,
  );
  const title = `${options.experimental ? '[experimental] ' : ''}${options.propertyId} holds for ${options.numRuns} sampled inputs (seed ${options.seed})`;

  return [
    `// Generated by Veritas from property ${commentText(options.propertyId)}. Regenerate instead of editing.`,
    '// Domains (inputs are drawn only from these; nothing outside them is checked):',
    ...domainLines,
    '// Integers are compared as mathematical integers (BigInt); a bound function must return a safe integer',
    '// (or a boolean for boolean results), otherwise the property fails. -0 is read as 0.',
    `// A passing run checks ${options.numRuns} random inputs with seed ${options.seed}. It is empirical evidence, not a proof.`,
    ...(options.experimental
      ? ['// EXPERIMENTAL: derived from an inferred specification that has not been accepted.']
      : []),
    "import * as fc from 'fast-check';",
    "import { describe, it } from 'vitest';",
    ...imports,
    '',
    HELPERS,
    '',
    ...(models.length > 0 ? [models.join('\n\n'), ''] : []),
    `describe(${JSON.stringify(`veritas property ${options.propertyId}`)}, () => {`,
    `  it(${JSON.stringify(title)}, () => {`,
    '    fc.assert(',
    '      fc.property(fc.record({',
    ...arbitraries.map((a) => `      ${a}`),
    '      }), (input) => {',
    ...bindingsOfInput.map((l) => `  ${l}`),
    ...preconditions.map((l) => `  ${l}`),
    `        return ${code(ir.body, vars)};`,
    '      }),',
    `      { seed: ${options.seed}, numRuns: ${options.numRuns} },`,
    '    );',
    '  });',
    '});',
    '',
  ].join('\n');
}
