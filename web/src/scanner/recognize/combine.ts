// Port of scanspike/combine.py.
import { COMBINE } from "./constants";
import { cmpStr } from "./types";
import type { Candidate, CombineConfig, CombinePath } from "./types";

export type { CombineConfig, CombinePath };

/** Keep the order `lookup` returned (tier desc, release desc, id), truncated. */
export function rankOcrOnly(
  ocr: readonly Candidate[],
  cfg: CombineConfig = COMBINE
): Candidate[] {
  return ocr.slice(0, cfg.maxOut);
}

/** Sort by key ascending, then release newest first ('' last), then id ascending (three stable passes). */
function releaseOrder(
  cands: readonly Candidate[],
  key: (c: Candidate) => number,
  release: Map<string, string>
): Candidate[] {
  const out = [...cands].sort((a, b) => cmpStr(a.id, b.id));
  out.sort((a, b) => cmpStr(release.get(b.id) ?? "", release.get(a.id) ?? ""));
  out.sort((a, b) => {
    const ka = key(a),
      kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

export function combine(
  ocr: readonly Candidate[],
  imageTop: readonly Candidate[] | null,
  simOf: Map<string, number>,
  release: Map<string, string>,
  cfg: CombineConfig = COMBINE
): { ranked: Candidate[]; path: CombinePath } {
  if (ocr.length === 0 && imageTop === null)
    return { ranked: [], path: "none" };
  if (ocr.length === 0)
    return {
      ranked: (imageTop as readonly Candidate[]).slice(0, cfg.maxOut),
      path: "image_only",
    };
  let best = -Infinity;
  for (const c of ocr) if (c.tier > best) best = c.tier;
  const bestC = ocr.filter((c) => c.tier === best);
  if (imageTop === null)
    return { ranked: bestC.slice(0, cfg.maxOut), path: "ocr_only" };
  const top =
    imageTop.length > 0 ? (imageTop[0].score ?? -Infinity) : -Infinity;
  // Distrust test: at tier >= 2 a no-art member exempts it; at tier 1 test the art-bearing members only.
  const pool = best >= 2 ? bestC : bestC.filter((c) => simOf.has(c.id));
  if (pool.length > 0 && pool.every((c) => simOf.has(c.id))) {
    let mx = -Infinity;
    for (const c of pool) mx = Math.max(mx, simOf.get(c.id) as number);
    if (mx < top - cfg.distrustMargin) {
      if (best === 1 || !cfg.verifiedHedge)
        return { ranked: imageTop.slice(0, cfg.maxOut), path: "distrusted" };
      const cSorted = releaseOrder(
        bestC,
        (c) => -(simOf.get(c.id) as number),
        release
      );
      const heads: Candidate[] = cSorted.map((c) => ({
        id: c.id,
        source: "both",
        tier: c.tier,
        score: simOf.get(c.id) as number,
      }));
      let seq: Candidate[];
      let path: CombinePath;
      if (top >= cfg.imageSure) {
        seq = [imageTop[0], ...heads, ...imageTop.slice(1)];
        path = "verified_image";
      } else {
        seq = [heads[0], imageTop[0], ...heads.slice(1), ...imageTop.slice(1)];
        path = "verified_ocr";
      }
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const c of seq) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
      return { ranked: out.slice(0, cfg.maxOut), path };
    }
  }

  const ordered = releaseOrder(
    bestC,
    (c) => -(simOf.get(c.id) ?? cfg.noArtSim),
    release
  );
  const head: Candidate[] = ordered.map((c) => ({
    id: c.id,
    source: "both",
    tier: c.tier,
    score: simOf.get(c.id) ?? null,
  }));
  const inHead = new Set(bestC.map((c) => c.id));
  const tail = imageTop.filter((h) => !inHead.has(h.id));
  return { ranked: [...head, ...tail].slice(0, cfg.maxOut), path: "both" };
}
