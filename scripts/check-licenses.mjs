// Checks that every installed dependency uses a license compatible with distributing Veritas under Apache-2.0,
// and that every publishable package declares Apache-2.0 and ships the root LICENSE file. Run via `pnpm licenses:check`.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePackages } from './workspace-packages.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Permissive licenses. MPL-2.0 is file-level copyleft: allowed because those packages (lightningcss, pulled in by
// Vitest) are installed unmodified as separate dependencies and never bundled into Veritas output.
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'MPL-2.0',
]);

/** Accepts an SPDX expression when every AND term has at least one allowed OR alternative. */
function isAllowed(expression) {
  const clean = expression.replace(/[()]/g, '').trim();
  return clean
    .split(/\s+AND\s+/)
    .every((term) => term.split(/\s+OR\s+/).some((license) => ALLOWED.has(license.trim())));
}

function listLicenses(args) {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json', ...args], {
    cwd: repo,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pnpm licenses list failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const problems = [];
const seen = new Map();
for (const args of [[], ['-r', '--prod']]) {
  for (const [license, packages] of Object.entries(listLicenses(args))) {
    for (const pkg of packages) seen.set(`${pkg.name}@${pkg.versions?.join(',') ?? ''}`, license);
  }
}
for (const [pkg, license] of seen) {
  if (!isAllowed(license)) problems.push(`${pkg}: license "${license}" is not on the allowlist`);
}

const rootLicense = readFileSync(path.join(repo, 'LICENSE'), 'utf8');
for (const { dir, manifest } of workspacePackages(repo)) {
  if (manifest.license !== 'Apache-2.0') problems.push(`${manifest.name}: license field must be Apache-2.0`);
  if (manifest.private) continue;
  let copy;
  try {
    copy = readFileSync(path.join(repo, dir, 'LICENSE'), 'utf8');
  } catch {
    copy = undefined;
  }
  if (copy !== rootLicense)
    problems.push(`${manifest.name}: ${dir}/LICENSE must be a copy of the root LICENSE`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`license check passed for ${seen.size} dependencies`);
