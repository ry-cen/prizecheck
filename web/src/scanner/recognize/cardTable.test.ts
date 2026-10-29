import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX } from "../fixtures/read";
import { arrayBufferOf, loadSubsetTable } from "../fixtures/recognizeUtil";
import { inflateCardTable, parseCardTable, releaseOf } from "./cardTable";

const tiny = {
  format: 1,
  key: "k",
  catalog_revision: 1,
  sets: [
    { id: "a", code: "AA", official: 10, total: 12, released: "2020-01-01" },
    { id: "b", code: null, official: null, total: null, released: null },
  ],
  printings: {
    id: ["u1", "u2"],
    set: [1, 0],
    number: ["1", "2"],
    name: ["One", "Two"],
    image: [null, "http://x/2"],
  },
};

const tiny2 = {
  ...tiny,
  format: 2,
  printings: {
    id: tiny.printings.id,
    set: tiny.printings.set,
    number: tiny.printings.number,
    name: tiny.printings.name,
    art: [null, "0a1b2c3d"],
  },
};

describe("card table", () => {
  it("inflates and parses subset-table.json.gz", async () => {
    const db = await loadSubsetTable();
    expect(db.ids.length).toBeGreaterThan(100);
    expect(db.numbers.length).toBe(db.ids.length);
    expect(db.setOfRow.length).toBe(db.ids.length);
    expect(db.rowOf.get(db.ids[7])).toBe(7);
    expect(releaseOf(db, 0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const raw = (await inflateCardTable(
      arrayBufferOf(join(FIX, "subset-table.json.gz"))
    )) as { key: string };
    expect(db.key).toBe(raw.key);
  });
  it("parses gzip and plain JSON alike", async () => {
    const json = JSON.stringify(tiny);
    const plain = new TextEncoder().encode(json);
    const gz = gzipSync(json);
    const a = parseCardTable(
      await inflateCardTable(
        plain.buffer.slice(
          plain.byteOffset,
          plain.byteOffset + plain.byteLength
        ) as ArrayBuffer
      )
    );
    const b = parseCardTable(
      await inflateCardTable(
        gz.buffer.slice(
          gz.byteOffset,
          gz.byteOffset + gz.byteLength
        ) as ArrayBuffer
      )
    );
    expect(a).toEqual(b);
    expect(a.art).toEqual([null, null]);
    expect(releaseOf(a, 0)).toBe("");
    expect(releaseOf(a, 1)).toBe("2020-01-01");
  });
  it("parses format 2 and keeps the art versions", () => {
    expect(parseCardTable(tiny2).art).toEqual([null, "0a1b2c3d"]);
  });
  it("a table without group parses with null groups", () => {
    expect(parseCardTable(tiny2).groups).toEqual([null, null]);
    expect(parseCardTable(tiny).groups).toEqual([null, null]);
  });
  it("keeps the group column", () => {
    const t = {
      ...tiny2,
      printings: { ...tiny2.printings, group: [0, null] },
    };
    expect(parseCardTable(t).groups).toEqual([0, null]);
  });
  it("a group column of the wrong length or with a negative or fractional entry is CARD_TABLE_INVALID", () => {
    for (const group of [[0], [0, 1, 2], [-1, null], [0.5, null], ["0", null]])
      expect(() =>
        parseCardTable({
          ...tiny2,
          printings: { ...tiny2.printings, group },
        })
      ).toThrow(/CARD_TABLE_INVALID/);
    expect(() =>
      parseCardTable({
        ...tiny2,
        printings: { ...tiny2.printings, group: "x" },
      })
    ).toThrow(/CARD_TABLE_INVALID/);
  });
  it("rejects a format 2 art value that is not an 8-hex version", () => {
    for (const art of [["https://x"], ["0A1B2C3D"], [7]])
      expect(() =>
        parseCardTable({
          ...tiny2,
          printings: { ...tiny2.printings, art: [null, ...art] },
        })
      ).toThrow(/printings\.art\[1\]/);
    const { art: _art, ...noArt } = tiny2.printings;
    expect(() => parseCardTable({ ...tiny2, printings: noArt })).toThrow(
      /CARD_TABLE_INVALID/
    );
  });
  it("throws CARD_TABLE_INVALID on a mismatched column length, bad format or bad set index", () => {
    expect(() =>
      parseCardTable({
        ...tiny,
        printings: { ...tiny.printings, name: ["One"] },
      })
    ).toThrow(/CARD_TABLE_INVALID/);
    expect(() => parseCardTable({ ...tiny, format: 3 })).toThrow(
      /CARD_TABLE_INVALID/
    );
    expect(() =>
      parseCardTable({ ...tiny, printings: { ...tiny.printings, set: [0, 5] } })
    ).toThrow(/CARD_TABLE_INVALID/);
    expect(() => parseCardTable(null)).toThrow(/CARD_TABLE_INVALID/);
  });
});
