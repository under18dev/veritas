import { expect, it } from 'vitest';
import { discountAmount } from '../src/pricing.js';

it('gives the discount from 1000', () => {
  expect(discountAmount(1000)).toBe(100);
});

it('gives no discount below 1000', () => {
  expect(discountAmount(999)).toBe(0);
});
