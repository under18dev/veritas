import { expect, it } from 'vitest';
import { sumsTo33 } from '../src/cubes.js';

it('is 0 for small cubes', () => {
  expect(sumsTo33(1, 1, 1)).toBe(0);
});
