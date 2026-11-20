#!/usr/bin/env node
// Publishes every public workspace package to npm, dependencies first.
//
//   node scripts/publish.mjs [--expect <version>] [--dry-run]
//
// Each package is packed with pnpm, which turns `workspace:` ranges into the real versions, and the tarball is
// published with npm to registry.npmjs.org. A package already published at this version is skipped, so a failed
// run can be repeated. In GitHub Actions the tarballs are published with provenance through npm trusted
// publishing (OIDC); locally npm uses your login.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePackages } from './workspace-packages.mjs';

const REGISTRY = 'https://registry.npmjs.org/';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const expectIndex = args.indexOf('--expect');
const expected = expectIndex >= 0 ? args[expectIndex + 1]?.replace(/^v/, '') : undefined;
const inActions = process.env.GITHUB_ACTIONS === 'true';

// npm and pnpm are started without a shell, so no argument is ever interpreted. On Windows they are .cmd shims,
// which Node.js only starts through cmd.exe (with its own expansion rules), so publishing runs on Linux or macOS;
// the release workflow uses Linux.
if (process.platform === 'win32') {
  console.error('publish from Linux or macOS (the release workflow runs on Linux)');
  process.exit(2);
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });

  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const packages = workspacePackages(repo).filter(({ manifest }) => !manifest.private);
const versions = new Set(packages.map(({ manifest }) => manifest.version));

if (versions.size !== 1) {
  console.error(`the public packages do not share one version: ${[...versions].join(', ')}`);
  process.exit(1);
}

const [version] = versions;

if (expected !== undefined && version !== expected) {
  console.error(`the packages are at ${version}, but the release asks for ${expected}`);
  process.exit(1);
}

// Dependencies first, so no published package points at a version that is not on the registry yet.
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const ordered = [];
const visiting = new Set();
const visit = (pkg) => {
  if (ordered.includes(pkg)) return;
  if (visiting.has(pkg)) throw new Error(`dependency cycle at ${pkg.manifest.name}`);
  visiting.add(pkg);

  for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
    const dependency = byName.get(name);

    if (dependency) visit(dependency);
  }

  visiting.delete(pkg);
  ordered.push(pkg);
};

for (const pkg of packages) visit(pkg);

const out = mkdtempSync(path.join(tmpdir(), 'veritas-publish-'));
let failed = false;

for (const { dir, manifest } of ordered) {
  const id = `${manifest.name}@${version}`;
  const existing = run('npm', ['view', id, 'version', '--registry', REGISTRY]);

  if (existing.code === 0 && existing.stdout.trim() === version) {
    console.log(`skip    ${id} (already published)`);
    continue;
  }

  // Publish only on a confirmed "not found"; a network or registry error must not be read as "not published".
  if (existing.code === 0 || !/\bE404\b/.test(existing.stderr)) {
    console.error(
      `check   ${id} failed: cannot tell whether it is published\n${existing.stderr}${existing.stdout}`,
    );
    failed = true;
    break;
  }

  const before = new Set(readdirSync(out));
  const packed = run('pnpm', ['pack', '--pack-destination', out], { cwd: path.join(repo, dir) });
  const tarball = readdirSync(out).find((file) => !before.has(file) && file.endsWith('.tgz'));

  if (packed.code !== 0 || !tarball) {
    console.error(`pack    ${id} failed\n${packed.stderr}`);
    failed = true;
    break;
  }

  const publishArgs = ['publish', path.join(out, tarball), '--access', 'public', '--registry', REGISTRY];

  if (inActions) publishArgs.push('--provenance');
  if (dryRun) publishArgs.push('--dry-run');
  const published = run('npm', publishArgs, { stdio: 'inherit' });

  if (published.code !== 0) {
    console.error(`publish ${id} failed`);
    failed = true;
    break;
  }

  console.log(`${dryRun ? 'dry-run' : 'publish'} ${id}`);
}

process.exit(failed ? 1 : 0);
