import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

describe('init and doctor', () => {
  it('initialises a fixture, runs doctor and round-trips the config', () => {
    const dir = copyFixture('discount-boundary', { git: true });
    const init = runCli(['init', '--yes', '--json'], dir);
    expect(init.status, init.stderr).toBe(0);
    const written = json<{ status: string; config: unknown }>(init);
    expect(written.status).toBe('written');

    const file = path.join(dir, '.veritas/config.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual(written.config);
    expect(onDisk.sources.web.enabled).toBe(false);

    const doctor = runCli(['doctor', '--json'], dir);
    expect(doctor.status, doctor.stderr).toBe(0);
    const report = json<{
      configFound: boolean;
      capabilities: { name: string; state: string; detail: string }[];
      features: { feature: string; state: string }[];
    }>(doctor);
    expect(report.configFound).toBe(true);
    const names = report.capabilities.map((c) => c.name);
    for (const required of ['node', 'git', 'vitest', 'mutator', 'z3', 'lean', 'llm', 'sandbox'])
      expect(names).toContain(required);
    // Dependencies were not installed in the copied fixture: mutation must be reported as disabled, not enabled.
    expect(report.features.find((f) => f.feature === 'mutate')?.state).toBe('disabled');
    expect(report.capabilities.find((c) => c.name === 'llm')?.state).toBe('disabled');
    const sandbox = report.capabilities.find((c) => c.name === 'sandbox');
    // Project code runs only under a Node.js that blocks network access: this one (25+) or the one CI names.
    const isolated =
      Number(process.versions.node.split('.')[0]) >= 25 || Boolean(process.env.VERITAS_SANDBOX_NODE);
    expect(sandbox?.state).toBe(isolated ? 'available' : 'unavailable');
    expect(sandbox?.detail).toMatch(isolated ? /permission-model sandbox/ : /cannot block network access/);
  });

  it('refuses to overwrite an existing configuration without --force', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const again = runCli(['init', '--yes', '--json'], dir);
    expect(again.status).toBe(2);
    expect(json(again).code).toBe('CONFIG_EXISTS');
    expect(runCli(['init', '--yes', '--force'], dir).status).toBe(0);
  });

  it('does not create a second, conflicting config when a code config exists', () => {
    const dir = copyFixture('discount-boundary');
    writeFileSync(path.join(dir, 'veritas.config.ts'), 'export default {};\n');
    const result = runCli(['init', '--yes', '--force', '--json'], dir);
    expect(result.status).toBe(2);
    expect(json(result).code).toBe('CODE_CONFIG_EXISTS');
    expect(existsSync(path.join(dir, '.veritas/config.json'))).toBe(false);
  });

  it('requires --yes when not interactive and writes nothing', () => {
    const dir = copyFixture('discount-boundary');
    const result = runCli(['init', '--json'], dir);
    expect(result.status).toBe(2);
    expect(json(result).code).toBe('CONFIRMATION_REQUIRED');
    expect(existsSync(path.join(dir, '.veritas/config.json'))).toBe(false);
  });

  it('fails with a precise error when Vitest is missing', () => {
    const dir = copyFixture('no-vitest');
    const result = runCli(['init', '--yes', '--json'], dir);
    expect(result.status).toBe(2);
    const body = json<{ code: string; hint: string }>(result);
    expect(body.code).toBe('VITEST_NOT_FOUND');
    expect(body.hint).toMatch(/add -D vitest/);
  });

  it('reports invalid configuration fields with exit code 2', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const file = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.improvement.autoApply = true;
    writeFileSync(file, JSON.stringify(config));
    const doctor = runCli(['doctor', '--json'], dir);
    expect(doctor.status).toBe(2);
    expect(json<{ message: string }>(doctor).message).toContain('improvement.autoApply');
  });
});

describe('exit codes and output contract', () => {
  it('keeps stdout pure JSON and reports a command that cannot run as an error, never success', () => {
    const dir = copyFixture('discount-boundary');
    const result = runCli(['improve', '--json'], dir);
    expect(result.status).toBe(2);
    expect(json(result)).toMatchObject({ status: 'error', code: 'CONFIG_MISSING' });
  });

  it('rejects unknown options as user errors', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['doctor', '--no-such-flag'], dir).status).toBe(2);
    expect(runCli(['prove', '--engine', 'coq'], dir).status).toBe(2);
  });

  it('prints usage errors as JSON on stdout with --json', () => {
    const dir = copyFixture('discount-boundary');
    for (const args of [
      ['--json', 'no-such-command'],
      ['--json', 'prove', '--engine', 'coq'],
    ]) {
      const result = runCli(args, dir);
      expect(result.status).toBe(2);
      expect(json(result)).toMatchObject({ status: 'error', category: 'user', code: 'USAGE', exitCode: 2 });
    }
  });

  it('rejects option values it cannot honour instead of ignoring them', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const cases: [string[], string][] = [
      [['discover', '--sources', 'bogus'], 'SOURCES_INVALID'],
      [['discover', '--max-pages', 'abc'], 'OPTION_INVALID'],
      [['discover', '--max-pages', '0'], 'OPTION_INVALID'],
      [['discover', '--allow-domain', 'not a domain'], 'CONFIG_INVALID'],
      [['analyze', 'src/no-such-file.ts'], 'PATH_NOT_FOUND'],
      [['mutate', '--scope', 'src/no-such-dir'], 'PATH_NOT_FOUND'],
    ];
    for (const [args, code] of cases) {
      const result = runCli(['--json', ...args], dir);
      expect(result.status, args.join(' ')).toBe(2);
      expect(json(result), args.join(' ')).toMatchObject({ status: 'error', code });
    }
  });

  it('refuses a project root that does not exist', () => {
    const dir = copyFixture('discount-boundary');
    const result = runCli(['--json', '-C', path.join(dir, 'missing'), 'doctor'], dir);
    expect(result.status).toBe(2);
    expect(json(result)).toMatchObject({ status: 'error', code: 'ROOT_NOT_FOUND' });
  });

  it('never prints a non-JSON report format when --json is given', () => {
    const dir = copyFixture('discount-boundary');
    const result = runCli(['--json', 'report', '--format', 'html'], dir);
    expect(result.status).toBe(2);
    expect(json(result)).toMatchObject({ status: 'error', code: 'FORMAT_CONFLICT' });
  });
});
