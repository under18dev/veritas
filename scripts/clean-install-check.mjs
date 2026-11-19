// Packs every publishable package, installs the tarballs into an empty project outside the repository and runs
// the README quick start there (on the discount example), followed by a markdown report.
// Exits non-zero if any step fails or the expected boundary finding is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readmeQuickStart } from './readme-quick-start.mjs';
import { workspacePackages } from './workspace-packages.mjs';

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
    './packages/llm-providers/*',
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
for (const { manifest } of workspacePackages(repo)) {
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
// The README quick start, in order. `run` also prints JSON so its findings can be checked and used for
// placeholders of later commands.
let mismatch = null;
for (const command of readmeQuickStart(repo)) {
  const args = command.map((arg) => {
    if (arg !== '<finding-id>') return arg;
    if (!mismatch) throw new Error('the README quick start uses <finding-id> before `run`');
    return mismatch.id;
  });
  const placeholder = args.find((arg) => /^<.*>$/.test(arg));
  if (placeholder) throw new Error(`unknown placeholder ${placeholder} in the README quick start`);
  if (args[0] !== 'run') {
    veritas(...args);
    continue;
  }
  const output = JSON.parse(veritas(...args, '--json'));
  mismatch = output.findings.find((f) => f.kind === 'spec_implementation_mismatch');
  if (!mismatch || !output.findings.some((f) => f.kind === 'survived_mutant')) {
    console.error('expected findings missing', output.findings);
    process.exit(1);
  }
}
if (!mismatch) throw new Error('the README quick start never runs `veritas run`');
// Beyond the quick start: the markdown report renders from the installed packages.
veritas('report', '--format', 'markdown');
console.log(`clean install check passed in ${project}`);
