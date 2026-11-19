/** Candidate fix for discountAmount that matches the README (total >= 1000). */
export function discountAmount(total: number): number {
  if (total >= 1000) {
    return 100;
  }
  return 0;
}
