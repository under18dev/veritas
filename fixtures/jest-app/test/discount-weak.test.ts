// Jest's globals, without an import.
import { discountAmount } from '../src/pricing.js';

describe('discountAmount', () => {
  it('gives a discount on large orders', () => {
    expect(discountAmount(2000)).toBe(100);
  });

  test('gives no discount on small orders', () => {
    expect(discountAmount(10)).toBe(0);
  });
});
