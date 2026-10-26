import { describe, expect, it } from "vitest";
import { readJson, readPng } from "../fixtures/read";
import type { Quad, Rect } from "../types";
import { findCardGuided } from "./corners";

type Scene = { id: string; png: string; guide: Rect; quad: Quad | null };
const scenes = readJson<{ scenes: Scene[] }>("manifest.json").scenes;

describe("findCardGuided", () => {
  it.each(scenes)(
    "$id agrees with Python (found or null, corners within 2*max(1, gh/512))",
    (s) => {
      const got = findCardGuided(readPng(s.png), s.guide);
      const gh = s.guide[3] - s.guide[1];
      const tol = 2 * Math.max(1, gh / 512);
      if (s.quad === null) {
        console.log(
          `corners ${s.id}: Python null, TS ${got === null ? "null" : "FOUND"}`
        );
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      let max = 0;
      for (let i = 0; i < 4; i++) {
        max = Math.max(
          max,
          Math.hypot(
            (got as Quad)[i][0] - s.quad[i][0],
            (got as Quad)[i][1] - s.quad[i][1]
          )
        );
      }
      console.log(
        `corners ${s.id}: max corner distance ${max.toFixed(4)} px (tolerance ${tol.toFixed(3)})`
      );
      expect(max).toBeLessThanOrEqual(tol);
    }
  );
  it("finds a quad on at least 7 of the first 9 scenes (so the suite is not vacuous)", () => {
    const found = scenes.slice(0, 9).filter((s) => s.quad !== null).length;
    expect(found).toBeGreaterThanOrEqual(7);
  });
});
