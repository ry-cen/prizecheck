// Look-alike Printings (plumbing resolution, D15): the other Printings of a card's Reprint Group whose fingerprint is close to
// its own. Computed on the device from the card table's `group` column and the int8 fingerprints, at lock time.
import { releaseOf } from "./cardTable";
import { LOOKALIKE } from "./constants";
import { cmpStr } from "./types";
import type { CardDb, Pcfp } from "./types";

/** Group ordinal to its card ids in table order, only for groups of two or more ids. */
export function groupMembers(db: CardDb): Map<number, string[]> {
  const all = new Map<number, string[]>();
  const groups = db.groups;
  if (!groups) return all;
  for (let i = 0; i < db.ids.length; i++) {
    const g = groups[i];
    if (g === null || g === undefined) continue;
    const list = all.get(g);
    if (list) list.push(db.ids[i]);
    else all.set(g, [db.ids[i]]);
  }
  for (const [g, ids] of all) if (ids.length < 2) all.delete(g);
  return all;
}

/** Cosine of two fingerprint rows on the raw int8 values (the scale cancels). 0 when either row is all zero. */
export function cosineRows(fp: Pcfp, a: number, b: number): number {
  const d = fp.dim;
  const q = fp.q;
  const ba = a * d;
  const bb = b * d;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let j = 0; j < d; j++) {
    const x = q[ba + j];
    const y = q[bb + j];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * The look-alikes of `id`: every other member of its Reprint Group that has a fingerprint and a cosine of at least
 * `minCosine`, closest first (then newer release, then id). Not capped: the caller narrows by the printed number first.
 */
export function lookalikesOf(
  id: string,
  data: {
    db: CardDb;
    groups: Map<number, string[]>;
    fp: Pcfp | null;
    fpRows: Map<string, number> | null;
  },
  minCosine: number = LOOKALIKE.minCosine
): string[] {
  const { db, groups, fp, fpRows } = data;
  if (!fp || !fpRows || !db.groups) return [];
  const own = fpRows.get(id);
  const row = db.rowOf.get(id);
  if (own === undefined || row === undefined) return [];
  const g = db.groups[row];
  if (g === null || g === undefined) return [];
  const scored: { id: string; cos: number; release: string }[] = [];
  for (const other of groups.get(g) ?? []) {
    if (other === id) continue;
    const r = fpRows.get(other);
    const otherRow = db.rowOf.get(other);
    if (r === undefined || otherRow === undefined) continue;
    const cos = cosineRows(fp, own, r);
    if (cos >= minCosine)
      scored.push({ id: other, cos, release: releaseOf(db, otherRow) });
  }
  scored.sort(
    (a, b) =>
      b.cos - a.cos || cmpStr(b.release, a.release) || cmpStr(a.id, b.id)
  );
  return scored.map((s) => s.id);
}
