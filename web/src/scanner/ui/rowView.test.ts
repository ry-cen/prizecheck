import { describe, expect, it } from "vitest";
import type { ScannerPrinting } from "../../scanner_generated";
import { rowView } from "./rowView";

const printing = (
  editions: { id: string; active: boolean; finish: string }[]
) =>
  ({
    id: "p",
    name: "Ralts",
    set_name: "Scarlet & Violet",
    collector_number: "084",
    low_image_url: "https://img.example/ralts.png",
    editions: editions.map((e) => ({
      id: e.id,
      active: e.active,
      descriptor: { finish: e.finish },
    })),
  }) as unknown as ScannerPrinting;

const row = (patch = {}) => ({
  id: "r",
  printing_id: "p",
  edition_id: "e1",
  count: 1,
  candidates: ["p"],
  needs_pick: false,
  ...patch,
});
const live = { offline: false, searchRow: false };

describe("rowView", () => {
  const ralts = printing([
    { id: "e1", active: true, finish: "normal" },
    { id: "e2", active: true, finish: "reverse" },
  ]);

  it("selects the row's own finish among the active ones", () => {
    const v = rowView(row(), ralts, null, live);
    expect(v.options.map((o) => o.label)).toEqual(["Normal", "Reverse Holo"]);
    expect(v.selected).toBe("e1");
    expect(v.setLine).toBe("Scarlet & Violet 084");
  });

  it("selects nothing for a row that needs a finish, and says its old finish is gone", () => {
    const gone = printing([
      { id: "e1", active: false, finish: "normal" },
      { id: "e2", active: true, finish: "reverse" },
    ]);
    const v = rowView(row({ needs_pick: true }), gone, null, live);
    expect(v.selected).toBeNull();
    expect(v.options.map((o) => o.value)).toEqual(["e2"]);
    expect(v.staleReason).toContain("Normal");
  });

  it("shows no chips for a Printing that is gone", () => {
    const v = rowView(row({ needs_pick: true }), undefined, null, live);
    expect(v.printingGone).toBe(true);
    expect(v.options).toEqual([]);
  });

  it("is not gone when the route simply could not be reached", () => {
    const v = rowView(row({ needs_pick: true }), undefined, null, {
      offline: true,
      searchRow: false,
    });
    expect(v.printingGone).toBe(false);
  });

  it("falls back to the cached table's name, set code and number offline", () => {
    const v = rowView(
      row(),
      undefined,
      { name: "Ralts", setCode: "SVI", number: "084", image: null },
      { offline: true, searchRow: false }
    );
    expect(v.name).toBe("Ralts");
    expect(v.setLine).toBe("SVI 084");
  });

  it("names the one finish of a Printing that has only one", () => {
    const iono = printing([{ id: "e1", active: true, finish: "holo" }]);
    expect(rowView(row(), iono, null, live).onlyFinish).toBe("Holo");
  });
});
