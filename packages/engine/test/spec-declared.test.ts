import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newRunId, type Property, RunStore, VeritasConfig } from '@under18dev/veritas-core';
import { declaredProperties, loadApprovals } from '@under18dev/veritas-property-engine';
import { describe, expect, it } from 'vitest';
import { ARTIFACTS, decideProperty, listProperties, propertyConfig, showProperty } from '../src/index.js';

const HASH = 'a'.repeat(64);
const declaration = (description: string) => ({
  id: 'short',
  kind: 'holds_for_all' as const,
  target: 'src/a.ts#invariant_short',
  description,
});

function project(config: unknown = { properties: [declaration('short arrays')] }): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-spec-declared-')));
  mkdirSync(path.join(root, '.veritas'));
  writeFileSync(path.join(root, '.veritas/config.json'), JSON.stringify(config));

  return root;
}

/** A run that recorded these properties, as the spec stage writes them. */
function recordRun(root: string, properties: Property[]): string {
  const runId = newRunId();
  new RunStore(root, runId, { configHash: HASH, sourceHash: HASH, gitCommit: null }).write(
    ARTIFACTS.properties.file,
    ARTIFACTS.properties.schema,
    { properties, conflicts: [], mapping: [], formalization: [], staleApprovals: [] },
  );

  return runId;
}

function declared(config: VeritasConfig): Property[] {
  return declaredProperties(config.properties, {
    integerDomain: config.formal.integerDomain,
    maxArrayLength: config.formal.maxArrayLength,
  });
}

const discovered = (template: Property): Property => ({
  ...template,
  id: 'P-discovered',
  version: 3,
  origin: 'normative',
  assumptions: [],
  citations: [],
});

describe('spec commands on declared properties', () => {
  it('lists and accepts a declared property before any run, at the version the run will give it', async () => {
    const root = project();
    const config = (await propertyConfig(root)) as VeritasConfig;
    // Without the configuration nothing has produced properties yet.
    expect(() => listProperties(root)).toThrow(/no run has produced properties/);
    const listed = listProperties(root, { config });
    expect(listed.runId).toBeNull();
    expect(listed.properties.map((p) => [p.id, p.status])).toEqual([['D-short', 'proposed']]);

    const approval = await decideProperty(root, 'D-short', 'accept', {
      reason: 'reviewed',
      actor: 'me',
      config,
    });
    expect(approval.propertyVersion).toBe(declared(config)[0]?.version);
    expect(loadApprovals(root).approvals).toHaveLength(1);
    expect(showProperty(root, 'D-short', { config }).property.status).toBe('accepted');
  });

  it('uses the current declaration when the latest run checked an older version or predates it', async () => {
    const root = project();
    const config = (await propertyConfig(root)) as VeritasConfig;
    const [current] = declared(config) as [Property];
    const old = declared(VeritasConfig.parse({ properties: [declaration('older wording')] }))[0] as Property;
    const other = discovered(current);
    recordRun(root, [other, old]);

    const listed = listProperties(root, { config });
    expect(listed.runId).not.toBeNull();
    expect(listed.properties.map((p) => [p.id, p.version])).toEqual([
      ['P-discovered', 3],
      ['D-short', current.version],
    ]);
    // Without the configuration the run's properties are listed as recorded.
    expect(listProperties(root).properties.map((p) => p.version)).toEqual([3, old.version]);

    // A run without the declaration gets it added after its own properties.
    const later = project({ properties: [declaration('short arrays')] });
    recordRun(later, [other]);
    expect(listProperties(later, { config }).properties.map((p) => p.id)).toEqual([
      'P-discovered',
      'D-short',
    ]);
  });

  it('keeps what the run recorded about a declaration whose version did not change', async () => {
    const root = project();
    const config = (await propertyConfig(root)) as VeritasConfig;
    const [current] = declared(config) as [Property];
    recordRun(root, [{ ...current, implementationAgreement: 'agree' }]);
    expect(listProperties(root, { config }).properties[0]?.implementationAgreement).toBe('agree');
  });

  it('cannot decide on a property that neither the run nor the configuration has', async () => {
    const root = project();
    const config = (await propertyConfig(root)) as VeritasConfig;
    await expect(
      decideProperty(root, 'D-nowhere', 'accept', { reason: 'r', actor: 'me', config }),
    ).rejects.toThrow(/no property D-nowhere in the latest run or the configuration/);
    // A project without declarations and runs still has nothing to list.
    expect(() => listProperties(project({}), { config: VeritasConfig.parse({}) })).toThrow(
      /no run has produced properties/,
    );
  });

  it('reads no configuration it may not load, and none that is missing', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-spec-declared-')));
    expect(await propertyConfig(root)).toBeUndefined();
    writeFileSync(path.join(root, 'veritas.config.mjs'), 'export default {};\n');
    expect(await propertyConfig(root)).toBeUndefined();
    const invalid = project({ properties: 'no' });
    await expect(propertyConfig(invalid)).rejects.toThrow();
  });
});
