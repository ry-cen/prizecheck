// int8 PCFP scoring and search (scanspike/index.py search / sims_for, scanspike/g0_parity.py Int8Mat).
import { cmpStr } from "./types";
import type { Candidate, Pcfp } from "./types";

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const norm = Math.max(Math.sqrt(s), 1e-12);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** The one scoring formula, shared by scoreAll and simsFor: scale_i * fround(sum_j q_j * int8_ij), in float32. */
function rowScore(fp: Pcfp, row: number, q: Float32Array): number {
  const d = fp.dim;
  const m = fp.q;
  const base = row * d;
  let a0 = 0,
    a1 = 0,
    a2 = 0,
    a3 = 0;
  for (let j = 0; j < d; j += 4) {
    a0 += q[j] * m[base + j];
    a1 += q[j + 1] * m[base + j + 1];
    a2 += q[j + 2] * m[base + j + 2];
    a3 += q[j + 3] * m[base + j + 3];
  }
  const dot = Math.fround(a0 + a1 + a2 + a3);
  return Math.fround(fp.scale[row] * dot);
}

export function scoreAll(
  fp: Pcfp,
  q: Float32Array,
  out?: Float32Array
): Float32Array {
  const res = out ?? new Float32Array(fp.count);
  for (let i = 0; i < fp.count; i++) res[i] = rowScore(fp, i, q);
  return res;
}

/** Top k by (score descending, id ascending). Rows whose id fails `allowed` are skipped. */
export function topK(
  fp: Pcfp,
  scores: Float32Array,
  k: number,
  allowed?: (id: string) => boolean
): Candidate[] {
  const selRow: number[] = [];
  const before = (a: number, b: number): boolean =>
    scores[a] > scores[b] ||
    (scores[a] === scores[b] && cmpStr(fp.ids[a], fp.ids[b]) < 0);
  for (let i = 0; i < fp.count; i++) {
    if (k <= 0) break;
    if (allowed && !allowed(fp.ids[i])) continue;
    if (selRow.length === k && !before(i, selRow[k - 1])) continue;
    let lo = 0,
      hi = selRow.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(selRow[mid], i)) lo = mid + 1;
      else hi = mid;
    }
    selRow.splice(lo, 0, i);
    if (selRow.length > k) selRow.pop();
  }
  return selRow.map((r) => ({
    id: fp.ids[r],
    source: "image" as const,
    tier: 0,
    score: scores[r],
  }));
}

export function rowIndex(fp: Pcfp): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < fp.count; i++) m.set(fp.ids[i], i);
  return m;
}

export function simsFor(
  fp: Pcfp,
  rows: Map<string, number>,
  q: Float32Array,
  ids: readonly string[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    const r = rows.get(id);
    if (r !== undefined) out.set(id, rowScore(fp, r, q));
  }
  return out;
}
