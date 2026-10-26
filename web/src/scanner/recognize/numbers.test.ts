import { describe, expect, it } from "vitest";
import { parseCardTable } from "./cardTable";
import {
  buildNumberIndex,
  keyStr,
  lookup,
  numberKey,
  parseNumberText,
} from "./numbers";
import {
  checkParseCorpus,
  loadLogic,
  loadSubsetTable,
  toReading,
} from "../fixtures/recognizeUtil";
import { releaseOf } from "./cardTable";
import type { Candidate, NumberReading } from "./types";

// tests/fixtures/mini_catalog (sets.json + cards.jsonl) as a card table literal.
const MINI_SETS: [string, string | null, number, number, string][] = [
  ["sv01", "SVI", 198, 258, "2023-03-31"],
  ["sv02", "PAL", 193, 279, "2023-06-09"],
  ["base1", null, 102, 102, "1999-01-09"],
  ["base2", null, 64, 64, "1999-06-16"],
  ["swsh9", "BRS", 172, 216, "2022-02-25"],
  ["swshp", null, 0, 307, "2019-11-15"],
  ["xyp", null, 0, 216, "2013-10-12"],
  ["sve", "SVE", 24, 24, "2023-03-31"],
  ["exu", null, 28, 28, "2005-08-22"],
];
const MINI_CARDS: [string, string, string][] = [
  ["sv01-025", "sv01", "025"],
  ["sv01-210", "sv01", "210"],
  ["sv02-025", "sv02", "025"],
  ["base1-4", "base1", "4"],
  ["base2-4", "base2", "4"],
  ["base1-102", "base1", "102"],
  ["swsh9-025", "swsh9", "025"],
  ["swsh9-TG30", "swsh9", "TG30"],
  ["swsh9-TG05", "swsh9", "TG05"],
  ["swshp-SWSH001", "swshp", "SWSH001"],
  ["xyp-XY150a", "xyp", "XY150a"],
  ["sve-001", "sve", "001"],
  ["sve-002", "sve", "002"],
  ["exu-!", "exu", "!"],
];
const miniDb = parseCardTable({
  format: 1,
  key: "mini",
  catalog_revision: 0,
  sets: MINI_SETS.map(([id, code, official, total, released]) => ({
    id,
    code,
    official,
    total,
    released,
  })),
  printings: {
    id: MINI_CARDS.map((c) => c[0]),
    set: MINI_CARDS.map((c) => MINI_SETS.findIndex((s) => s[0] === c[1])),
    number: MINI_CARDS.map((c) => c[2]),
    name: MINI_CARDS.map(() => "x"),
    image: MINI_CARDS.map(() => null),
  },
});
const idx = buildNumberIndex(miniDb);

const f = (r: NumberReading) => [
  r.prefix,
  r.number,
  r.suffix,
  r.denominator,
  r.denPrefix,
  r.setCode,
];
const parse = (t: string) => parseNumberText(t, idx.knownPrefixes);
const tol = (t: string) =>
  parseNumberText(t, idx.knownPrefixes, idx.knownAbbrs, idx.knownDens, true);
const strict = (t: string) =>
  parseNumberText(t, idx.knownPrefixes, idx.knownAbbrs, idx.knownDens, false);
const pairs = (c: Candidate[]) => c.map((x) => [x.id, x.tier]);
const reading = (number: number): NumberReading => ({
  prefix: "",
  number,
  suffix: "",
  denominator: null,
  denPrefix: "",
  setCode: null,
  raw: "4",
  denPartial: "",
});

describe("port of tests/test_numbers.py", () => {
  it("number_key_cases", () => {
    expect(numberKey("025")).toEqual(["", 25, ""]);
    expect(numberKey("4")).toEqual(["", 4, ""]);
    expect(numberKey("TG01")).toEqual(["TG", 1, ""]);
    expect(numberKey("SWSH001")).toEqual(["SWSH", 1, ""]);
    expect(numberKey("XY150a")).toEqual(["XY", 150, "a"]);
    for (const bad of ["!", "%3F", "A", "Museum"])
      expect(numberKey(bad)).toBeNull();
    expect(keyStr("XY", 150, "a")).toBe("XY|150|a");
  });
  it("index_basics", () => {
    expect(idx.knownPrefixes).toEqual(["SWSH", "TG", "XY"]);
    expect(idx.printedDen.get("sv01")?.get("")).toBe(198);
    expect(idx.printedDen.get("swsh9")?.get("TG")).toBe(30);
    expect(idx.printedDen.get("swshp")?.has("")).toBe(false);
    expect(idx.abbrToSets.get("SVI")).toEqual(["sv01"]);
    expect(idx.knownAbbrs).toEqual(["BRS", "PAL", "SVE", "SVI"]);
    expect(idx.knownDens).toEqual([24, 28, 64, 102, 172, 193, 198]);
  });
  it("parse_sv_with_set_code", () => {
    expect(f(parse("G SVI EN 025/198")[0])).toEqual([
      "",
      25,
      "",
      198,
      "",
      "SVI",
    ]);
  });
  it("parse_joined_set_code_en", () => {
    for (const [text, code] of [
      ["SVIEN025/198", "SVI"],
      ["SVIENO25/I98", "SVI"],
      ["SVIEN 025/198", "SVI"],
      ["PALEN025/193", "PAL"],
      ["SVIE25/198", null],
    ]) {
      const r = parse(text as string);
      expect(r.length, text as string).toBeGreaterThan(0);
      expect(r[0].setCode, text as string).toBe(code);
      expect([`${r[0].number}/${r[0].denominator}`]).toContainEqual(
        expect.stringMatching(/^25\/(198|193)$/)
      );
    }
    expect(f(parse("ABCDEN025/198")[0])).toEqual(["", 25, "", 198, "", "ABCD"]);
    const c = lookup(parse("SVIEN025/198"), idx);
    expect([c[0].id, c[0].tier]).toEqual(["sv01-025", 3]);
  });
  it("parse_base_right / confusions / prefixed / promo / suffix", () => {
    expect(f(parse("4/102")[0])).toEqual(["", 4, "", 102, "", null]);
    expect(f(parse("O25/I98")[0])).toEqual(["", 25, "", 198, "", null]);
    expect(f(parse("TG05/TG30")[0])).toEqual(["TG", 5, "", 30, "TG", null]);
    expect(f(parse("SWSH001")[0])).toEqual(["SWSH", 1, "", null, "", null]);
    expect(f(parse("XY150a")[0])).toEqual(["XY", 150, "a", null, "", null]);
  });
  it("parse_noise_returns_empty", () => {
    for (const t of [
      "HP 60 10",
      "",
      "ILLUS MITSUHIRO ARITA",
      "2023 POKEMON / NINTENDO / CREATURES / GAME FREAK",
    ])
      expect(parse(t)).toEqual([]);
  });
  it("lookup tiers and ordering", () => {
    let c = lookup(parse("SVI EN 025/198"), idx);
    expect([c[0].id, c[0].tier]).toEqual(["sv01-025", 3]);
    expect(new Set(pairs(c.slice(1)).map((p) => p.join(":")))).toEqual(
      new Set(["sv02-025:1", "swsh9-025:1"])
    );
    c = lookup(parse("025/198"), idx);
    expect([c[0].id, c[0].tier]).toEqual(["sv01-025", 2]);
    expect(pairs(lookup(parse("4/64"), idx))).toEqual([
      ["base2-4", 2],
      ["base1-4", 1],
    ]);
    expect(pairs(lookup([reading(4)], idx))).toEqual([
      ["base2-4", 1],
      ["base1-4", 1],
    ]);
    c = lookup(parse("SVE EN 001"), idx);
    expect([c[0].id, c[0].tier]).toEqual(["sve-001", 3]);
    c = lookup(parse("TG05/TG30"), idx);
    expect([c[0].id, c[0].tier]).toEqual(["swsh9-TG05", 2]);
    expect(lookup(parse("999/198"), idx)).toEqual([]);
  });
  it("glued, regulation mark, unknown code, year-glued", () => {
    expect(f(parse("1999Wrs12/102")[0])).toEqual(["", 12, "", 102, "", null]);
    let r = parseNumberText("GSVIEN025/198", idx.knownPrefixes, idx.knownAbbrs);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.setCode === "SVI")).toBe(true);
    const cands = lookup(r, idx);
    expect([cands[0].id, cands[0].tier]).toEqual(["sv01-025", 3]);
    r = parseNumberText("XQZ EN 025/198", idx.knownPrefixes, idx.knownAbbrs);
    expect(r[0].setCode).toBeNull();
    expect(parse("XQZ EN 025/198")[0].setCode).toBe("XQZ");
    expect(f(parse("WIZARDS12/102")[0])).toEqual(["", 12, "", 102, "", null]);
    expect(parse("19917/102").map((x) => f(x).slice(0, 4))).toEqual([
      ["", 917, "", 102],
      ["", 17, "", 102],
      ["", 7, "", 102],
    ]);
    expect(parse("025/198").map((x) => f(x).slice(0, 4))).toEqual([
      ["", 25, "", 198],
    ]);
  });
  it("tolerant mode", () => {
    const nd = (t: string, fn: (s: string) => NumberReading[]) =>
      fn(t).map((x) => [x.number, x.denominator]);
    expect(nd("025 198", tol)).toEqual([[25, 198]]);
    expect(strict("025 198")).toEqual([]);
    for (const t of ["025l198", "025|198"])
      expect(nd(t, tol)).toEqual([[25, 198]]);
    expect(nd("0251198", tol)).toEqual([[25, 198]]);
    expect(tol("025 199")).toEqual([]);
    expect(tol("HP 60 10")).toEqual([]);
    expect(nd("025/198 030 102", tol)).toEqual([[25, 198]]);
    expect(
      tol("025/19").map((x) => [x.number, x.denominator, x.denPartial])
    ).toEqual([[25, null, "19"]]);
    expect(
      strict("025/19").map((x) => [x.number, x.denominator, x.denPartial])
    ).toEqual([[25, 19, ""]]);
    const c = lookup(tol("025/19"), idx);
    expect(new Set(c.map((x) => x.id))).toEqual(
      new Set(["sv01-025", "sv02-025"])
    );
    expect(c.every((x) => x.tier === 1)).toBe(true);
    expect(
      tol("025/").map((x) => [x.number, x.denominator, x.denPartial])
    ).toEqual([[25, null, ""]]);
    expect(strict("025/")).toEqual([]);
  });
});

describe("parity with the Python reference", () => {
  const logic = loadLogic();
  it("parse corpus: ASCII exact, non-ASCII within 5%, Python errors never throw", () => {
    const r = checkParseCorpus(
      logic.parse,
      logic.known,
      parseNumberText,
      "parse"
    );
    expect(r.asciiMismatch).toEqual([]);
    expect(r.throws).toEqual([]);
    expect(r.nonAsciiMismatch.length).toBeLessThanOrEqual(0.05 * r.nonAscii);
  });
  it("buildNumberIndex on the subset table equals subsetKnown, and all lookup cases are exact", async () => {
    const db = await loadSubsetTable();
    const sidx = buildNumberIndex(db);
    expect(sidx.knownPrefixes).toEqual(logic.subsetKnown.prefixes);
    expect(sidx.knownAbbrs).toEqual(logic.subsetKnown.abbrs);
    expect(sidx.knownDens).toEqual(logic.subsetKnown.dens);
    expect(logic.lookup.length).toBe(320);
    for (const [i, c] of logic.lookup.entries()) {
      const got = lookup(c.readings.map(toReading), sidx).map((x) => [
        x.id,
        x.tier,
      ]);
      expect(got, `lookup case ${i}`).toEqual(
        c.expected.map(([row, tier]) => [db.ids[row], tier])
      );
    }
    expect(releaseOf(db, 0)).toBe(sidx.release.get(db.ids[0]));
  });
});
