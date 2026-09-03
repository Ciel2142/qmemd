/** Wilson score 95% interval for a binomial proportion (z=1.96). Correct at small n and near
 *  0/1 where the normal approximation breaks. Methodology §3.1: a bare proportion is not a
 *  permitted output — every reported proportion ships with this CI. n=0 → full [0,1]. */
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}
