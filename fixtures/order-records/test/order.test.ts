import { describe, expect, it } from 'vitest';
import { orderDiscount, shippingFee } from '../src/order.js';

describe('order', () => {
  it('discounts large orders', () => {
    expect(orderDiscount({ total: 2000, vip: false })).toBe(100);
    expect(orderDiscount({ total: 10, vip: true })).toBe(0);
  });

  it('charges shipping for small carts only', () => {
    expect(shippingFee([1, 2, 3])).toBe(0);
    expect(shippingFee([1])).toBe(500);
  });
});
