import { describe, expect, it } from "vitest";
import { compareTop, tieEps } from "./tieParity";
import type { Scored, TopSide } from "./tieParity";

const pool = (o: Record<string, number | null>): Scored[] =>
  Object.entries(o).map(([id, score]) => ({ id, score }));
const side = (
  top: string[],
  p: Record<string, number | null>,
  path = "image_only"
): TopSide => ({ path, top, pool: pool(p) });

describe("compareTop", () => {
  it("equal_top1", () => {
    expect(
      compareTop(
        1,
        side(["A", "B"], { A: 0.8 }),
        side(["A", "C"], { A: 0.8 }),
        0.995
      ).verdict
    ).toBe("equal");
  });
  it("equal_top3_reordered", () => {
    expect(
      compareTop(3, side(["A", "B", "C"], {}), side(["C", "A", "B"], {}), 0.995)
        .verdict
    ).toBe("equal");
  });
  it("top1_tie_within_eps", () => {
    const r = compareTop(
      1,
      side(["B", "A"], { B: 0.801, A: 0.799 }),
      side(["A", "B"], { A: 0.8, B: 0.795 }),
      0.999
    );
    expect(r.verdict).toBe("tie");
    expect(r.gap).toBeCloseTo(0.005, 6);
    expect(r.eps).toBeCloseTo(0.0549, 3);
  });
  it("top1_beyond_eps", () => {
    const r = compareTop(
      1,
      side(["B", "A"], { B: 0.801, A: 0.799 }),
      side(["A", "B"], { A: 0.8, B: 0.77 }),
      0.99999
    );
    expect(r.verdict).toBe("differs");
    expect(r.gap).toBeCloseTo(0.03, 6);
    expect(r.eps as number).toBeLessThan(0.01);
  });
  it("non_image_path_differs", () => {
    const r = compareTop(
      1,
      side(["B", "A"], { B: 0.801, A: 0.799 }),
      side(["A", "B"], { A: 0.8, B: 0.795 }, "both"),
      0.995
    );
    expect(r).toEqual({ verdict: "differs", gap: null, eps: null });
  });
  it("missing_from_pool_differs", () => {
    expect(
      compareTop(
        1,
        side(["B", "A"], { B: 0.801, A: 0.799 }),
        side(["A"], { A: 0.8 }),
        0.995
      ).verdict
    ).toBe("differs");
  });
  it("top3_rank3_swap_tie", () => {
    const ts = side(["A", "B", "D"], { A: 0.9, B: 0.8, C: 0.7, D: 0.702 });
    const py = side(["A", "B", "C"], { A: 0.9, B: 0.8, C: 0.7, D: 0.695 });
    expect(compareTop(3, ts, py, 0.999).verdict).toBe("tie");
  });
  it("short_list_differs", () => {
    expect(
      compareTop(
        3,
        side(["A"], { A: 0.9 }),
        side(["A", "B", "C"], { A: 0.9 }),
        0.995
      ).verdict
    ).toBe("differs");
  });
  it("null_score_differs", () => {
    const r = compareTop(
      1,
      side(["B"], { B: 0.801, A: 0.799 }),
      side(["A"], { A: null, B: 0.795 }),
      0.995
    );
    expect(r.verdict).toBe("differs");
  });
  it("tieEps_values", () => {
    expect(tieEps(1, 0.8)).toBeCloseTo(1e-4, 6);
    expect(tieEps(0.995, 0.6)).toBeCloseTo(0.1617, 4);
    expect(tieEps(0.99, 0)).toBeCloseTo(0.28577, 4);
    expect(tieEps(0.99, 1.2)).toBe(1e-4);
  });
});
