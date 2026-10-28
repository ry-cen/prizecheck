import { describe, expect, it } from "vitest";
import type { CatalogSet } from "../catalog_browse_generated";
import { eraKeyOf, groupSetsByEra, hasEras } from "./setEras";

function set(
  id: string,
  name: string,
  series: [string, string] | null,
  released: string | null
): CatalogSet {
  return {
    set_id: id,
    set_name: name,
    set_code: id.toUpperCase(),
    printings: 1,
    series_id: series?.[0] ?? null,
    series_name: series?.[1] ?? null,
    release_date: released,
  };
}

const SV: [string, string] = ["sv", "Scarlet & Violet"];
const SWSH: [string, string] = ["swsh", "Sword & Shield"];
const XY: [string, string] = ["xy", "XY"];

describe("groupSetsByEra", () => {
  it("orders eras and the sets inside them newest first, the sets with no era last", () => {
    const eras = groupSetsByEra([
      set("xy1", "XY", XY, "2014-02-05"),
      set("sv01", "Scarlet & Violet", SV, "2023-03-31"),
      set("zz", "Zebra", null, "2030-01-01"),
      set("sv02", "Paldea Evolved", SV, "2023-06-09"),
      set("swsh2", "Rebel Clash", SWSH, "2020-05-01"),
    ]);
    expect(eras.map((era) => era.name)).toEqual([
      "Scarlet & Violet",
      "Sword & Shield",
      "XY",
      "Other sets",
    ]);
    expect(eras[0].sets.map((entry) => entry.set_id)).toEqual(["sv02", "sv01"]);
  });

  it("puts side series below the main eras however new, and the sets with no era last", () => {
    const eras = groupSetsByEra([
      set(
        "mcd25",
        "McDonald's 2025",
        ["mc", "McDonald's Collection"],
        "2026-01-01"
      ),
      set("sv01", "Scarlet & Violet", SV, "2023-03-31"),
      set("tk1", "Trainer Kit", ["tk", "Trainer kits"], "2024-01-01"),
      set("zz", "Zebra", null, "2030-01-01"),
      set("new", "Future", ["fut", "Future"], "2020-01-01"),
    ]);
    expect(eras.map((era) => era.key)).toEqual([
      "sv",
      "fut",
      "mc",
      "tk",
      "other",
    ]);
  });

  it("puts an undated set after the dated ones and breaks ties by name", () => {
    const [era] = groupSetsByEra([
      set("b", "Beta", SV, null),
      set("a", "alpha", SV, null),
      set("d", "Dated", SV, "2023-01-01"),
      set("c", "Gamma", SV, "2023-01-01"),
    ]);
    expect(era.sets.map((entry) => entry.set_id)).toEqual(["d", "c", "a", "b"]);
  });

  it("puts an era with no dated set after the dated eras", () => {
    const eras = groupSetsByEra([
      set("x", "X", XY, null),
      set("s", "S", SV, "2023-03-31"),
    ]);
    expect(eras.map((era) => era.key)).toEqual(["sv", "xy"]);
  });
});

describe("hasEras and eraKeyOf", () => {
  it("tells a catalog with no era at all and finds a set's folder", () => {
    expect(hasEras([set("a", "A", null, null)])).toBe(false);
    expect(hasEras([set("a", "A", null, null), set("b", "B", SV, null)])).toBe(
      true
    );
    expect(eraKeyOf(set("b", "B", SV, null))).toBe("sv");
    expect(eraKeyOf(set("a", "A", null, null))).toBe("other");
    expect(eraKeyOf(null)).toBeNull();
  });
});
