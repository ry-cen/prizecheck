import { expect, it } from "vitest";
import {
  collectionAddress,
  collectionHref,
  workspaceHref,
} from "./workspaceLink";
it("retains existing Location links", () => {
  expect(workspaceHref("binder id")).toBe("/collection?location=binder+id");
});
it("round trips Location, search and inspected copy", () => {
  const href = collectionHref("binder", "Pokémon & friends", "leaf:edition", 2);
  expect(collectionAddress(href.split("?")[1])).toEqual({
    location: "binder",
    query: "Pokémon & friends",
    card: "leaf:edition",
    copy: 2,
  });
});
it("keeps All owned at the existing root", () => {
  expect(collectionHref("all")).toBe("/collection");
  expect(collectionAddress("")).toEqual({
    location: "all",
    query: "",
    card: null,
    copy: 0,
  });
});
