import { expect, it } from 'vitest';
import { discountAmount } from '../src/pricing.js';

it('gives a discount on large orders', () => {
  expect(discountAmount(2000)).toBe(100);
});

it('gives no discount on small orders', () => {
  expect(discountAmount(10)).toBe(0);
});
