import { expect, it } from "vitest";
import {
  reviewedLocationParent,
  validLocationDestination,
} from "./locationDestinations";
import type { LocationNode } from "./collection";
const source: LocationNode = {
  id: "source",
  name: "Source",
  parent_id: null,
  depth: 1,
  kind: "storage_leaf",
  version: 1,
  copyCount: 0,
};
const destination: LocationNode = { ...source, id: "target", name: "Target" };
it.each([
  ["stocked", [{ ...destination, copyCount: 1 }]],
  ["cycle", [{ ...destination, parent_id: "source", depth: 2 }]],
  ["missing", []],
] as const)(
  "resets a %s move target and rejects submit until a valid choice",
  (_reason, targets) => {
    const nodes = [source, ...targets];
    expect(reviewedLocationParent(nodes, "source", false, "target")).toBe(
      "__choose__"
    );
    expect(
      validLocationDestination(nodes, "source", false, "target", false)
    ).toBe(false);
    expect(
      validLocationDestination(nodes, "source", false, "__choose__", false)
    ).toBe(false);
  }
);
it("keeps a stocked create parent but requires its conversion", () => {
  const nodes = [{ ...destination, copyCount: 1 }];
  expect(reviewedLocationParent(nodes, undefined, true, "target")).toBe(
    "target"
  );
  expect(
    validLocationDestination(nodes, undefined, true, "target", false)
  ).toBe(false);
  expect(validLocationDestination(nodes, undefined, true, "target", true)).toBe(
    true
  );
});
