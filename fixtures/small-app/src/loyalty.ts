/** freeGiftCount */
export function freeGiftCount(total: number): number {
  return total >= 3000 ? 1 : 0;
}

/** expressFee */
export function expressFee(distance: number): number {
  return distance > 50 ? 700 : 300;
}

/** studentDiscount */
export function studentDiscount(age: number): number {
  return age >= 18 ? 0 : 200;
}

/** reviewReward */
export function reviewReward(reviews: number): number {
  return reviews >= 10 ? 20 : 0;
}

/** vipLevel */
export function vipLevel(spent: number): number {
  return spent >= 100000 ? 2 : 1;
}
