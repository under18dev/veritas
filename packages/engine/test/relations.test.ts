import type { Param } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { literalInput } from '../src/index.js';

const domain = { min: '-100', max: '100' };
const params: Param[] = [
  { name: 'n', sort: 'int', domain },
  { name: 'flag', sort: 'bool' },
];

describe('literalInput', () => {
  it('turns integer and boolean literals of the right sorts into a solver input', () => {
    expect(literalInput(params, ['-5', 'true'], domain)).toEqual({ n: '-5', flag: true });
    expect(literalInput(params, [' 7 ', 'false'], domain)).toEqual({ n: '7', flag: false });
  });

  it('refuses anything that is not a literal of the sort, outside the domain or of the wrong arity', () => {
    for (const args of [
      ['x', 'true'],
      ['1.5', 'true'],
      ['1e3', 'true'],
      ['0x10', 'true'],
      ['101', 'true'],
      ['5', '1'],
      [null, 'true'],
      ['5'],
      ['5', 'true', '1'],
    ])
      expect(literalInput(params, args, domain), JSON.stringify(args)).toBeNull();
  });
});
