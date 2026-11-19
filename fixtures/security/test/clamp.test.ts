import { expect, it } from 'vitest';
import { clamp } from '../src/clamp.js';

it('clamps', () => {
  expect(clamp(-1)).toBe(0);
  expect(clamp(11)).toBe(10);
  expect(clamp(5)).toBe(5);
});
