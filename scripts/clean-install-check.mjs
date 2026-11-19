// Packs every publishable package, installs the tarballs into an empty project outside the repository and runs
// the documented quick start there: init, doctor, a deep run on the discount example, report and explain.
// Exits non-zero if any step fails or the expected boundary finding is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-clean-install-')));
const tgz = path.join(work, 'tgz');
const project = path.join(work, 'project');
mkdirSync(tgz);
mkdirSync(project);
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  process.stdout.write(`$ ${cmd} ${args.join(' ')} -> ${result.status}\n`);
  if (result.status !== 0) {
    process.stdout.write(result.stdout + result.stderr);
    process.exit(1);
  }
  return result.stdout;
};

run(
  pnpm,
  [
    '-r',
    '--filter',
    './packages/*',
    '--filter',
    '!@under18dev/veritas-github-action',
    'pack',
    '--pack-destination',
    tgz,
  ],
  repo,
);
// pnpm names a tarball after the package: `@scope/name@1.2.3` becomes `scope-name-1.2.3.tgz`.
const tarballs = {};
for (const dir of readdirSync(path.join(repo, 'packages'))) {
  const manifest = JSON.parse(readFileSync(path.join(repo, 'packages', dir, 'package.json'), 'utf8'));
  if (manifest.private) continue;
  const file = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
  if (!readdirSync(tgz).includes(file)) throw new Error(`missing tarball ${file} for ${manifest.name}`);
  tarballs[manifest.name] = `file:${path.join(tgz, file).split(path.sep).join('/')}`;
}
for (const part of ['src', 'test', 'README.md'])
  cpSync(path.join(repo, 'fixtures/discount-boundary', part), path.join(project, part), { recursive: true });
writeFileSync(
  path.join(project, 'package.json'),
  JSON.stringify({
    name: 'clean-install-check',
    private: true,
    type: 'module',
    devDependencies: {
      '@under18dev/veritas': tarballs['@under18dev/veritas'],
      '@under18dev/veritas-mcp': tarballs['@under18dev/veritas-mcp'],
      vitest: '5.1.1',
      '@mizchi/mutator': '0.4.5',
      'fast-check': '4.10.3',
    },
  }),
);
writeFileSync(
  path.join(project, 'pnpm-workspace.yaml'),
  `packages: []\nminimumReleaseAge: 0\noverrides:\n${Object.entries(tarballs)
    .map(([k, v]) => `  '${k}': '${v}'\n`)
    .join('')}`,
);
run(pnpm, ['install'], project);
writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n.veritas/\n.mutator/\n');
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '-A'], { cwd: project });
execFileSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', 'commit', '-qm', 'init'], {
  cwd: project,
});
const veritas = (...args) => run(pnpm, ['exec', 'veritas', ...args], project);
veritas('init', '--yes');
veritas('doctor');
const output = JSON.parse(veritas('run', '--profile', 'deep', '--offline', '--include-proposed', '--json'));
const mismatch = output.findings.find((f) => f.kind === 'spec_implementation_mismatch');
if (!mismatch || !output.findings.some((f) => f.kind === 'survived_mutant')) {
  console.error('expected findings missing', output.findings);
  process.exit(1);
}
veritas('report', '--format', 'markdown');
veritas('explain', mismatch.id);
console.log(`clean install check passed in ${project}`);
