import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

const OUTSIDE_SOURCE = 'export function escaped(x: number): number { return x > 3 ? 7 : 0; }\n';
const OUTSIDE_DOC = '# Escaped\n\nThe clamp function must return escaped-marker values.\n';

/** A directory next to the project, holding files that must never be read or written. */
function outsideDir(): { dir: string; snapshot: () => Record<string, string> } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-security-outside-')));
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'src/escaped.ts'), OUTSIDE_SOURCE);
  writeFileSync(path.join(dir, 'docs/ESCAPED.md'), OUTSIDE_DOC);
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(path.join(dir, 'config/tsconfig.json'), '{ "compilerOptions": { "escaped": ');
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(
    path.join(dir, 'test/escaped.test.ts'),
    "import { expect, it } from 'vitest';\nit('escaped test', () => expect(1).toBe(1));\n",
  );
  const snapshot = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (rel: string) => {
      for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;

        if (entry.isDirectory()) walk(child);
        else out[child] = readFileSync(path.join(dir, child), 'utf8');
      }
    };
    walk('');

    return out;
  };

  return { dir, snapshot };
}

function codeIndexDiagnostics(dir: string, runId: string): { file: string; message: string }[] {
  const file = path.join(dir, '.veritas/runs', runId, 'code-index.json');

  return (
    JSON.parse(readFileSync(file, 'utf8')) as { data: { diagnostics: { file: string; message: string }[] } }
  ).data.diagnostics;
}

function runArtifacts(dir: string): string {
  const runs = path.join(dir, '.veritas/runs');

  if (!existsSync(runs)) return '';

  return readdirSync(runs)
    .flatMap((run) =>
      readdirSync(path.join(runs, run))
        .filter((file) => file.endsWith('.json') || file.endsWith('.md'))
        .map((file) => readFileSync(path.join(runs, run, file), 'utf8')),
    )
    .join('\n');
}

describe('security fixture: traversal and symlink escapes', () => {
  it('does not read sources or docs through directory links that leave the project', () => {
    const dir = copyFixture('security', { git: true, linkDeps: true });
    const outside = outsideDir();
    const before = outside.snapshot();
    // Directory junctions work without extra privileges on Windows too.
    symlinkSync(path.join(outside.dir, 'src'), path.join(dir, 'src/linked'), 'junction');
    symlinkSync(path.join(outside.dir, 'docs'), path.join(dir, 'docs/external'), 'junction');
    symlinkSync(path.join(outside.dir, 'config'), path.join(dir, 'config'), 'junction');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const configFile = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.project.tsconfig = 'config/tsconfig.json';
    writeFileSync(configFile, JSON.stringify(config));
    const run = runCli(['run', '--profile', 'quick', '--json'], dir);
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0);
    const { runId } = json<{ runId: string }>(run);
    const artifacts = runArtifacts(dir);
    expect(artifacts).toContain(runId);
    expect(artifacts).not.toContain('escaped');
    expect(artifacts).not.toContain('Escaped');
    // The tsconfig behind the link is not read: it is ignored like any tsconfig outside the root.
    expect(codeIndexDiagnostics(dir, runId)).toContainEqual({
      file: 'config/tsconfig.json',
      message: 'tsconfig outside the project root ignored; using defaults',
    });
    // The project's own evidence is still collected.
    expect(artifacts).toContain('The clamp function must return a value of at least 0.');
    expect(outside.snapshot()).toEqual(before);
  });

  it('rejects paths, run ids and configuration that point outside the project', () => {
    const dir = copyFixture('security', { git: true, linkDeps: true });
    const outside = outsideDir();
    const before = outside.snapshot();
    const relOutside = path.relative(dir, outside.dir).split(path.sep).join('/');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const configFile = path.join(dir, '.veritas/config.json');
    const config = readFileSync(configFile, 'utf8');

    expect(runCli(['analyze', relOutside, '--json'], dir).status).toBe(2);
    expect(runCli(['analyze', outside.dir, '--json'], dir).status).toBe(2);
    expect(runCli(['replay', `../${path.basename(outside.dir)}`, '--json'], dir).status).toBe(2);
    expect(runCli(['report', '--run', '../../outside', '--json'], dir).status).toBe(2);
    expect(runCli(['explain', '../../x', '--json'], dir).status).not.toBe(0);

    // Configuration that points outside the root is ignored with a diagnostic or narrowed to nothing; never read.
    const patches: [string, (c: Record<string, Record<string, unknown>>) => void][] = [
      ['include', (c) => (c.analysis = { ...c.analysis, include: [`${relOutside}/src/**/*.ts`] })],
      ['testInclude', (c) => (c.analysis = { ...c.analysis, testInclude: [`${relOutside}/test/**/*.ts`] })],
      ['tsconfig', (c) => (c.project = { ...c.project, tsconfig: `${relOutside}/config/tsconfig.json` })],
    ];

    for (const [name, patch] of patches) {
      const changed = JSON.parse(config) as Record<string, Record<string, unknown>>;
      patch(changed);
      writeFileSync(configFile, JSON.stringify(changed));
      const result = runCli(['run', '--profile', 'quick', '--json'], dir);
      expect(result.status, `${name}: ${result.stderr}\n${result.stdout}`).toBe(0);
      const { runId } = json<{ runId: string }>(result);
      const map = JSON.parse(
        readFileSync(path.join(dir, '.veritas/runs', runId, 'test-map.json'), 'utf8'),
      ) as {
        data: { tests: { file: string }[] };
      };
      expect(
        map.data.tests.map((t) => t.file).filter((f) => f.includes('escaped')),
        name,
      ).toEqual([]);
      const messages = codeIndexDiagnostics(dir, runId).map((d) => d.message);

      if (name === 'include')
        expect(messages.some((m) => m.startsWith('skipped: path escapes the project root'))).toBe(true);

      if (name === 'tsconfig')
        expect(messages).toContain('tsconfig outside the project root ignored; using defaults');
    }
    writeFileSync(configFile, config);

    // Skipped paths may be named in diagnostics, but nothing behind them is read.
    const artifacts = runArtifacts(dir);

    for (const content of ['x > 3 ? 7', 'escaped-marker', 'escaped test', 'function escaped'])
      expect(artifacts).not.toContain(content);
    expect(outside.snapshot()).toEqual(before);
    expect(existsSync(path.join(outside.dir, '.veritas'))).toBe(false);
    // The injected document asks for a write to ../../outside.txt; nothing is written above the project.
    expect(existsSync(path.join(dir, '..', 'outside.txt'))).toBe(false);
    expect(existsSync(path.join(dir, '../..', 'outside.txt'))).toBe(false);
  });
});
