import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { ReportInput, renderJson, reportJsonSchema } from '../src/index.js';
import { fixture, reversedFixture } from './fixtures.js';

describe('JSON report', () => {
  it('parses and validates the rendered document', () => {
    const value = JSON.parse(renderJson(fixture())) as object;
    const AjvConstructor = Ajv as unknown as {
      new (options?: object): { compile(schema: object): (data: object) => boolean };
    };
    const validate = new AjvConstructor({ strict: false }).compile(reportJsonSchema());
    expect(validate(value)).toBe(true);
    expect(value).toHaveProperty('schemaVersion', '1.0.0');
  });

  it('rejects malformed input with a missing run error', () => {
    expect(() => ReportInput.parse({})).toThrow(/run/i);
  });

  it('is byte-identical for repeated and reordered inputs', () => {
    expect(renderJson(fixture())).toBe(renderJson(fixture()));
    expect(renderJson(fixture())).toBe(renderJson(reversedFixture()));
  });
});
