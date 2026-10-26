import { describe, expect, it } from "vitest";
import { LOCAL, hasLocal, readJson, readPng } from "../fixtures/read";
import type { Quad, Rect } from "../types";
import { findCardGuided } from "./corners";
import { TUNED_GATE, decideGate, measureGate } from "./gate";

type Item = {
  id: string;
  png: string;
  guide: Rect;
  gate: {
    sharpness: number;
    mean_luma: number;
    clipped_frac: number;
    ok: boolean;
    reasons: string[];
  };
  quad: Quad | null;
};

describe.skipIf(!hasLocal())("40 local photos", () => {
  it("gate and corners agree with Python", { timeout: 300_000 }, () => {
    const items = readJson<{ items: Item[] }>("e2e.json", LOCAL).items;
    let quadAgree = 0;
    const misses: string[] = [];
    let found = 0;
    let fnAgree = 0;
    let maxRel = 0,
      maxLuma = 0,
      maxClip = 0,
      maxCorner = 0,
      maxTol = 0;
    for (const it of items) {
      const img = readPng(it.png, LOCAL);
      const m = measureGate(img, it.guide);
      const rel = Math.abs(m.sharpness - it.gate.sharpness) / it.gate.sharpness;
      const dl = Math.abs(m.meanLuma - it.gate.mean_luma);
      const dc = Math.abs(m.clippedFrac - it.gate.clipped_frac);
      maxRel = Math.max(maxRel, rel);
      maxLuma = Math.max(maxLuma, dl);
      maxClip = Math.max(maxClip, dc);
      if (rel > 0.01 || dl > 0.5 || dc > 0.002)
        misses.push(`${it.id}: gate rel ${rel} luma ${dl} clip ${dc}`);
      const near =
        Math.abs(it.gate.sharpness - TUNED_GATE.sharpMin) /
          TUNED_GATE.sharpMin <=
        0.01;
      if (!near && decideGate(m, TUNED_GATE).ok !== it.gate.ok)
        misses.push(`${it.id}: gate decision differs`);

      const q = findCardGuided(img, it.guide);
      const tol = 2 * Math.max(1, (it.guide[3] - it.guide[1]) / 512);
      let agree: boolean;
      if ((q === null) === (it.quad === null)) fnAgree++;
      if (q === null || it.quad === null)
        agree = q === null && it.quad === null;
      else {
        let d = 0;
        for (let i = 0; i < 4; i++)
          d = Math.max(
            d,
            Math.hypot(q[i][0] - it.quad[i][0], q[i][1] - it.quad[i][1])
          );
        agree = d <= tol;
        maxCorner = Math.max(maxCorner, d);
        maxTol = tol;
        if (!agree)
          console.log(
            `quad miss ${it.id}: max corner distance ${d.toFixed(2)} > ${tol.toFixed(2)}`
          );
      }
      if (q) found++;
      if (agree) quadAgree++;
      else
        misses.push(
          `${it.id}: quad disagrees (TS ${q ? "found" : "null"}, Python ${it.quad ? "found" : "null"})`
        );
    }
    console.log(
      `local photos: quad agreement ${quadAgree}/${items.length}, TS found ${found}`
    );
    console.log(
      `local maxima: sharpness rel ${maxRel}, luma ${maxLuma}, clipped ${maxClip}, corner ${maxCorner.toFixed(3)} px (tolerance ${maxTol.toFixed(2)}), found/null agreement ${fnAgree}/${items.length}`
    );
    for (const m of misses) console.log("miss", m);
    expect(items.length).toBe(40);
    expect(fnAgree).toBeGreaterThanOrEqual(39);
    expect(quadAgree).toBeGreaterThanOrEqual(38);
    expect(misses.filter((m) => m.includes("gate")).length).toBe(0);
  });
});
