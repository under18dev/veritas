import { expect, it } from 'vitest';
import { shippingFee } from '../src/pricing.js';

it('charges shipping just below the threshold', () => {
  expect(shippingFee(4999)).toBe(500);
});

it('ships free exactly at the threshold', () => {
  expect(shippingFee(5000)).toBe(0);
});
