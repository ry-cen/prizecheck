import { expect, it } from "vitest";
import {
  changedLocationFacts,
  locationBranch,
  locationFacts,
  reviewedLocationParent,
  validLocationDestination,
  type LocationFact,
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

const node = (
  id: string,
  name: string,
  parent_id: string | null,
  extra: Partial<LocationNode> = {}
): LocationNode => ({
  id,
  name,
  parent_id,
  depth: parent_id ? 2 : 1,
  kind: "storage_leaf",
  version: 1,
  copyCount: 0,
  ...extra,
});
const tree = [
  node("a", "Binders", null, { kind: "organization" }),
  node("b", "Blue", "a", { copyCount: 2 }),
  node("c", "Red", "a", { copyCount: 1 }),
  node("d", "Box", null, { copyCount: 3 }),
  node("e", "Deck", "a", { kind: "deck", copyCount: 4 }),
];
const values = (facts: ReturnType<typeof locationFacts>) =>
  Object.fromEntries(facts.map((f) => [f.key, f.value]));
it("totals a branch's copies and Locations inside, decks included", () => {
  expect(locationBranch(tree, "a")).toEqual(new Set(["a", "b", "c", "e"]));
  const facts = locationFacts("move", tree, "a", "d");
  expect(values(facts)).toEqual({
    path: "Binders",
    copies: "7 copies",
    inside: "3",
    parent: "Box",
  });
  expect(facts.find((f) => f.key === "copies")!.label).toBe(
    "Copies, including Locations inside"
  );
  expect(locationFacts("delete", tree, "d", "").map((f) => f.label)).toEqual([
    "Location",
    "Copies",
    "Locations inside",
  ]);
});
it("states each step's facts and the destination as Top level or Not chosen", () => {
  expect(values(locationFacts("rename", tree, "b", ""))).toEqual({
    path: "Binders / Blue",
  });
  expect(values(locationFacts("move", tree, "b", "")).parent).toBe("Top level");
  expect(values(locationFacts("move", tree, "b", "__choose__")).parent).toBe(
    "Not chosen"
  );
  expect(values(locationFacts("move", tree, "b", "gone")).parent).toBe(
    "Not chosen"
  );
  expect(values(locationFacts("create", tree, undefined, "a"))).toEqual({
    parent: "Binders",
  });
  expect(values(locationFacts("create", tree, undefined, "d"))).toEqual({
    parent: "Box",
    stock: "3 copies",
  });
  expect(locationFacts("move", tree, "missing", "a")).toEqual([]);
});
it("does not follow a cycle twice", () => {
  const loop = [
    node("x", "X", "y", { copyCount: 1 }),
    node("y", "Y", "x", { copyCount: 2 }),
  ];
  expect(locationBranch(loop, "x")).toEqual(new Set(["x", "y"]));
  expect(values(locationFacts("delete", loop, "x", ""))).toMatchObject({
    copies: "3 copies",
    inside: "1",
  });
});
it("reports changed, appearing and disappearing facts, using the after label", () => {
  const before = locationFacts("create", tree, undefined, "a");
  const after = locationFacts("create", tree, undefined, "d");
  expect(changedLocationFacts(before, after)).toEqual([
    { key: "parent", label: "Adding to", before: "Binders", after: "Box" },
    {
      key: "stock",
      label: "Copies to move",
      before: "none",
      after: "3 copies",
    },
  ]);
  expect(changedLocationFacts(after, before)).toEqual([
    { key: "parent", label: "Adding to", before: "Box", after: "Binders" },
    {
      key: "stock",
      label: "Copies to move",
      before: "3 copies",
      after: "none",
    },
  ]);
  expect(changedLocationFacts(before, before)).toEqual([]);
  const small = locationFacts("move", tree, "d", "");
  const bigger = locationFacts(
    "move",
    [...tree, node("f", "In", "d", { copyCount: 1 })],
    "d",
    ""
  );
  expect(
    changedLocationFacts(small, bigger).map((c) => [c.key, c.label])
  ).toEqual([
    ["copies", "Copies, including Locations inside"],
    ["inside", "Locations inside"],
  ]);
});

const fact = (
  key: LocationFact["key"],
  value: string,
  identity: string,
  choice?: LocationFact["choice"]
): LocationFact => ({ key, label: key, value, identity, choice });
it("tells two trees with the same displayed path apart, without ids in the words", () => {
  const first = [
    node("a1", "A", null, { kind: "organization" }),
    node("s1", "Shelf", "a1"),
  ];
  const second = [
    node("a2", "A", null, { kind: "organization" }),
    node("s2", "Shelf", "a2"),
  ];
  const changes = changedLocationFacts(
    locationFacts("create", first, undefined, "s1"),
    locationFacts("create", second, undefined, "s2")
  );
  expect(changes).toHaveLength(1);
  expect(changes[0].note).toBe(
    "The parent Location changed. Its displayed path is still A / Shelf."
  );
  expect(changes[0].note).not.toMatch(/[12]/);
  const renamedAbove = first.map((n) =>
    n.id === "a1" ? { ...n, name: "B" } : n
  );
  expect(
    changedLocationFacts(
      locationFacts("rename", first, "s1", ""),
      locationFacts("rename", [...first, node("x", "Y", null)], "s1", "")
    )
  ).toEqual([]);
  expect(
    changedLocationFacts(
      locationFacts("create", first, undefined, "s1"),
      locationFacts("create", renamedAbove, undefined, "s1")
    )[0].note
  ).toBeUndefined();
});
it("keeps a Location named Not chosen, Top level or none apart from a missing choice or fact", () => {
  const named = [node("n", "Not chosen", null), node("t", "Top level", null)];
  const chosen = locationFacts("create", named, undefined, "n");
  const unchosen = locationFacts("create", named, undefined, "__choose__");
  expect(chosen[0].value).toBe(unchosen[0].value);
  expect(changedLocationFacts(chosen, unchosen)[0].note).toBe(
    "Previously selected “Not chosen”. Choose a parent Location."
  );
  expect(changedLocationFacts(unchosen, chosen)[0].note).toBe(
    "The parent changed from no parent chosen to the Location “Not chosen”."
  );
  const top = locationFacts("create", named, undefined, "");
  const alsoTop = locationFacts("create", named, undefined, "t");
  expect(changedLocationFacts(top, alsoTop)[0].note).toBe(
    "The parent changed from Top level to the Location “Top level”."
  );
  const none = fact("parent", "none", '["chosen","x"]', "chosen");
  expect(changedLocationFacts([], [none])).toHaveLength(1);
  expect(changedLocationFacts([], [none])[0].note).toBe("The parent changed.");
  expect(changedLocationFacts([none], [])).toHaveLength(1);
  expect(changedLocationFacts([], [])).toEqual([]);
});
it("walks ancestors once when Locations loop", () => {
  const loop = [node("x", "X", "y"), node("y", "Y", "x")];
  const facts = locationFacts("rename", loop, "x", "");
  expect(facts[0].identity).toBe('[["y","Y"],["x","X"]]');
});
