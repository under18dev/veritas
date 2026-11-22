// Checks a `veritas prove --engine both` run against the properties declared in the project's configuration: every
// declared property must be accepted and proven within the model by Z3 (replayed in JavaScript) and by Lean (kernel
// checked). Anything else fails, including a declared property that is missing from the run, not accepted, or has
// an unknown, timeout, unsupported, semantic_mismatch or error claim. A property named with --expect-counterexample
// must instead come back with a Z3 counterexample that JavaScript reproduced, and no proof (a negative control: it
// catches a solver or translator that would prove anything).
//
//   node scripts/check-self-verification.mjs [--root <dir>] [--run <run-id>] [--expect-counterexample <id>]...
//
// <dir> defaults to the working directory; <run-id> to the latest run under <dir>/.veritas/runs. Ids are the
// declaration ids of `properties` in <dir>/.veritas/config.json (the property id is `D-<id>`).
// Exit codes: 0 every check passed, 1 a check failed, 2 usage or input error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DECLARED_PREFIX = 'D-';

class InputError extends Error {}

function parseArgs(argv) {
  const out = { root: process.cwd(), run: null, expectCounterexample: [] };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag !== '--root' && flag !== '--run' && flag !== '--expect-counterexample')
      throw new InputError(`unknown argument ${flag}`);

    if (value === undefined || value.startsWith('--')) throw new InputError(`${flag} needs a value`);
    i++;

    if (flag === '--root') out.root = path.resolve(value);
    else if (flag === '--run') out.run = value;
    else out.expectCounterexample.push(value);
  }

  return out;
}

function readJson(file, what) {
  if (!existsSync(file)) throw new InputError(`${what} not found: ${file}`);

  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new InputError(`cannot parse ${what} ${file}: ${error.message}`);
  }
}

/** The run to check: the one named, or the latest run that recorded claims. */
function runDir(root, run) {
  const runs = path.join(root, '.veritas', 'runs');

  if (run !== null) {
    if (!/^run-[\w-]+$/.test(run)) throw new InputError(`invalid run id ${run}`);

    return path.join(runs, run);
  }
  const latest = (existsSync(runs) ? readdirSync(runs) : [])
    .filter((name) => /^run-[\w-]+$/.test(name) && existsSync(path.join(runs, name, 'claims.json')))
    .sort()
    .at(-1);

  if (!latest)
    throw new InputError(`no run with claims under ${runs}; run \`veritas prove --engine both\` first`);

  return path.join(runs, latest);
}

/**
 * The verdict for every declared property, as lines, and whether all of them passed. `declared` are declaration ids,
 * `properties` and `claims` the data of the run's properties.json and claims.json.
 */
export function checkRun({ declared, expectCounterexample, properties, claims, stages }) {
  const lines = [];
  let ok = true;
  const fail = (line) => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };
  const prove = stages.find((s) => s.stage === 'prove');

  if (!prove) fail('the run has no prove stage');
  else if (prove.status !== 'succeeded') fail(`the prove stage is ${prove.status}`);

  for (const id of expectCounterexample)
    if (!declared.includes(id)) fail(`${id}: --expect-counterexample names no declared property`);

  for (const id of declared) {
    const propertyId = `${DECLARED_PREFIX}${id}`;
    const property = properties.find((p) => p.id === propertyId);

    if (!property) {
      fail(`${propertyId}: not in the run`);
      continue;
    }

    if (property.status !== 'accepted') {
      fail(`${propertyId}: ${property.status}, not accepted`);
      continue;
    }
    const own = claims.filter((c) => c.propertyId === propertyId && c.kind === 'conformance');
    const z3 = own.filter((c) => c.engine.startsWith('z3'));
    const lean = own.filter((c) => c.engine === 'lean');
    const others = own.filter((c) => !c.engine.startsWith('z3') && c.engine !== 'lean');
    const describe = (c) =>
      `${c.engine.startsWith('z3') ? 'z3' : c.engine} ${c.status} [${c.assurance}, replay ${c.semanticValidation}]`;
    const summary = own.length ? own.map(describe).join('; ') : 'no claim';

    if (others.length) {
      fail(`${propertyId}: ${summary}`);
      continue;
    }

    if (expectCounterexample.includes(id)) {
      const refuted =
        z3.length === 1 &&
        z3[0].status === 'counterexample_found' &&
        z3[0].semanticValidation === 'confirmed' &&
        !lean.some((c) => c.status === 'proven_within_model');

      if (refuted) lines.push(`ok   ${propertyId}: ${summary} ${JSON.stringify(z3[0].counterexample ?? {})}`);
      else fail(`${propertyId}: expected a counterexample reproduced in JavaScript; got ${summary}`);
      continue;
    }
    const proven =
      z3.length === 1 &&
      z3[0].status === 'proven_within_model' &&
      z3[0].semanticValidation === 'confirmed' &&
      lean.length === 1 &&
      lean[0].status === 'proven_within_model' &&
      lean[0].assurance === 'kernel_checked';

    if (proven) lines.push(`ok   ${propertyId}: ${summary}`);
    else fail(`${propertyId}: expected proven by Z3 and kernel-checked by Lean; got ${summary}`);
  }

  return { ok, lines };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(path.join(args.root, '.veritas', 'config.json'), 'configuration');
  const declared = (config.properties ?? []).map((p) => p.id);

  if (declared.length === 0) throw new InputError('the configuration declares no property');
  const dir = runDir(args.root, args.run);
  const data = (name) => readJson(path.join(dir, name), name).data;
  const { ok, lines } = checkRun({
    declared,
    expectCounterexample: args.expectCounterexample,
    properties: data('properties.json').properties,
    claims: data('claims.json'),
    stages: data('run.json').stages,
  });
  process.stdout.write(`${path.basename(dir)}\n${lines.join('\n')}\n`);

  if (!ok) process.stdout.write('self-verification failed\n');

  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
