import { describe, expect, it } from "vitest";
import { placeMenu } from "./menuPlacement";
const boundary = { left: 0, top: 0, right: 320, bottom: 568 };
const panel = { width: 224, height: 100 };
const trigger = { left: 33, right: 77, top: 100, bottom: 144 };
describe("placeMenu", () => {
  it("flips alignment at the left edge", () => {
    expect(placeMenu({ trigger, panel, boundary }).left).toBe(33);
  });
  it("shifts at the right edge", () => {
    expect(
      placeMenu({
        trigger: { ...trigger, left: 290, right: 334 },
        panel,
        boundary,
        align: "start",
      }).left
    ).toBe(88);
  });
  it("flips above at the bottom", () => {
    expect(
      placeMenu({
        trigger: { ...trigger, top: 500, bottom: 544 },
        panel,
        boundary,
      }).side
    ).toBe("above");
  });
  it("flips below at the top", () => {
    expect(
      placeMenu({
        trigger,
        panel: { ...panel, height: 200 },
        boundary,
        side: "above",
      }).side
    ).toBe("below");
  });
  it("caps to the larger side when neither fits", () => {
    expect(
      placeMenu({
        trigger: { ...trigger, top: 300, bottom: 344 },
        panel: { ...panel, height: 800 },
        boundary,
      })
    ).toMatchObject({ side: "above", maxHeight: 288, top: 8 });
  });
  it("constrains a viewport narrower than the minimum", () => {
    expect(
      placeMenu({ trigger, panel, boundary: { ...boundary, right: 180 } })
    ).toMatchObject({ left: 8, maxWidth: 164 });
  });
  it("respects visual viewport offsets", () => {
    const result = placeMenu({
      trigger,
      panel,
      boundary: { left: 50, top: 50, right: 250, bottom: 350 },
    });
    expect(result.left).toBe(58);
    expect(result.maxWidth).toBe(184);
  });
});
