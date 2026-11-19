// Measures wall-clock time and usage counters of `veritas run` per profile on each fixture.
// Usage: node benchmarks/run.mjs [profile ...]   (default: quick standard deep)
// Writes benchmarks/results/<date>.json. Numbers are measurements on this machine, not guarantees.
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
const fixtures = ['discount-boundary', 'agent-loop', 'conflicting-docs', 'equivalent-mutants', 'no-spec'];
const profiles = process.argv.slice(2).length ? process.argv.slice(2) : ['quick', 'standard', 'deep'];

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
