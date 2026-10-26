import { describe, expect, it } from "vitest";
import { combine, rankOcrOnly } from "./combine";
import { COMBINE } from "./constants";
import { releaseOf } from "./cardTable";
import { f32, loadLogic, loadSubsetTable } from "../fixtures/recognizeUtil";
import type { Candidate, CombineConfig } from "./types";

// scanspike CombineConfig dataclass defaults (the Python unit tests use these, not the tuned values).
const PY: CombineConfig = {
  noArtSim: 0.5,
  distrustMargin: 0.15,
  maxOut: 10,
  verifiedHedge: true,
  imageSure: 0.85,
};
const oc = (id: string, tier = 3): Candidate => ({
  id,
  source: "ocr",
  tier,
  score: null,
});
const im = (id: string, s: number): Candidate => ({
  id,
  source: "image",
  tier: 0,
  score: s,
});
const ids = (o: Candidate[]) => o.map((c) => c.id);
const sim = (o: Record<string, number>) => new Map(Object.entries(o));
const noRel = new Map<string, string>();

describe("port of tests/test_combine.py", () => {
  it("image_only_when_no_ocr", () => {
    const img = [im("a", 0.9), im("b", 0.8)];
    const r = combine([], img, new Map(), noRel, PY);
    expect(r.path).toBe("image_only");
    expect(r.ranked).toEqual(img);
  });
  it("ocr_only_when_no_image", () => {
    const r = combine(
      [oc("a", 3), oc("b", 3), oc("c", 1)],
      null,
      new Map(),
      noRel,
      PY
    );
    expect(r.path).toBe("ocr_only");
    expect(ids(r.ranked)).toEqual(["a", "b"]);
  });
  it("both_orders_by_similarity", () => {
    const r = combine(
      [oc("a"), oc("b")],
      [im("b", 0.9), im("a", 0.85)],
      sim({ a: 0.85, b: 0.9 }),
      noRel,
      PY
    );
    expect(r.path).toBe("both");
    expect(ids(r.ranked)).toEqual(["b", "a"]);
    expect(r.ranked[0].source).toBe("both");
    expect(r.ranked[0].score).toBe(0.9);
  });
  it("no_art_candidate_uses_no_art_sim", () => {
    const ocr = [oc("art"), oc("noart")];
    const img = [im("art", 0.4)];
    let r = combine(ocr, img, sim({ art: 0.4 }), noRel, {
      ...PY,
      noArtSim: 0.5,
    });
    expect(r.ranked[0].id).toBe("noart");
    expect(r.ranked[0].score).toBeNull();
    r = combine(ocr, img, sim({ art: 0.4 }), noRel, { ...PY, noArtSim: 0.3 });
    expect(r.ranked[0].id).toBe("art");
  });
  it("distrust_falls_back_to_image", () => {
    let r = combine(
      [oc("a", 1)],
      [im("x", 0.95), im("a", 0.5)],
      sim({ a: 0.5 }),
      noRel,
      PY
    );
    expect(r.path).toBe("distrusted");
    expect(ids(r.ranked)).toEqual(["x", "a"]);
    r = combine([oc("a", 1)], [im("x", 0.75)], sim({ a: 0.5 }), noRel, {
      ...PY,
      distrustMargin: 0.25,
    });
    expect(r.path).toBe("both");
  });
  it("no_distrust_when_any_candidate_lacks_art_at_tier_2", () => {
    const r = combine(
      [oc("a", 2), oc("noart", 2)],
      [im("x", 0.95)],
      sim({ a: 0.1 }),
      noRel,
      PY
    );
    expect(r.path).toBe("both");
    expect(ids(r.ranked)).toContain("x");
  });
  it("tier_1 distrust ignores no-art members; only-no-art is not distrusted; close art member is trusted", () => {
    let r = combine(
      [oc("a", 1), oc("noart", 1)],
      [im("x", 0.95), im("a", 0.1)],
      sim({ a: 0.1 }),
      noRel,
      PY
    );
    expect(r.path).toBe("distrusted");
    expect(ids(r.ranked)).toEqual(["x", "a"]);
    expect(
      combine([oc("noart", 1)], [im("x", 0.95)], new Map(), noRel, PY).path
    ).toBe("both");
    r = combine(
      [oc("a", 1), oc("noart", 1)],
      [im("x", 0.95), im("a", 0.9)],
      sim({ a: 0.9 }),
      noRel,
      PY
    );
    expect(r.path).toBe("both");
  });
  it("only_best_tier_in_head", () => {
    const r = combine(
      [oc("hi", 3), oc("lo", 1)],
      [im("lo", 0.99), im("hi", 0.9)],
      sim({ hi: 0.9, lo: 0.99 }),
      noRel,
      PY
    );
    expect(r.path).toBe("both");
    expect(ids(r.ranked)).toEqual(["hi", "lo"]);
    expect(r.ranked[1].source).toBe("image");
  });
  it("tail_dedup_and_truncation", () => {
    const img = [
      im("a", 0.9),
      ...Array.from({ length: 20 }, (_, k) => im(`i${k}`, 0.8 - k / 100)),
    ];
    const out = ids(
      combine([oc("a")], img, sim({ a: 0.9 }), noRel, { ...PY, maxOut: 5 })
        .ranked
    );
    expect(out.length).toBe(5);
    expect(new Set(out).size).toBe(5);
    expect(out[0]).toBe("a");
  });
  it("ties_break_by_release_then_id", () => {
    const rel = new Map([
      ["a", "2020-01-01"],
      ["b", "2020-01-01"],
      ["c", "2023-01-01"],
      ["d", ""],
    ]);
    const r = combine(
      [oc("b"), oc("a"), oc("c"), oc("d")],
      [im("z", 0.5)],
      sim({ a: 0.5, b: 0.5, c: 0.5, d: 0.5 }),
      rel,
      PY
    );
    expect(ids(r.ranked).slice(0, 4)).toEqual(["c", "a", "b", "d"]);
  });
  it("none_when_both_missing; rank_ocr_only truncates; empty image list is not null", () => {
    expect(combine([], null, new Map(), noRel, PY)).toEqual({
      ranked: [],
      path: "none",
    });
    expect(combine([], [], new Map(), noRel, PY)).toEqual({
      ranked: [],
      path: "image_only",
    });
    expect(
      ids(
        rankOcrOnly(
          Array.from({ length: 30 }, (_, i) => oc(String(i))),
          PY
        )
      )
    ).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
    expect(combine([oc("a")], [], new Map(), noRel, PY).path).toBe("both");
  });
  it("verified paths", () => {
    const ocr = [oc("a", 2), oc("b", 2)];
    const s = sim({ a: 0.5, b: 0.4 });
    let r = combine(
      ocr,
      [im("x", 0.95), im("y", 0.9), im("a", 0.5)],
      s,
      noRel,
      { ...PY, imageSure: 0.9 }
    );
    expect([r.path, ids(r.ranked)]).toEqual([
      "verified_image",
      ["x", "a", "b", "y"],
    ]);
    r = combine(ocr, [im("x", 0.8), im("y", 0.7), im("a", 0.5)], s, noRel, {
      ...PY,
      imageSure: 0.85,
    });
    expect([r.path, ids(r.ranked)]).toEqual([
      "verified_ocr",
      ["a", "x", "b", "y"],
    ]);
    r = combine([oc("s", 3)], [im("x", 0.95)], sim({ s: 0.1 }), noRel, {
      ...PY,
      imageSure: 0.85,
    });
    expect([r.path, ids(r.ranked)]).toEqual(["verified_image", ["x", "s"]]);
    r = combine(ocr, [im("x", 0.95), im("y", 0.9), im("a", 0.5)], s, noRel, {
      ...PY,
      imageSure: 0.9,
      verifiedHedge: false,
    });
    expect([r.path, ids(r.ranked)]).toEqual(["distrusted", ["x", "y", "a"]]);
    const img = [
      im("x", 0.95),
      im("a", 0.5),
      im("b", 0.4),
      im("y", 0.3),
      im("z", 0.2),
    ];
    r = combine(ocr, img, s, noRel, { ...PY, imageSure: 0.9 });
    expect([r.path, ids(r.ranked)]).toEqual([
      "verified_image",
      ["x", "a", "b", "y", "z"],
    ]);
    r = combine(ocr, img, s, noRel, { ...PY, imageSure: 0.9, maxOut: 3 });
    expect(ids(r.ranked)).toEqual(["x", "a", "b"]);
  });
  it("COMBINE holds the tuned values", () => {
    expect(COMBINE).toEqual({
      noArtSim: 0.7,
      distrustMargin: 0.05,
      maxOut: 10,
      verifiedHedge: true,
      imageSure: 0.85,
    });
  });
});

describe("parity with the Python reference", () => {
  it("all 400 logic.combine cases are exact", async () => {
    const logic = loadLogic();
    const db = await loadSubsetTable();
    const scores = f32("logic/combine-scores.f32");
    const release = new Map(
      db.ids.map((id, row) => [id, releaseOf(db, row)] as const)
    );
    expect(logic.combine.length).toBe(400);
    const paths = new Set<string>();
    for (const [i, c] of logic.combine.entries()) {
      const ocr: Candidate[] = c.ocr.map(([row, tier]) =>
        oc(db.ids[row], tier)
      );
      const top: Candidate[] | null =
        c.top === null
          ? null
          : c.top.map((row, k) => im(db.ids[row], scores[c.topOff + k]));
      const simOf = new Map(
        c.sim.map((row, k) => [db.ids[row], scores[c.simOff + k]] as const)
      );
      const got = combine(ocr, top, simOf, release, COMBINE);
      expect(got.path, `case ${i} path`).toBe(c.path);
      expect(ids(got.ranked), `case ${i} ids`).toEqual(
        c.ranked.map((row) => db.ids[row])
      );
      paths.add(got.path);
    }
    expect(paths.size).toBe(7);
  });
});
