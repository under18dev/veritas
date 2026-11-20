// Measures wall-clock time and usage counters of `veritas run` per profile on each fixture.
// Usage: node benchmarks/run.mjs [--check] [--keep-runs <dir>] [profile ...]   (default: quick standard deep)
// --keep-runs copies each run's .veritas/runs/<run-id>/ to <dir>/<fixture>-<profile>/ (CI uploads them).
// Writes benchmarks/results/<date>-<platform>.json. With --check, exits 1 when a run fails or exceeds the budget in
// benchmarks/budget.json (ADR 0009); without it, numbers are recorded only.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'packages/cli/dist/bin.js');
const fixtures = [
  'small-app',
  'discount-boundary',
  'agent-loop',
  'conflicting-docs',
  'equivalent-mutants',
  'no-spec',
];
const args = process.argv.slice(2);
const check = args.includes('--check');
const keepAt = args.indexOf('--keep-runs');
const keepRuns = keepAt >= 0 ? path.resolve(args[keepAt + 1] ?? '') : null;
const named = args.filter((a, i) => a !== '--check' && i !== keepAt && i !== keepAt + 1);
const profiles = named.length ? named : ['quick', 'standard', 'deep'];
const budget = JSON.parse(readFileSync(path.join(repo, 'benchmarks/budget.json'), 'utf8'));

function link(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) link(path.join(from, entry), path.join(to, entry));
    else symlinkSync(realpathSync(path.join(from, entry)), path.join(to, entry), 'junction');
  }
}

function copy(name) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-bench-${name}-`)));
  const src = path.join(repo, 'fixtures', name);
  cpSync(src, dir, {
    recursive: true,
    filter: (s) => !s.includes('node_modules') && !s.includes('.mutator'),
  });
  link(path.join(src, 'node_modules'), path.join(dir, 'node_modules'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=b@x.invalid', '-c', 'user.name=b', 'add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=b@x.invalid', '-c', 'user.name=b', 'commit', '-qm', 'bench'], {
    cwd: dir,
  });
  spawnSync(process.execPath, [cli, 'init', '--yes'], { cwd: dir });
  return dir;
}

const results = [];
for (const fixture of fixtures) {
  for (const profile of profiles) {
    const dir = copy(fixture);
    const started = process.hrtime.bigint();
    const run = spawnSync(
      process.execPath,
      [cli, 'run', '--profile', profile, '--offline', '--include-proposed', '--json'],
      { cwd: dir, encoding: 'utf8' },
    );
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    let usage = null;
    let functions = null;
    let tests = null;
    try {
      const { runId } = JSON.parse(run.stdout);
      const runDir = path.join(dir, '.veritas/runs', runId);
      usage = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8')).data.usage;
      functions = JSON.parse(readFileSync(path.join(runDir, 'code-index.json'), 'utf8')).data.functions
        .length;
      tests = JSON.parse(readFileSync(path.join(runDir, 'test-map.json'), 'utf8')).data.tests.length;
      if (keepRuns) cpSync(runDir, path.join(keepRuns, `${fixture}-${profile}`), { recursive: true });
    } catch {
      // keep nulls: a failed run is reported, not hidden
    }
    results.push({ fixture, profile, exitCode: run.status, wallMs: Math.round(ms), functions, tests, usage });
    console.log(`${fixture.padEnd(20)} ${profile.padEnd(8)} exit=${run.status} ${Math.round(ms)} ms`);
  }
}
const out = path.join(repo, 'benchmarks/results');
mkdirSync(out, { recursive: true });
const file = path.join(out, `${new Date().toISOString().slice(0, 10)}-${process.platform}.json`);
writeFileSync(
  file,
  `${JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch, cpus: cpus().length, results }, null, 2)}\n`,
);
console.log(`wrote ${path.relative(repo, file)}`);

if (check) {
  // Exit codes 0, 1 and 4 are verdicts; 2, 3 or a crash mean the run itself failed.
  const problems = [];
  for (const r of results) {
    if (![0, 1, 4].includes(r.exitCode)) problems.push(`${r.fixture} ${r.profile}: exit code ${r.exitCode}`);
    const limit = budget.maxWallMs[r.profile];
    if (limit !== undefined && r.wallMs > limit)
      problems.push(`${r.fixture} ${r.profile}: ${r.wallMs} ms exceeds the budget of ${limit} ms`);
    // Usage counters (LLM tokens, solver time, mutants, test runs) have budgets too; a run without them fails.
    const usageLimits = budget.maxUsage?.[r.profile] ?? {};
    for (const [counter, max] of Object.entries(usageLimits)) {
      const value = r.usage?.[counter];
      if (typeof value !== 'number')
        problems.push(`${r.fixture} ${r.profile}: usage counter ${counter} missing`);
      else if (value > max)
        problems.push(`${r.fixture} ${r.profile}: ${counter} ${value} exceeds the budget of ${max}`);
    }
  }
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('within budget');
}
