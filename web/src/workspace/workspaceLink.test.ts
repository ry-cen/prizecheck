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
    borrowed: false,
  });
});
it("keeps All owned at the existing root", () => {
  expect(collectionHref("all")).toBe("/collection");
  expect(collectionAddress("")).toEqual({
    location: "all",
    query: "",
    card: null,
    copy: 0,
    borrowed: false,
  });
});
it("gives the Borrowed list its own address beside Location and search", () => {
  const href = collectionHref("binder", "iono", undefined, 0, true);
  expect(href).toBe("/collection?location=binder&q=iono&borrowed=1");
  expect(collectionAddress(href.split("?")[1]).borrowed).toBe(true);
  expect(collectionAddress("borrowed=0").borrowed).toBe(false);
  // A card's address never carries it.
  expect(collectionHref("all", "", "leaf:edition", 0, true)).toBe(
    "/collection?card=leaf%3Aedition"
  );
});
