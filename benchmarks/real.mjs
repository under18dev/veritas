// Measures `veritas run --profile quick` on the open-source projects listed in benchmarks/real-projects.json.
// Usage: node benchmarks/real.mjs --work <dir> [--cli <bin.js>] [--out <file>] [--only <name,...>]
// Each project is cloned at its pinned commit into <dir>/<name> (reused when present) and its dependencies are
// installed with lifecycle scripts disabled. The quick profile reads code and tests but runs none of them.
// Writes wall-clock time, counts and, on Linux, peak memory (GNU time) per project.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const at = process.argv.indexOf(name);

  return at >= 0 ? process.argv[at + 1] : undefined;
};
const work = option('--work');

if (!work) {
  console.error(
    'usage: node benchmarks/real.mjs --work <dir> [--cli <bin.js>] [--out <file>] [--only <names>]',
  );
  process.exit(2);
}
const cli = path.resolve(option('--cli') ?? path.join(repo, 'packages/cli/dist/bin.js'));
const only = option('--only')?.split(',');
const list = JSON.parse(
  readFileSync(path.join(repo, 'benchmarks/real-projects.json'), 'utf8'),
).projects.filter((p) => !only || only.includes(p.name));
const gnuTime =
  process.platform === 'linux' && spawnSync('/usr/bin/time', ['-f', '%M', 'true']).status === 0
    ? '/usr/bin/time'
    : null;
const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });

/** Clone the project at its commit and install its dependencies once; returns a reason when that fails. */
function prepare(project, dir) {
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });

    for (const args of [
      ['init', '-q'],
      ['remote', 'add', 'origin', project.repo],
      ['fetch', '-q', '--depth', '1', 'origin', project.commit],
      ['checkout', '-q', 'FETCH_HEAD'],
    ]) {
      const step = run('git', args, dir);

      if (step.status !== 0) return `git ${args[0]} failed: ${step.stderr.trim().slice(0, 200)}`;
    }
  }

  if (!existsSync(path.join(dir, 'node_modules'))) {
    const install = run(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts', '--config.manage-package-manager-versions=false'],
      dir,
    );

    if (install.status !== 0) return `pnpm install failed: ${install.stderr.trim().slice(-200)}`;
  }

  return null;
}

const results = [];

for (const project of list) {
  const dir = path.resolve(work, project.name);
  const problem = prepare(project, dir);

  if (problem) {
    results.push({ project: project.name, commit: project.commit, error: problem });
    console.log(`${project.name.padEnd(12)} skipped: ${problem}`);
    continue;
  }
  run(process.execPath, [cli, 'init', '--yes', '--force'], dir);
  const command = [cli, 'run', '--profile', 'quick', '--offline', '--json'];
  const rssFile = gnuTime ? path.join(dir, '.veritas', 'peak-rss') : null;
  const started = process.hrtime.bigint();
  const done = rssFile
    ? run(gnuTime, ['-f', '%M', '-o', rssFile, process.execPath, ...command], dir)
    : run(process.execPath, command, dir);
  const wallMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  const result = {
    project: project.name,
    commit: project.commit,
    exitCode: done.status,
    wallMs,
    peakRssMb: null,
  };

  try {
    if (rssFile) result.peakRssMb = Math.round(Number(readFileSync(rssFile, 'utf8').trim()) / 1024);
  } catch {
    // no measurement
  }

  try {
    const runDir = path.join(dir, '.veritas/runs', JSON.parse(done.stdout).runId);
    const read = (name) => JSON.parse(readFileSync(path.join(runDir, name), 'utf8')).data;
    result.functions = read('code-index.json').functions.length;
    result.tests = read('test-map.json').tests.length;
    result.outcomes = {};

    for (const a of read('assessments.json'))
      result.outcomes[a.outcome] = (result.outcomes[a.outcome] ?? 0) + 1;
    result.stageMs = Object.fromEntries(read('run.json').stages.map((s) => [s.stage, s.durationMs]));
  } catch {
    // a failed run is reported with its exit code, not hidden
  }
  results.push(result);
  console.log(`${project.name.padEnd(12)} exit=${done.status} ${wallMs} ms`);
}
const file = path.resolve(option('--out') ?? path.join(work, 'real-results.json'));
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch, cpus: cpus().length, results }, null, 2)}\n`,
);
console.log(`wrote ${file}`);
