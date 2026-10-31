import { describe, expect, it } from "vitest";
import type { PickRow, PickSource } from "../decks_generated";
import { sourceLabel, sourceOption, takesFor, takesText } from "./gatherModel";

const source = (fields: Partial<PickSource>): PickSource => ({
  location_id: "a",
  name: "Page 1",
  path: "Shelf / Binder A / Page 1",
  kind: "storage_leaf",
  available: "2",
  committed: "0",
  version: 1,
  suggested: "0",
  warning: null,
  ...fields,
});

describe("Gather source names", () => {
  it("names each source by its full path, so same-named Locations differ", () => {
    const first = source({ location_id: "a", suggested: "2" });
    const second = source({
      location_id: "b",
      path: "Shelf / Binder B / Page 1",
      suggested: "1",
    });
    expect(sourceOption(first)).toBe("Shelf / Binder A / Page 1: 2 here");
    expect(sourceOption(second)).toBe("Shelf / Binder B / Page 1: 2 here");
    const row: PickRow = {
      edition_id: "e",
      quantity: "3",
      in_deck: "0",
      elsewhere: "3",
      not_owned: "0",
      sources: [first, second],
    };
    expect(takesText(takesFor(row, "suggested"))).toBe(
      "2 from Shelf / Binder A / Page 1 · 1 from Shelf / Binder B / Page 1"
    );
  });

  it("keeps a root Location's name and marks another Deck", () => {
    expect(sourceLabel(source({ name: "Unsorted", path: "Unsorted" }))).toBe(
      "Unsorted"
    );
    expect(
      sourceLabel(
        source({ kind: "deck", name: "Gardevoir", path: "Decks / Gardevoir" })
      )
    ).toBe("Decks / Gardevoir (Deck)");
  });
});
