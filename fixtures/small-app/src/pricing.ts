/** discountAmount */
export function discountAmount(total: number): number {
  return total >= 1000 ? 100 : 0;
}

/** shippingFee */
export function shippingFee(total: number): number {
  return total >= 5000 ? 0 : 500;
}

/** loyaltyBonus */
export function loyaltyBonus(points: number): number {
  return points > 300 ? 50 : 0;
}

/** seniorPrice */
export function seniorPrice(age: number): number {
  return age >= 65 ? 800 : 1200;
}

/** bulkUnitPrice */
export function bulkUnitPrice(quantity: number): number {
  return quantity >= 100 ? 90 : 100;
}
