import { expect, it } from 'vitest';
import { freeGiftCount, expressFee, studentDiscount, reviewReward, vipLevel } from '../src/loyalty.js';

it('freeGiftCount below 3000', () => {
  expect(freeGiftCount(2999)).toBe(0);
});

it('freeGiftCount at 3000', () => {
  expect(freeGiftCount(3000)).toBe(1);
});

it('freeGiftCount far above 3000', () => {
  expect(freeGiftCount(6000)).toBe(1);
});

it('expressFee below 50', () => {
  expect(expressFee(49)).toBe(300);
});

it('expressFee at 50', () => {
  expect(expressFee(50)).toBe(300);
});

it('expressFee far above 50', () => {
  expect(expressFee(100)).toBe(700);
});

it('studentDiscount below 18', () => {
  expect(studentDiscount(17)).toBe(200);
});

it('studentDiscount at 18', () => {
  expect(studentDiscount(18)).toBe(0);
});

it('studentDiscount far above 18', () => {
  expect(studentDiscount(36)).toBe(0);
});

it('reviewReward below 10', () => {
  expect(reviewReward(9)).toBe(0);
});

it('reviewReward at 10', () => {
  expect(reviewReward(10)).toBe(20);
});

it('reviewReward far above 10', () => {
  expect(reviewReward(20)).toBe(20);
});

it('vipLevel below 100000', () => {
  expect(vipLevel(99999)).toBe(1);
});

it('vipLevel at 100000', () => {
  expect(vipLevel(100000)).toBe(2);
});

it('vipLevel far above 100000', () => {
  expect(vipLevel(200000)).toBe(2);
});
