// Checks a `veritas prove --engine both` run against the properties declared in the project's configuration: every
// declared property must be accepted and proven within the model by Z3 (replayed in JavaScript) and by Lean (kernel
// checked). Anything else fails, including a declared property that is missing from the run, not accepted, or has
// an unknown, timeout, unsupported, semantic_mismatch or error claim. A property named with --expect-counterexample
// must instead come back with a Z3 counterexample that JavaScript reproduced, and no proof (a negative control: it
// catches a solver or translator that would prove anything).
//
// The run must be of the current checkout: its configuration and source hashes, its git commit when the working
// tree is clean, and the version of every declared property (derived from its target, kind, description and
// effective bounds) must match what the configuration and code say now. A run that did not finish fails too.
//
//   node scripts/check-self-verification.mjs [--root <dir>] [--run <run-id>] [--expect-counterexample <id>]...
//
// <dir> defaults to the working directory; <run-id> to the newest run under <dir>/.veritas/runs, whatever it holds.
// Ids are the declaration ids of `properties` in <dir>/.veritas/config.json (the property id is `D-<id>`). Needs
// the built packages of this repository (`pnpm build`).
// Exit codes: 0 every check passed, 1 a check failed, 2 usage or input error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DECLARED_PREFIX = 'D-';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** The run to check: the one named, or the newest one, whether or not it finished. */
function runDir(root, run) {
  const runs = path.join(root, '.veritas', 'runs');

  if (run !== null) {
    if (!/^run-[\w-]+$/.test(run)) throw new InputError(`invalid run id ${run}`);

    if (!existsSync(path.join(runs, run))) throw new InputError(`no run ${run} under ${runs}`);

    return path.join(runs, run);
  }
  const latest = (existsSync(runs) ? readdirSync(runs) : [])
    .filter((name) => /^run-[\w-]+$/.test(name))
    .sort()
    .at(-1);

  if (!latest) throw new InputError(`no run under ${runs}; run \`veritas prove --engine both\` first`);

  return path.join(runs, latest);
}

/**
 * The verdict for every declared property, as lines, and whether all of them passed. `declared` are the current
 * declarations with the property version they have now; `current` the hashes and commit of the checkout
 * (`gitCommit` null when the tree is not clean or not a git repository); `meta` the run's artifact metadata;
 * `properties`, `claims` and `stages` the data of its properties.json, claims.json (null when missing) and run.json.
 */
export function checkRun({ declared, expectCounterexample, current, meta, properties, claims, stages }) {
  const lines = [];
  let ok = true;
  const fail = (line) => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };
  const prove = stages.find((s) => s.stage === 'prove');

  if (!prove) fail('the run has no prove stage');
  else if (prove.status !== 'succeeded') fail(`the prove stage is ${prove.status}`);

  if (meta.configHash !== current.configHash)
    fail('the run used another configuration than .veritas/config.json holds now; run prove again');

  if (meta.sourceHash !== current.sourceHash)
    fail('the run analyzed other source files than the checkout holds now; run prove again');

  if (current.gitCommit !== null && meta.gitCommit !== current.gitCommit)
    fail(`the run is of commit ${meta.gitCommit ?? '(none)'}, not of ${current.gitCommit}; run prove again`);

  if (claims === null) {
    fail('the run recorded no claims: prove did not finish');

    return { ok, lines };
  }
  const ids = declared.map((d) => d.id);

  for (const id of expectCounterexample)
    if (!ids.includes(id)) fail(`${id}: --expect-counterexample names no declared property`);

  for (const { id, version } of declared) {
    const propertyId = `${DECLARED_PREFIX}${id}`;
    const property = properties.find((p) => p.id === propertyId);

    if (!property) {
      fail(`${propertyId}: not in the run`);
      continue;
    }

    if (property.version !== version) {
      fail(
        `${propertyId}: the run checked version ${property.version} of the declaration, it is now version ${version}; run prove again`,
      );
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

/** A package of this repository's build: the hashes and versions must be computed the way Veritas computes them. */
async function load(pkg) {
  const file = path.join(REPO, 'packages', pkg, 'dist', 'index.js');

  if (!existsSync(file))
    throw new InputError(`${path.relative(REPO, file)} is missing; run \`pnpm build\` first`);

  return import(pathToFileURL(file).href);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A run artifact whose `data` has the shape `valid` expects; `{ data: null }` for a missing optional one. */
function artifact(dir, name, valid, optional = false) {
  const file = path.join(dir, name);

  if (optional && !existsSync(file)) return { data: null, meta: null };
  const json = readJson(file, name);

  if (!isObject(json) || !isObject(json.meta) || !valid(json.data))
    throw new InputError(`${file} is not a Veritas run artifact of the expected shape`);

  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const core = await load('core');
  const { analyzeCode } = await load('code-intelligence');
  const { runSourceHash } = await load('engine');
  const { declaredProperties } = await load('property-engine');
  let loaded;

  try {
    loaded = await core.loadConfig(args.root);
  } catch (error) {
    throw new InputError(`cannot load the configuration of ${args.root}: ${error.message}`);
  }
  const { config } = loaded;

  if (config.properties.length === 0) throw new InputError('the configuration declares no property');
  const declared = declaredProperties(config.properties, {
    integerDomain: config.formal.integerDomain,
    maxArrayLength: config.formal.maxArrayLength,
  }).map((p) => ({ id: p.id.slice(DECLARED_PREFIX.length), version: p.version }));
  // The commit only identifies the checked code when nothing is modified; the hashes are compared either way.
  const clean = core.gitOutput(args.root, ['status', '--porcelain'])?.trim() === '';
  const current = {
    configHash: loaded.hash,
    // The analyzed files and the declared target files, as the run computed it.
    sourceHash: runSourceHash(args.root, config, analyzeCode({ root: args.root, config }).files),
    gitCommit: clean ? core.gitCommit(args.root) : null,
  };
  const dir = runDir(args.root, args.run);
  const run = artifact(
    dir,
    'run.json',
    (d) => isObject(d) && Array.isArray(d.stages) && d.stages.every(isObject),
  );
  const properties = artifact(
    dir,
    'properties.json',
    (d) => isObject(d) && Array.isArray(d.properties) && d.properties.every(isObject),
    true,
  );
  const claims = artifact(
    dir,
    'claims.json',
    (d) => Array.isArray(d) && d.every((c) => isObject(c) && typeof c.engine === 'string'),
    true,
  );
  const { ok, lines } = checkRun({
    declared,
    expectCounterexample: args.expectCounterexample,
    current,
    meta: run.meta,
    properties: properties.data?.properties ?? [],
    claims: claims.data,
    stages: run.data.stages,
  });
  process.stdout.write(`${path.basename(dir)}\n${lines.join('\n')}\n`);

  if (!ok) process.stdout.write('self-verification failed\n');

  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
