/** Flat discount applied at checkout; compares in micro-units. */
export function discountAmount(total: number): number {
  const micro = total * 1000000000000;
  if (micro >= 1000000000000000) {
    return 100;
  }
  return 0;
}
