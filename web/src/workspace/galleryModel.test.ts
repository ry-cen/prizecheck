import { expect, test } from "vitest";
import {
  appendBorrowed,
  appendHoldings,
  EMPTY_GALLERY,
  sameListing,
  tileAt,
  tileLabel,
  type GalleryData,
} from "./galleryModel";
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
test("borrowed entries trail owned ones with independent keys and continuous tile indexes", () => {
  const map = new Map();
  const owned = appendHoldings([], 0, [row], map);
  const all = appendBorrowed(
    owned.holdings,
    owned.loadedCopies,
    [
      { ...row, loan_id: "one", lender: "Misty" },
      { ...row, loan_id: "two", lender: "Brock" },
    ],
    map
  );
  expect(all.loadedCopies).toBe(6);
  expect(map.size).toBe(3);
  expect(all.holdings.map((entry) => entry.key)).toEqual([
    "box:edition",
    "borrowed:one:box:edition",
    "borrowed:two:box:edition",
  ]);
  expect(tileAt(all.holdings, 4)?.holding.borrowed?.loanId).toBe("two");
  expect(tileLabel(row, 0, row.location_path, "Misty")).toContain(
    "borrowed from Misty, Shelf / Box"
  );
});
test("listing equality covers borrowed counts, lender and snapshot", () => {
  const all = appendBorrowed([], 0, [
    { ...row, loan_id: "one", lender: "Misty" },
  ]);
  const a: GalleryData = {
    ...EMPTY_GALLERY,
    ...all,
    snapshot: "1.2.3",
    status: "ready",
    totals: { copies: 0, holdings: 0, editions: 0, lent: 0, borrowed: 2 },
  };
  expect(sameListing(a, { ...a })).toBe(true);
  expect(sameListing(a, { ...a, snapshot: "1.2.4" })).toBe(false);
  expect(sameListing(a, { ...a, totals: { ...a.totals!, borrowed: 1 } })).toBe(
    false
  );
  expect(
    sameListing(a, {
      ...a,
      holdings: [
        { ...a.holdings[0], borrowed: { loanId: "one", lender: "Brock" } },
      ],
    })
  ).toBe(false);
});
