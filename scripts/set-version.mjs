#!/usr/bin/env node
// Sets one version on every workspace package (the packages share a version): node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePackages } from './workspace-packages.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(2);
}

for (const { dir } of workspacePackages(repo)) {
  const file = path.join(repo, dir, 'package.json');
  const text = readFileSync(file, 'utf8');
  const manifest = JSON.parse(text);
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name} ${version}`);
}
