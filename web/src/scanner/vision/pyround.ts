/** Round half to even, like Python round(), np.round, np.rint and OpenCV cvRound. Keeps the sign of -0. */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  let r: number;
  if (d < 0.5) r = f;
  else if (d > 0.5) r = f + 1;
  else r = f % 2 === 0 ? f : f + 1;
  if (r === 0 && (x < 0 || Object.is(x, -0))) return -0;
  return r;
}
