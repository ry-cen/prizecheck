import { expect, test } from "vitest";
import {
  appendBorrowed,
  appendHoldings,
  type GalleryHolding,
} from "./galleryModel";
import {
  addSpans,
  dropBorrowedSelection,
  selectedBorrowed,
  selectedGroups,
  summarizeSelection,
} from "./selectionModel";
import type { CollectionHoldingView } from "../collection_generated";

const row: CollectionHoldingView = {
  edition_id: "edition",
  location_id: "box",
  location_name: "Box",
  location_path: "Shelf / Box",
  quantity: "2",
  version: 4,
  printing_id: "printing",
  printing_name: "Iono",
  set_id: "sv02",
  set_name: "Paldea Evolved",
  set_code: "PAL",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  category: "Trainer",
  elemental_types: [],
  trainer_type: "supporter",
};
export function mixedRows(): GalleryHolding[] {
  const owned = appendHoldings([], 0, [row]);
  return appendBorrowed(owned.holdings, owned.loadedCopies, [
    { ...row, loan_id: "loan", lender: "Misty" },
  ]).holdings;
}
test("selection separates owned manifest items from borrowed rows", () => {
  const selected = addSpans(new Map(), mixedRows(), [[0, 3]]);
  expect(selectedGroups(selected)).toEqual([
    {
      source_id: "box",
      edition_id: "edition",
      quantity: "2",
      expected_version: 4,
    },
  ]);
  expect(selectedBorrowed(selected)).toEqual([
    {
      loan_id: "loan",
      edition_id: "edition",
      from_location_id: "box",
      quantity: "2",
    },
  ]);
  expect(summarizeSelection(selected)).toEqual({
    copies: 4,
    borrowed: 2,
    editions: 1,
    locations: 1,
  });
});
test("dropping borrowed selection preserves owned entries and leaves empty or owned-only selections unchanged", () => {
  const selected = addSpans(new Map(), mixedRows(), [[0, 3]]);
  const owned = dropBorrowedSelection(selected);
  expect([...owned.keys()]).toEqual(["box:edition"]);
  expect(owned.get("box:edition")).toBe(selected.get("box:edition"));
  expect(dropBorrowedSelection(owned)).toBe(owned);
  const empty = new Map();
  expect(dropBorrowedSelection(empty)).toBe(empty);
});
