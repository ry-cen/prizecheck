import { describe, expect, it } from "vitest";
import { readJson } from "../fixtures/read";
import { roundHalfEven } from "./pyround";

describe("roundHalfEven", () => {
  it("rounds halves to even", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(-0.5)).toBe(-0);
    expect(roundHalfEven(-1.5)).toBe(-2);
    expect(roundHalfEven(-2.5)).toBe(-2);
    expect(roundHalfEven(3.4999)).toBe(3);
    expect(roundHalfEven(3.5001)).toBe(4);
  });
  it("matches the facts.json round_half list", () => {
    const facts = readJson<{ round_half: number[] }>("facts.json");
    expect([0.5, 1.5, 2.5, 2.5, -0.5].map(roundHalfEven)).toEqual(
      facts.round_half
    );
  });
});
