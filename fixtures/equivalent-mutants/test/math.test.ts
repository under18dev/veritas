import { expect, it } from 'vitest';
import { relu, smaller } from '../src/math.js';

it('keeps positive values', () => {
  expect(relu(5)).toBe(5);
});

it('clamps negative values', () => {
  expect(relu(-3)).toBe(0);
});

it('picks the smaller value', () => {
  expect(smaller(2, 7)).toBe(2);
});
