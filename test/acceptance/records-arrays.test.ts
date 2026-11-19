import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

interface Claim {
  propertyId: string;
  kind: string;
  status: string;
  counterexample?: Record<string, unknown>;
  semanticValidation: string;
}

describe('records and arrays', () => {
  it('finds the record boundary bug with a reassembled counterexample and proves the array rule within bounds', () => {
    const dir = copyFixture('order-records', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const prove = runCli(['prove', '--include-proposed', '--json'], dir);
    expect([0, 1, 4], prove.stderr).toContain(prove.status);
    const { runId } = json<{ runId: string }>(prove);
    const read = (name: string) =>
      JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, name), 'utf8')).data;
    const properties = read('properties.json').properties as {
      id: string;
      formalExpression?: string;
      targetSymbols: string[];
      origin: string;
    }[];
    const claims = (read('claims.json') as Claim[]).filter((c) => c.kind === 'conformance');
    const claimOf = (symbol: string, expression: string) => {
      const p = properties.find(
        (x) =>
          x.origin === 'normative' && x.targetSymbols.includes(symbol) && x.formalExpression === expression,
      );
      expect(p, `${symbol} ${expression}`).toBeTruthy();
      return claims.find((c) => c.propertyId === p?.id);
    };
    const discount = claimOf('src/order.ts#orderDiscount', 'order.total >= 1000');
    expect(discount?.status).toBe('counterexample_found');
    expect(discount?.semanticValidation).toBe('confirmed');
    expect(discount?.counterexample).toMatchObject({ order: { total: '1000' } });
    const shipping = claimOf('src/order.ts#shippingFee', 'items.length >= 3');
    expect(shipping?.status).toBe('proven_within_model');
    expect(shipping?.semanticValidation).toBe('confirmed');
    // The report shows the counterexample in the shape of the JavaScript arguments.
    const report = runCli(['report', '--format', 'markdown'], dir);
    expect(report.stdout).toContain('{"order":{"total":"1000"');
  }, 300_000);
});
