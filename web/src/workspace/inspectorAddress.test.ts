import { expect, test } from "vitest";
import { writesInspectorClear } from "./inspectorAddress";

const base = {
  scopeChange: true,
  addressCard: "leaf:a",
  writtenCard: "leaf:a",
  entry: "entry-1",
  renderedEntry: "entry-1",
};

test("a collector's own scope change in the entry the inspector wrote drops the card", () => {
  expect(writesInspectorClear(base)).toBe(true);
});

test("a report that is not a scope change always writes", () => {
  expect(
    writesInspectorClear({ ...base, scopeChange: false, entry: "other" })
  ).toBe(true);
});

test("Back to an address naming another card leaves the address alone", () => {
  expect(writesInspectorClear({ ...base, addressCard: "leaf:b" })).toBe(false);
});

test("Back to an entry showing the same Holding leaves the address alone", () => {
  // All owned, inspect a card; open its Location, inspect the same card; Back. Both entries use one Holding key.
  expect(
    writesInspectorClear({
      ...base,
      entry: "all-owned",
      renderedEntry: "location",
    })
  ).toBe(false);
});
