import { describe, expect, it } from "vitest";
import {
  CARD_ASPECT,
  GUIDE_EXPAND,
  expandGuide,
  guideQuad,
  guideRect,
} from "./guide";

// Ports tests/test_guide.py. test_synth_dir_tiers tests scanspike.paths and has no TS counterpart.
describe("guide", () => {
  it("guideRect 720x960", () => {
    const [x0, y0, x1, y1] = guideRect(720, 960);
    expect(Math.abs(y1 - y0 - 768)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(x1 - x0 - 549.82)).toBeLessThanOrEqual(0.01);
    expect(Math.abs((x0 + x1) / 2 - 360)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs((y0 + y1) / 2 - 480)).toBeLessThanOrEqual(1e-6);
  });

  it.each([
    [720, 960],
    [1080, 1440],
    [1080, 1920],
    [1000, 800],
  ])("guideRect aspect and inside %ix%i", (w, h) => {
    const [x0, y0, x1, y1] = guideRect(w, h);
    expect(Math.abs((x1 - x0) / (y1 - y0) - CARD_ASPECT)).toBeLessThan(1e-6);
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(w);
    expect(y1).toBeLessThanOrEqual(h);
    expect(x1 - x0).toBeLessThanOrEqual(0.86 * w + 1e-6);
  });

  it("guideQuad order and float32 coordinates", () => {
    const q = guideQuad([10, 20, 110, 160]);
    expect(q).toEqual([
      [10, 20],
      [110, 20],
      [110, 160],
      [10, 160],
    ]);
    const f = guideQuad([85.09090909090907, 96, 634.909090909091, 864]);
    for (const p of f) for (const v of p) expect(v).toBe(Math.fround(v));
  });

  it("GUIDE_EXPAND is the contract value", () => {
    expect(GUIDE_EXPAND).toBe(0.25);
  });

  it("expandGuide inside the frame, floor and ceil directions", () => {
    // guideRect(720, 960) = (85.09.., 96, 634.90.., 864); frac 0.05 -> 57.6/902.4 vertically, 57.6/662.4 -> 57/663
    expect(expandGuide(guideRect(720, 960), 0.05, 720, 960)).toEqual([
      57, 57, 606, 846,
    ]);
  });

  it("expandGuide clips to the frame", () => {
    expect(expandGuide(guideRect(720, 960), GUIDE_EXPAND, 720, 960)).toEqual([
      0, 0, 720, 960,
    ]);
    expect(expandGuide(guideRect(1000, 800), GUIDE_EXPAND, 1000, 800)).toEqual([
      156, 0, 688, 800,
    ]);
  });

  it("expandGuide on a 1080x1920 frame", () => {
    // width-capped guide; the 25% expansion overruns both axes, so the whole frame is returned
    expect(
      expandGuide(guideRect(1080, 1920), GUIDE_EXPAND, 1080, 1920)
    ).toEqual([0, 0, 1080, 1920]);
  });
});
