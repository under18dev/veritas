import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact, setup } from './pipeline-shared.js';

describe('discount-boundary end to end: property-based tests', () => {
  it('finds the counterexample with a recorded seed and generates a runnable property test', () => {
    const dir = setup('discount-boundary');
    const run = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const pbt = readRunArtifact<
      {
        propertyId: string;
        status: string;
        trust: string;
        seed: number;
        counterexample: Record<string, string> | null;
      }[]
    >(dir, run.runId, 'pbt.json');
    const failing = pbt.find((r) => r.status === 'counterexample');
    expect(failing).toMatchObject({ trust: 'falsified', counterexample: { total: '1000' } });
    const passing = pbt.find((r) => r.status === 'passed');
    expect(passing?.trust).toBe('empirically_supported');
    const again = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const repeat = readRunArtifact<
      { propertyId: string; seed: number; counterexample: Record<string, string> | null }[]
    >(dir, again.runId, 'pbt.json');
    expect(repeat.find((r) => r.propertyId === failing?.propertyId)).toMatchObject({
      seed: failing?.seed,
      counterexample: failing?.counterexample,
    });

    const gen = runCli(['test', 'generate', '--json'], dir);
    expect(gen.status, gen.stderr).toBe(0);
    const generated = json<{ generated: { file: string; propertyId: string }[] }>(gen).generated;
    expect(generated.length).toBeGreaterThan(0);

    for (const g of generated) expect(g.file.startsWith('.veritas/generated-tests/')).toBe(true);
    const vitest = spawnSync(
      process.execPath,
      [path.join(dir, 'node_modules/vitest/vitest.mjs'), 'run', '.veritas/generated-tests'],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    expect(vitest.status).not.toBe(0);
    expect(vitest.stdout + vitest.stderr).toMatch(/Counterexample: \[\{"total":1000\}\]/);

    // Regenerating leaves unchanged files alone, and never replaces an edited one without --force.
    expect(runCli(['test', 'generate', '--json'], dir).status).toBe(0);
    const edited = path.join(dir, generated[0]?.file as string);
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n// kept by the user\n`);
    const refused = runCli(['test', 'generate', '--json'], dir);
    expect(refused.status).toBe(2);
    expect(refused.stdout + refused.stderr).toMatch(/GENERATED_TEST_CHANGED/);
    expect(readFileSync(edited, 'utf8')).toContain('// kept by the user');
    expect(runCli(['test', 'generate', '--force', '--json'], dir).status).toBe(0);
    expect(readFileSync(edited, 'utf8')).not.toContain('// kept by the user');
  });
});

describe('property-based test replay', () => {
  it('replays a counterexample with the command shown in its finding and reproduces the same input', () => {
    const dir = setup('discount-boundary');
    const run = json<{ findings: { kind: string; explanation: string[] }[] }>(
      runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir),
    );
    const finding = run.findings.find(
      (f) => f.kind === 'counterexample' && f.explanation.some((e) => e.startsWith('replay: ')),
    );
    const command =
      finding?.explanation.find((e) => e.startsWith('replay: '))?.slice('replay: '.length) ?? '';
    expect(command).toMatch(/^veritas test replay PBT-[0-9a-f]+$/);
    const replay = runCli([...command.split(' ').slice(1), '--json'], dir);
    expect(replay.status, replay.stderr).toBe(0);
    const result = json<{
      status: string;
      recorded: { counterexample: unknown };
      replayed: { counterexample: unknown };
    }>(replay);
    expect(result.status).toBe('reproduced');
    expect(result.replayed.counterexample).toEqual(result.recorded.counterexample);
    expect(result.replayed.counterexample).toEqual({ total: '1000' });
    const missing = runCli(['test', 'replay', 'PBT-000000000000', '--json'], dir);
    expect(missing.status).toBe(2);
    expect(json(missing)).toMatchObject({ code: 'PBT_RESULT_NOT_FOUND' });
  });
});
