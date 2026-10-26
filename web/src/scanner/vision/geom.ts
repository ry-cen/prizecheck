import type { Pt, Quad } from "../types";

const f32 = Math.fround;

/** Absolute shoelace area (cv2.contourArea with abs). */
export function contourArea(q: readonly Pt[]): number {
  let a = 0;
  const n = q.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * OpenCV isContourConvex: the cross product of consecutive edges must keep one sign.
 * A zero cross product (collinear or repeated points) makes OpenCV return false at once.
 */
export function isContourConvex(q: readonly Pt[]): boolean {
  const n = q.length;
  if (n < 3) return false;
  let orientation = 0;
  let prev = q[n - 2];
  let cur = q[n - 1];
  let dx0 = f32(cur[0] - prev[0]);
  let dy0 = f32(cur[1] - prev[1]);
  for (let i = 0; i < n; i++) {
    const pt = q[i];
    const dx = f32(pt[0] - cur[0]);
    const dy = f32(pt[1] - cur[1]);
    const dxdy0 = dx * dy0;
    const dydx0 = dy * dx0;
    orientation |= dydx0 > dxdy0 ? 1 : dydx0 < dxdy0 ? 2 : 3;
    if (orientation === 3) return false;
    dx0 = dx;
    dy0 = dy;
    prev = cur;
    cur = pt;
  }
  return true;
}

function norm32(dx: number, dy: number): number {
  return f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
}

/** Port of corners.order_quad, in float32 like numpy: TL, TR, BR, BL of the best portrait rotation. */
export function orderQuad(pts: readonly Pt[]): Quad {
  if (pts.length !== 4) throw new Error("orderQuad needs 4 points");
  const p: Pt[] = pts.map(([x, y]) => [f32(x), f32(y)]);
  const cx = f32(f32(f32(f32(p[0][0] + p[1][0]) + p[2][0]) + p[3][0]) / 4);
  const cy = f32(f32(f32(f32(p[0][1] + p[1][1]) + p[2][1]) + p[3][1]) / 4);
  const ang = p.map(([x, y]) => f32(Math.atan2(f32(y - cy), f32(x - cx))));
  const order = [0, 1, 2, 3].sort((a, b) =>
    ang[a] < ang[b] ? -1 : ang[a] > ang[b] ? 1 : a - b
  );
  const s = order.map((i) => p[i]);
  const rots: Pt[][] = [0, 1, 2, 3].map((i) =>
    [0, 1, 2, 3].map((j) => s[(j + i) % 4])
  );
  const edges = (q: Pt[]) =>
    [0, 1, 2, 3].map((i) =>
      norm32(f32(q[(i + 1) % 4][0] - q[i][0]), f32(q[(i + 1) % 4][1] - q[i][1]))
    );
  let keep = rots.filter((q) => {
    const e = edges(q);
    return (e[0] + e[2]) / 2 < (e[1] + e[3]) / 2;
  });
  if (keep.length === 0) keep = rots;
  let best = keep[0];
  let bestKey = f32(f32(best[0][1] + best[1][1]) / 2);
  for (let i = 1; i < keep.length; i++) {
    const k = f32(f32(keep[i][0][1] + keep[i][1][1]) / 2);
    if (k < bestKey) {
      best = keep[i];
      bestKey = k;
    }
  }
  return [best[0], best[1], best[2], best[3]].map(
    ([x, y]) => [x, y] as Pt
  ) as Quad;
}

/** cv2.fitLine(DIST_L2): direction (unit) and a point on the line, single-pass moments as OpenCV. */
export function fitLineL2(
  pts: readonly Pt[]
): [vx: number, vy: number, x0: number, y0: number] {
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x0, y0] of pts) {
    const x = f32(x0);
    const y = f32(y0);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const mx = sx / n;
  const my = sy / n;
  const dxx = sxx / n - mx * mx;
  const dyy = syy / n - my * my;
  const dxy = sxy / n - mx * my;
  const t = f32(Math.atan2(2 * dxy, dxx - dyy)) / 2;
  return [f32(Math.cos(t)), f32(Math.sin(t)), f32(mx), f32(my)];
}

/** cv2.getPerspectiveTransform: 3x3 row-major forward matrix mapping src to dst, M[8] = 1. */
export function perspectiveTransform(src: Quad, dst: Quad): Float64Array {
  const A: number[][] = [];
  const b: number[] = new Array(8).fill(0);
  for (let i = 0; i < 8; i++) A.push(new Array(8).fill(0));
  for (let i = 0; i < 4; i++) {
    const sx = f32(src[i][0]);
    const sy = f32(src[i][1]);
    const dx = f32(dst[i][0]);
    const dy = f32(dst[i][1]);
    A[i][0] = sx;
    A[i][1] = sy;
    A[i][2] = 1;
    A[i][6] = -sx * dx;
    A[i][7] = -sy * dx;
    A[i + 4][3] = sx;
    A[i + 4][4] = sy;
    A[i + 4][5] = 1;
    A[i + 4][6] = -sx * dy;
    A[i + 4][7] = -sy * dy;
    b[i] = dx;
    b[i + 4] = dy;
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) throw new Error("degenerate quad");
    if (piv !== c) {
      [A[piv], A[c]] = [A[c], A[piv]];
      [b[piv], b[c]] = [b[c], b[piv]];
    }
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(8).fill(0);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  const M = new Float64Array(9);
  for (let i = 0; i < 8; i++) M[i] = x[i];
  M[8] = 1;
  return M;
}
