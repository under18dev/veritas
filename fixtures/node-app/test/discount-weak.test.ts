// The default export of node:test, and node:assert/strict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discountAmount } from '../src/pricing.ts';

test('gives a discount on large orders', () => {
  assert.equal(discountAmount(2000), 100);
});

test('gives no discount on small orders', () => {
  assert.equal(discountAmount(10), 0);
});
