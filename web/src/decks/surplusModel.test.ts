import { describe, expect, it } from "vitest";
import { stagedText } from "./surplusModel";

describe("stagedText", () => {
  it("counts the cards staged so far across batches", () => {
    expect(stagedText(500, 1200, 500)).toBe("Prepared 500 of 1,200 cards…");
    expect(stagedText(1000, 1200, 500)).toBe("Prepared 1,000 of 1,200 cards…");
  });

  it("says nothing after the last batch or for a list that fits in one", () => {
    expect(stagedText(1500, 1200, 500)).toBeNull();
    expect(stagedText(500, 500, 500)).toBeNull();
    expect(stagedText(500, 501, 500)).not.toBeNull();
    expect(stagedText(3, 3, 500)).toBeNull();
  });
});
