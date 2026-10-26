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
    expect(a.images).toEqual([null, "http://x/2"]);
    expect(releaseOf(a, 0)).toBe("");
    expect(releaseOf(a, 1)).toBe("2020-01-01");
  });
  it("throws CARD_TABLE_INVALID on a mismatched column length, bad format or bad set index", () => {
    expect(() =>
      parseCardTable({
        ...tiny,
        printings: { ...tiny.printings, name: ["One"] },
      })
    ).toThrow(/CARD_TABLE_INVALID/);
    expect(() => parseCardTable({ ...tiny, format: 2 })).toThrow(
      /CARD_TABLE_INVALID/
    );
    expect(() =>
      parseCardTable({ ...tiny, printings: { ...tiny.printings, set: [0, 5] } })
    ).toThrow(/CARD_TABLE_INVALID/);
    expect(() => parseCardTable(null)).toThrow(/CARD_TABLE_INVALID/);
  });
});
