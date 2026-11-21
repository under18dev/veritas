import { describe, expect, it, test } from '@jest/globals';
import { shippingFee } from '../src/pricing.js';

describe('shippingFee', () => {
  describe('at the free shipping threshold', () => {
    it('charges shipping just below the threshold', () => {
      expect(shippingFee(4999)).toBe(500);
    });

    it('ships free exactly at the threshold', () => {
      expect(shippingFee(5000)).toBe(0);
    });
  });

  test.each([
    [10, 500],
    [9000, 0],
  ])('shippingFee(%i) is %i', (total, fee) => {
    expect(shippingFee(total)).toBe(fee);
  });

  xit('is skipped', () => {
    expect(shippingFee(1)).toBe(500);
  });
});
