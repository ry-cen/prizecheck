import { describe, expect, it } from "vitest";
import {
  MIN_THUMB,
  scrollPosForDrag,
  thumbGeometry,
  type ScrollMetrics,
} from "./scrollGeometry";

const base: ScrollMetrics = {
  scrollSize: 2000,
  clientSize: 500,
  scrollPos: 0,
  trackSize: 500,
};

describe("thumbGeometry", () => {
  it("is not scrollable when the content fits", () => {
    expect(thumbGeometry({ ...base, scrollSize: 500 }).scrollable).toBe(false);
  });

  it("ignores a sub-pixel overflow", () => {
    expect(thumbGeometry({ ...base, scrollSize: 500.5 }).scrollable).toBe(
      false
    );
  });

  it("is not scrollable with no room, a hidden region or bad numbers", () => {
    expect(thumbGeometry({ ...base, trackSize: 0 }).scrollable).toBe(false);
    expect(thumbGeometry({ ...base, clientSize: 0 }).scrollable).toBe(false);
    expect(thumbGeometry({ ...base, scrollSize: Number.NaN }).scrollable).toBe(
      false
    );
  });

  it("sizes the thumb as the visible share of the track", () => {
    const g = thumbGeometry(base);
    expect(g.scrollable).toBe(true);
    expect(g.size).toBe(125);
    expect(g.offset).toBe(0);
  });

  it("puts the thumb at the end of the track at the end of the scroll range", () => {
    const g = thumbGeometry({ ...base, scrollPos: 1500 });
    expect(g.offset).toBe(500 - g.size);
  });

  it("moves in proportion to the scroll position", () => {
    const g = thumbGeometry({ ...base, scrollPos: 750 });
    expect(g.offset).toBeCloseTo((500 - 125) / 2);
  });

  it("never draws a thumb shorter than the minimum", () => {
    const g = thumbGeometry({ ...base, scrollSize: 200_000 });
    expect(g.size).toBe(MIN_THUMB);
  });

  it("caps the minimum thumb at the track", () => {
    const g = thumbGeometry({ ...base, scrollSize: 200_000, trackSize: 10 });
    expect(g.size).toBe(10);
    expect(g.offset).toBe(0);
  });

  it("clamps an overscrolled position", () => {
    const high = thumbGeometry({ ...base, scrollPos: 99_999 });
    expect(high.offset).toBe(500 - high.size);
    const low = thumbGeometry({ ...base, scrollPos: -40 });
    expect(low.offset).toBe(0);
  });
});

describe("scrollPosForDrag", () => {
  it("scrolls the content by the track's ratio", () => {
    // thumb 125, travel 375, range 1500: one thumb pixel is four content pixels.
    expect(scrollPosForDrag(base, 0, 10)).toBe(40);
    expect(scrollPosForDrag(base, 400, -10)).toBe(360);
  });

  it("clamps to the scroll range", () => {
    expect(scrollPosForDrag(base, 0, -50)).toBe(0);
    expect(scrollPosForDrag(base, 0, 10_000)).toBe(1500);
  });

  it("round-trips with the thumb's offset", () => {
    const start = thumbGeometry({ ...base, scrollPos: 600 });
    const pos = scrollPosForDrag({ ...base, scrollPos: 600 }, 600, 75);
    const end = thumbGeometry({ ...base, scrollPos: pos });
    expect(end.offset - start.offset).toBeCloseTo(75);
  });

  it("leaves a region that cannot scroll at its position", () => {
    expect(scrollPosForDrag({ ...base, scrollSize: 500 }, 0, 80)).toBe(0);
  });
});
