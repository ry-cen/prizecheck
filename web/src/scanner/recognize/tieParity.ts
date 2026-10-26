// Noise-bounded top-k comparison between the TS pipeline and the Python reference (Amendment A-S3b).
// Pure: no harness and no onnxruntime imports.
export const COS_MIN = 0.99;
/** Upper bound on how far embedding noise (query cosine `cos`) can swing a score gap between rows scoring >= sMin. */
export function tieEps(cos: number, sMin: number): number {
  const dq = Math.sqrt(Math.max(0, 2 * (1 - cos)));
  const s = Math.min(1, Math.max(0, sMin));
  return 1.01 * dq * 2 * Math.sqrt(1 - s * s) + 1e-4;
}
export type Scored = { id: string; score: number | null };
export type TopSide = {
  path: string;
  top: readonly string[];
  pool: readonly Scored[];
};
export type TopCompare = {
  verdict: "equal" | "tie" | "differs";
  gap: number | null;
  eps: number | null;
};

const scoreIn = (pool: readonly Scored[], id: string): number | null =>
  pool.find((s) => s.id === id)?.score ?? null;

export function compareTop(
  k: 1 | 3,
  ts: TopSide,
  py: TopSide,
  cos: number
): TopCompare {
  const a = ts.top.slice(0, k);
  const b = py.top.slice(0, k);
  const inA = new Set(a);
  const inB = new Set(b);
  if (
    a.length === b.length &&
    a.every((x) => inB.has(x)) &&
    b.every((y) => inA.has(y))
  )
    return { verdict: "equal", gap: 0, eps: null };
  if (
    a.length < k ||
    b.length < k ||
    ts.path !== "image_only" ||
    py.path !== "image_only"
  )
    return { verdict: "differs", gap: null, eps: null };
  const floorTs = scoreIn(ts.pool, a[k - 1]);
  const floorPy = scoreIn(py.pool, b[k - 1]);
  if (floorTs === null || floorPy === null)
    return { verdict: "differs", gap: null, eps: null };
  let gap = 0;
  const pyScores: number[] = [floorPy];
  for (const x of a) {
    if (inB.has(x)) continue;
    const s = scoreIn(py.pool, x);
    if (s === null) return { verdict: "differs", gap: null, eps: null };
    pyScores.push(s);
    gap = Math.max(gap, floorPy - s);
  }
  for (const y of b) {
    if (inA.has(y)) continue;
    const s = scoreIn(ts.pool, y);
    const sPy = scoreIn(py.pool, y);
    if (s === null || sPy === null)
      return { verdict: "differs", gap: null, eps: null };
    pyScores.push(sPy);
    gap = Math.max(gap, floorTs - s);
  }
  const eps = tieEps(cos, Math.min(...pyScores));
  return { verdict: gap <= eps ? "tie" : "differs", gap, eps };
}
