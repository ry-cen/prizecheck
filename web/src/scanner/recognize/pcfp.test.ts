import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX } from "../fixtures/read";
import { arrayBufferOf, loadLogic } from "../fixtures/recognizeUtil";
import { parsePcfp } from "./pcfp";
import { l2normalize, rowIndex, scoreAll, simsFor, topK } from "./search";

const buf = arrayBufferOf(join(FIX, "pcfp5.bin"));
const logic = loadLogic();

describe("PCFP", () => {
  it("parses and scores like Python", () => {
    const fp = parsePcfp(buf);
    expect(fp.count).toBe(5);
    expect(fp.dim).toBe(384);
    expect(fp.ids).toEqual(logic.pcfp.ids);
    const q = new Float32Array(logic.pcfp.query);
    const scores = scoreAll(fp, q);
    let maxDiff = 0;
    for (let i = 0; i < 5; i++)
      maxDiff = Math.max(maxDiff, Math.abs(scores[i] - logic.pcfp.scores[i]));
    console.log(`pcfp max abs score diff ${maxDiff}`);
    expect(maxDiff).toBeLessThanOrEqual(1e-5);
    const top3 = topK(fp, scores, 3);
    expect(top3.map((c) => c.id)).toEqual(logic.pcfp.top3);
    expect(
      top3.every(
        (c) => c.source === "image" && c.tier === 0 && c.score !== null
      )
    ).toBe(true);
    const sims = simsFor(fp, rowIndex(fp), q, [
      fp.ids[2],
      "missing",
      fp.ids[0],
    ]);
    expect([...sims.keys()]).toEqual([fp.ids[2], fp.ids[0]]);
    expect(sims.get(fp.ids[2])).toBe(scores[2]);
    expect(
      topK(fp, scores, 5, (id) => id !== fp.ids[0]).map((c) => c.id)
    ).not.toContain(fp.ids[0]);
  });
  it("breaks ties by id", () => {
    const fp = parsePcfp(buf);
    const eq = new Float32Array(5).fill(0.5);
    expect(topK(fp, eq, 3).map((c) => c.id)).toEqual(fp.ids.slice(0, 3));
  });
  it("l2normalize", () => {
    const n = l2normalize(new Float32Array([3, 4]));
    expect(n[0]).toBeCloseTo(0.6, 6);
    expect(n[1]).toBeCloseTo(0.8, 6);
    expect(l2normalize(new Float32Array(3))).toEqual(new Float32Array(3));
  });
  it("rejects bad magic, bad length and dim 383 with ASSET_INVALID", () => {
    const badMagic = buf.slice(0);
    new Uint8Array(badMagic)[0] = 0x58;
    expect(() => parsePcfp(badMagic)).toThrow(/ASSET_INVALID/);
    expect(() => parsePcfp(buf.slice(0, buf.byteLength - 1))).toThrow(
      /ASSET_INVALID/
    );
    expect(() => parsePcfp(buf.slice(0, 10))).toThrow(/ASSET_INVALID/);
    const badDim = buf.slice(0);
    new DataView(badDim).setUint16(6, 383, true);
    expect(() => parsePcfp(badDim)).toThrow(/ASSET_INVALID/);
  });
});
