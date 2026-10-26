// Port of the shipped guided corner finder: scanspike/corners.py find_card_guided with the default config
// (rim_walk = False), which runs _find_card_guided_outermost. The rim-walk code and find_card are not ported.
import type { Img, Pt, Quad, Rect } from "../types";
import { toLab } from "./color";
import { gaussian5, sobel3 } from "./filter";
import { contourArea, fitLineL2, isContourConvex, orderQuad } from "./geom";
import { roundHalfEven } from "./pyround";
import { resize } from "./resize";

const f32 = Math.fround;

// constants copied from corners.py:139-166
const GUIDE_AREA_RATIO: readonly [number, number] = [0.5, 1.3];
const GUIDE_CORNER_TOL = 0.35; // x guide height
const GUIDE_SIDE_ANGLE_MAX = 20.0;
const GUIDED_WORK_H = 512;
const GUIDED_IN = 0.24;
const GUIDED_OUT = 0.18;
const GUIDED_TRIM = 0.1;
const GUIDED_SCANLINES = 32;
const GUIDED_MAX_PEAKS = 6;
const GUIDED_REL_MIN = 0.25;
const GUIDED_MIN_GRAD = 40.0;
const GUIDED_MIN_INLIERS = 16;
const GUIDED_SUPPORT_REL = 0.75;
const GUIDED_RESID_PX = 3.0;

const DEG = 180 / Math.PI;

/** numpy.linspace(a, b, n) with endpoint: i*step + a, last element exactly b. */
function linspace(a: number, b: number, n: number): number[] {
  const step = (b - a) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i * step + a);
  out[n - 1] = b;
  return out;
}

function median(v: number[]): number {
  const s = Float64Array.from(v).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const clip = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function normF32(dx: number, dy: number): number {
  return f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
}

/** corners.plausible */
function plausible(quad: readonly Pt[], h: number, w: number): boolean {
  const q = orderQuad(quad);
  if (Math.abs(contourArea(q)) < 0.08 * h * w) return false;
  if (!isContourConvex(q)) return false;
  const e = [0, 1, 2, 3].map((i) =>
    normF32(f32(q[(i + 1) % 4][0] - q[i][0]), f32(q[(i + 1) % 4][1] - q[i][1]))
  );
  const a = (e[0] + e[2]) / 2;
  const b = (e[1] + e[3]) / 2;
  if (Math.min(a, b) <= 0) return false;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (!(ratio >= 1.0 && ratio <= 2.0)) return false;
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const v1x = f32(p[0] - c[0]);
    const v1y = f32(p[1] - c[1]);
    const v2x = f32(n[0] - c[0]);
    const v2y = f32(n[1] - c[1]);
    const cosang =
      (v1x * v2x + v1y * v2y) / (normF32(v1x, v1y) * normF32(v2x, v2y) + 1e-9);
    const deg = Math.acos(clip(cosang, -1, 1)) * DEG;
    if (!(deg >= 40 && deg <= 140)) return false;
  }
  return true;
}

/** corners.guide_ok */
function guideOk(quad: readonly Pt[], guide: Rect): boolean {
  const [x0, y0, x1, y1] = guide;
  const gq: Pt[] = [
    [f32(x0), f32(y0)],
    [f32(x1), f32(y0)],
    [f32(x1), f32(y1)],
    [f32(x0), f32(y1)],
  ];
  const gh = y1 - y0;
  const q = orderQuad(quad);
  const ratio = Math.abs(contourArea(q)) / Math.max(1e-9, (x1 - x0) * gh);
  if (!(ratio >= GUIDE_AREA_RATIO[0] && ratio <= GUIDE_AREA_RATIO[1]))
    return false;
  let worst = 0;
  for (let i = 0; i < 4; i++)
    worst = Math.max(
      worst,
      normF32(f32(q[i][0] - gq[i][0]), f32(q[i][1] - gq[i][1]))
    );
  if (worst > GUIDE_CORNER_TOL * gh) return false;
  for (let i = 0; i < 4; i++) {
    const ax = f32(q[(i + 1) % 4][0] - q[i][0]);
    const ay = f32(q[(i + 1) % 4][1] - q[i][1]);
    const bx = f32(gq[(i + 1) % 4][0] - gq[i][0]);
    const by = f32(gq[(i + 1) % 4][1] - gq[i][1]);
    const cosang =
      (ax * bx + ay * by) / (normF32(ax, ay) * normF32(bx, by) + 1e-9);
    if (Math.acos(clip(cosang, -1, 1)) * DEG > GUIDE_SIDE_ANGLE_MAX)
      return false;
  }
  return true;
}

/** Candidate peaks for one scanline, rows of (x, y, d, strength), flat. */
type Cands = Float64Array[];

/** corners._side_candidates. Returns null if no scanline has a candidate. */
function sideCandidates(
  grad: Float32Array,
  gw: number,
  gh: number,
  horizontal: boolean,
  fixedLo: number,
  fixedHi: number,
  edge: number,
  D: number,
  outward: number
): Cands | null {
  const dimAcross = horizontal ? gh : gw;
  const dimAlong = horizontal ? gw : gh;
  const n = Math.max(
    2,
    Math.trunc(roundHalfEven((GUIDED_OUT + GUIDED_IN) * D)) + 1
  );
  const offs = linspace(GUIDED_OUT * D, -GUIDED_IN * D, n); // outside -> inside
  const across = offs.map((o) =>
    clip(roundHalfEven(edge + outward * o), 1, dimAcross - 2)
  );
  // _scan_positions
  const span = fixedHi - fixedLo;
  const lo = fixedLo + GUIDED_TRIM * span;
  const hi = fixedHi - GUIDED_TRIM * span;
  const along = linspace(lo, hi, GUIDED_SCANLINES).map((v) =>
    clip(roundHalfEven(v), 1, dimAlong - 2)
  );
  const out: Cands = [];
  let any = false;
  const p = new Float64Array(n);
  for (const a of along) {
    for (let k = 0; k < n; k++)
      p[k] = horizontal ? grad[across[k] * gw + a] : grad[a * gw + across[k]];
    const idx: number[] = [];
    for (let i = 1; i < n - 1; i++) {
      if (p[i] >= p[i - 1] && p[i] >= p[i + 1] && p[i] >= GUIDED_MIN_GRAD)
        idx.push(i);
    }
    idx.sort((i, j) => (p[i] > p[j] ? -1 : p[i] < p[j] ? 1 : i - j)); // strongest first; ties go to the outer one
    const take = idx.slice(0, GUIDED_MAX_PEAKS);
    const rows = new Float64Array(take.length * 4);
    take.forEach((i, r) => {
      const c = across[i];
      rows[r * 4] = horizontal ? a : c;
      rows[r * 4 + 1] = horizontal ? c : a;
      rows[r * 4 + 2] = -offs[i];
      rows[r * 4 + 3] = p[i];
    });
    if (take.length) any = true;
    out.push(rows);
  }
  return any ? out : null;
}

type Hyp = {
  K: number;
  n: number;
  X: Float64Array;
  Y: Float64Array;
  best: Int32Array; // [hypothesis * n + scanline] -> candidate slot
  inl: Uint8Array;
  support: Int32Array;
  bestSup: number;
  dMid: Float64Array;
  strength: Float64Array;
  gen: Int32Array;
  count: number;
};

/** corners._side_hypotheses */
function sideHypotheses(cands: Cands, horizontal: boolean): Hyp | null {
  const n = cands.length;
  const h = n >> 1;
  const K = GUIDED_MAX_PEAKS;
  if (h === 0) return null;
  const X = new Float64Array(n * K);
  const Y = new Float64Array(n * K);
  const S = new Float64Array(n * K);
  const cnt = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    const m = Math.min(K, c.length / 4);
    cnt[i] = m;
    for (let r = 0; r < m; r++) {
      X[i * K + r] = c[r * 4];
      Y[i * K + r] = c[r * 4 + 1];
      S[i * K + r] = c[r * 4 + 3];
    }
  }
  const alongC = horizontal ? 0 : 1;
  const acrossC = horizontal ? 1 : 0;
  // all pair hypotheses that survive the length and angle filter
  const na: number[] = [];
  const nb: number[] = [];
  const nc: number[] = [];
  const genList: number[] = [];
  let pair = 0;
  for (let i = 0; i < h; i++) {
    for (let a = 0; a < cnt[i]; a++) {
      for (let b = 0; b < cnt[i + h]; b++, pair++) {
        const p1x = X[i * K + a];
        const p1y = Y[i * K + a];
        const vx = X[(i + h) * K + b] - p1x;
        const vy = Y[(i + h) * K + b] - p1y;
        const ln = Math.hypot(vx, vy);
        if (!(ln > 1e-9)) continue;
        const v = [vx, vy];
        const ang = Math.atan2(Math.abs(v[acrossC]), Math.abs(v[alongC])) * DEG;
        if (!(ang <= GUIDE_SIDE_ANGLE_MAX)) continue;
        const A = vy / ln;
        const B = -vx / ln;
        na.push(A);
        nb.push(B);
        nc.push(-(A * p1x + B * p1y));
        genList.push(pair);
      }
    }
  }
  const H = na.length;
  if (H === 0) return null;
  const best = new Int32Array(H * n);
  const inl = new Uint8Array(H * n);
  const support = new Int32Array(H);
  for (let j = 0; j < H; j++) {
    for (let k = 0; k < n; k++) {
      let bd = Infinity;
      let bm = 0;
      for (let m = 0; m < cnt[k]; m++) {
        const d = Math.abs(na[j] * X[k * K + m] + nb[j] * Y[k * K + m] + nc[j]);
        if (d < bd) {
          bd = d;
          bm = m;
        }
      }
      best[j * n + k] = bm;
      if (bd <= GUIDED_RESID_PX) {
        inl[j * n + k] = 1;
        support[j]++;
      }
    }
  }
  let bestSup = 0;
  for (let j = 0; j < H; j++) bestSup = Math.max(bestSup, support[j]);
  const keepMin = Math.max(
    GUIDED_MIN_INLIERS,
    Math.ceil(GUIDED_SUPPORT_REL * bestSup - 1e-9)
  );
  let anyKeep = false;
  for (let j = 0; j < H; j++) if (support[j] >= keepMin) anyKeep = true;
  if (!anyKeep) return null;
  const strength = new Float64Array(H).fill(-Infinity);
  const looseMin = Math.max(
    GUIDED_MIN_INLIERS,
    Math.ceil(0.5 * bestSup - 1e-9)
  ); // GUIDED_INNER_SUPPORT_REL
  for (let j = 0; j < H; j++) {
    if (support[j] < looseMin) continue;
    const vals: number[] = [];
    for (let k = 0; k < n; k++)
      if (inl[j * n + k]) vals.push(S[k * K + best[j * n + k]]);
    strength[j] = median(vals);
  }
  // inward offset d of each line at the midpoint of the along-span
  const dd: number[] = [];
  const aa: number[] = [];
  const cc: number[] = [];
  for (const c of cands) {
    for (let r = 0; r < c.length / 4; r++) {
      dd.push(c[r * 4 + 2]);
      aa.push(c[r * 4 + alongC]);
      cc.push(c[r * 4 + acrossC]);
    }
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const md = mean(dd);
  const mc = mean(cc);
  let cov = 0;
  for (let i = 0; i < dd.length; i++) cov += (dd[i] - md) * (cc[i] - mc);
  cov /= dd.length;
  const sigma = cov < -1e-9 ? -1.0 : 1.0;
  const beta = median(dd.map((d, i) => d - sigma * cc[i]));
  let amin = Infinity;
  let amax = -Infinity;
  for (const v of aa) {
    amin = Math.min(amin, v);
    amax = Math.max(amax, v);
  }
  const mid = 0.5 * (amin + amax);
  const dMid = new Float64Array(H);
  for (let j = 0; j < H; j++) {
    const acrossMid = horizontal
      ? -(na[j] * mid + nc[j]) / nb[j]
      : -(nb[j] * mid + nc[j]) / na[j];
    dMid[j] = sigma * acrossMid + beta;
  }
  return {
    K,
    n,
    X,
    Y,
    best,
    inl,
    support,
    bestSup,
    dMid,
    strength,
    gen: Int32Array.from(genList),
    count: H,
  };
}

/** corners._pick_outermost: index of the outermost well-supported, strong hypothesis (1 px tie window). */
function pickOutermost(h: Hyp): number | null {
  const keepMin = Math.max(
    GUIDED_MIN_INLIERS,
    Math.ceil(GUIDED_SUPPORT_REL * h.bestSup - 1e-9)
  );
  const keep: number[] = [];
  let smax = -Infinity;
  for (let j = 0; j < h.count; j++) {
    if (h.support[j] >= keepMin) {
      keep.push(j);
      smax = Math.max(smax, h.strength[j]);
    }
  }
  if (!keep.length) return null;
  const idx = keep.filter((j) => h.strength[j] >= GUIDED_REL_MIN * smax);
  let dmin = Infinity;
  for (const j of idx) dmin = Math.min(dmin, h.dMid[j]);
  const tied = idx.filter((j) => h.dMid[j] <= dmin + 1.0);
  let pick = tied[0];
  for (const t of tied.slice(1)) {
    const better =
      h.support[t] > h.support[pick] ||
      (h.support[t] === h.support[pick] &&
        (h.strength[t] > h.strength[pick] ||
          (h.strength[t] === h.strength[pick] && h.gen[t] < h.gen[pick])));
    if (better) pick = t;
  }
  return pick;
}

/** corners._refit: fitLine of the inliers (float32), as (a, b, c) with ax + by + c = 0. */
function refit(h: Hyp, j: number): [number, number, number] {
  const pts: Pt[] = [];
  for (let k = 0; k < h.n; k++) {
    if (h.inl[j * h.n + k]) {
      const m = h.best[j * h.n + k];
      pts.push([f32(h.X[k * h.K + m]), f32(h.Y[k * h.K + m])]);
    }
  }
  const [vx, vy, x0, y0] = fitLineL2(pts);
  return [vy, -vx, vx * y0 - vy * x0];
}

/** corners._fit_side_outermost */
function fitSideOutermost(
  c: Cands,
  horizontal: boolean
): [number, number, number] | null {
  const h = sideHypotheses(c, horizontal);
  if (!h) return null;
  const j = pickOutermost(h);
  if (j === null) return null;
  return refit(h, j);
}

function meet(l1: readonly number[], l2: readonly number[]): Pt | null {
  const p2 = l1[0] * l2[1] - l1[1] * l2[0];
  if (Math.abs(p2) < 1e-9) return null;
  const p0 = l1[1] * l2[2] - l1[2] * l2[1];
  const p1 = l1[2] * l2[0] - l1[0] * l2[2];
  return [p0 / p2, p1 / p2];
}

/**
 * The card quad (TL, TR, BR, BL in input pixels) near the guide, or null.
 * `src` is RGB or RGBA; `guide` is in src pixel coordinates (doubles).
 */
export function findCardGuided(src: Img, guide: Rect): Quad | null {
  const [x0, y0, x1, y1] = guide;
  const gh = y1 - y0;
  const w = src.width;
  const h = src.height;
  const s = GUIDED_WORK_H / gh;
  const small = resize(
    src,
    Math.max(1, Math.trunc(roundHalfEven(w * s))),
    Math.max(1, Math.trunc(roundHalfEven(h * s))),
    s < 1.0 ? "area" : "linear"
  );
  const sx0 = x0 * s;
  const sy0 = y0 * s;
  const sx1 = x1 * s;
  const sy1 = y1 * s;
  const sgh = sy1 - sy0;
  const sgw = sx1 - sx0;
  const lab = toLab(small);
  const W = small.width;
  const H = small.height;
  const n = W * H;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const plane = new Uint8Array(n);
    for (let i = 0; i < n; i++) plane[i] = lab.data[i * 3 + c];
    const blurred = gaussian5({
      width: W,
      height: H,
      channels: 1,
      data: plane,
    });
    const f = Float32Array.from(blurred.data);
    const dx = sobel3(f, W, H, 1, 0);
    const dy = sobel3(f, W, H, 0, 1);
    for (let i = 0; i < n; i++) {
      gx[i] = Math.max(gx[i], Math.abs(dx[i]));
      gy[i] = Math.max(gy[i], Math.abs(dy[i]));
    }
  }
  const top = sideCandidates(gy, W, H, true, sx0, sx1, sy0, sgh, -1);
  const bot = sideCandidates(gy, W, H, true, sx0, sx1, sy1, sgh, +1);
  const left = sideCandidates(gx, W, H, false, sy0, sy1, sx0, sgw, -1);
  const right = sideCandidates(gx, W, H, false, sy0, sy1, sx1, sgw, +1);
  if (!top || !bot || !left || !right) return null;
  const topL = fitSideOutermost(top, true);
  const leftL = fitSideOutermost(left, false);
  const botL = fitSideOutermost(bot, true);
  const rightL = fitSideOutermost(right, false);
  if (!topL || !leftL || !botL || !rightL) return null;
  const pts = [
    meet(topL, leftL),
    meet(topL, rightL),
    meet(botL, rightL),
    meet(botL, leftL),
  ];
  const quad: Pt[] = [];
  for (const p of pts) {
    if (!p) return null;
    const q: Pt = [f32(p[0] / s), f32(p[1] / s)];
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    quad.push(q);
  }
  if (plausible(quad, h, w) && guideOk(quad, guide)) return orderQuad(quad);
  return null;
}
