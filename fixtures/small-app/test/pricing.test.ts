import { expect, it } from 'vitest';
import { discountAmount, shippingFee, loyaltyBonus, seniorPrice, bulkUnitPrice } from '../src/pricing.js';

it('discountAmount below 1000', () => {
  expect(discountAmount(999)).toBe(0);
});

it('discountAmount at 1000', () => {
  expect(discountAmount(1000)).toBe(100);
});

it('discountAmount far above 1000', () => {
  expect(discountAmount(2000)).toBe(100);
});

it('shippingFee below 5000', () => {
  expect(shippingFee(4999)).toBe(500);
});

it('shippingFee at 5000', () => {
  expect(shippingFee(5000)).toBe(0);
});

it('shippingFee far above 5000', () => {
  expect(shippingFee(10000)).toBe(0);
});

it('loyaltyBonus below 300', () => {
  expect(loyaltyBonus(299)).toBe(0);
});

it('loyaltyBonus at 300', () => {
  expect(loyaltyBonus(300)).toBe(0);
});

it('loyaltyBonus far above 300', () => {
  expect(loyaltyBonus(600)).toBe(50);
});

it('seniorPrice below 65', () => {
  expect(seniorPrice(64)).toBe(1200);
});

it('seniorPrice at 65', () => {
  expect(seniorPrice(65)).toBe(800);
});

it('seniorPrice far above 65', () => {
  expect(seniorPrice(130)).toBe(800);
});

it('bulkUnitPrice below 100', () => {
  expect(bulkUnitPrice(99)).toBe(100);
});

it('bulkUnitPrice at 100', () => {
  expect(bulkUnitPrice(100)).toBe(90);
});

it('bulkUnitPrice far above 100', () => {
  expect(bulkUnitPrice(200)).toBe(90);
});
