import { describe, expect, it } from "vitest";
import { blobImg, readBlob, readJson, type Blob } from "../fixtures/read";
import { toGray, toLab } from "./color";

type Prim = {
  id: string;
  op: string;
  params: Record<string, unknown>;
  in: Blob;
  out: Blob;
};
const prims = readJson<{ prim: Prim[] }>("manifest.json").prim;
const facts = readJson<{
  gray: {
    blue: number;
    green: number;
    red: number;
    mixed: { gray: number; rgb: number[] };
  };
}>("facts.json");

describe("toGray", () => {
  it("matches facts.json", () => {
    const px = (r: number, g: number, b: number) =>
      toGray({ width: 1, height: 1, channels: 3, data: Uint8Array.of(r, g, b) })
        .data[0];
    expect(px(0, 0, 255)).toBe(facts.gray.blue);
    expect(px(0, 255, 0)).toBe(facts.gray.green);
    expect(px(255, 0, 0)).toBe(facts.gray.red);
    const [r, g, b] = facts.gray.mixed.rgb;
    expect(px(r, g, b)).toBe(facts.gray.mixed.gray);
  });
  it.each(prims.filter((p) => p.op === "gray"))("$id is exact", (p) => {
    const got = toGray(blobImg(p.in)).data;
    const want = readBlob(p.out) as Uint8Array;
    let max = 0;
    for (let i = 0; i < want.length; i++)
      max = Math.max(max, Math.abs(got[i] - want[i]));
    console.log(`toGray ${p.id} max abs diff ${max}`);
    expect(max).toBe(0);
  });
  it("ignores alpha", () => {
    const rgba = {
      width: 1,
      height: 1,
      channels: 4 as const,
      data: Uint8Array.of(17, 99, 201, 3),
    };
    expect(toGray(rgba).data[0]).toBe(facts.gray.mixed.gray);
  });
});

describe("toLab", () => {
  it.each(prims.filter((p) => p.op === "lab"))("$id within 2 levels", (p) => {
    const got = toLab(blobImg(p.in)).data;
    const want = readBlob(p.out) as Uint8Array;
    const hist = new Map<number, number>();
    let max = 0;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got[i] - want[i]);
      hist.set(d, (hist.get(d) ?? 0) + 1);
      max = Math.max(max, d);
    }
    console.log(
      `toLab ${p.id} max abs diff ${max}; histogram ${JSON.stringify([...hist.entries()].sort((a, b) => a[0] - b[0]))}`
    );
    expect(max).toBeLessThanOrEqual(2);
  });
});
