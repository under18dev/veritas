import { expect, it } from 'vitest';
import { process } from '../src/calc.js';

it('processes', () => {
  expect(process(5, 3)).toBe(2);
});
