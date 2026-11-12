import { expect, it } from "vitest";
import { OWNER_SUBPATHS } from "../owner/sections";
import {
  PAGES,
  isViewAddress,
  isViewSwitch,
  opensPage,
  pageAt,
} from "./routes";

it("classifies view switches and page entries", () => {
  for (const page of PAGES) {
    expect(isViewAddress(page.path)).toBe(true);
    expect(opensPage("/decks/example", page.path)).toBe(false);
    for (const view of page.views ?? []) {
      const path = `${page.path}/${view}`;
      expect(isViewAddress(path)).toBe(true);
      expect(pageAt(path)?.id).toBe(page.id);
      expect(isViewSwitch(page.path, path)).toBe(true);
      expect(isViewSwitch(path, page.path)).toBe(true);
      expect(opensPage(page.path, path)).toBe(false);
    }
  }
  for (const [from, to, entry] of [
    ["/decks", "/decks/want-list", false],
    ["/decks/want-list", "/decks", false],
    ["/decks/d1", "/decks/want-list", true],
    ["/decks", "/decks/d1", true],
    ["/decks/want-list", "/decks/d1", true],
    ["/decks/d1", "/decks/d1/replace", true],
    ["/decks", "/decks/import", true],
    ["/trades", "/trades/find", false],
    ["/trades/find", "/trades/list", false],
    ["/trades/list", "/trades/find", false],
    ["/trades/t1", "/trades/find", true],
    ["/trades/new/handle", "/trades/find", true],
    ["/catalog", "/trades/new/handle", true],
    ["/trades/find", "/trades/new/trader", true],
    ["/trades/t1", "/trades/t1/counter", true],
    ["/trades", "/trades/t1", true],
    ["/trades", "/trades/trader/t1", true],
    ["/trades", "/trades/with/t1", true],
    ["/trades", "/trades/conversation/t1", true],
    ["/loans", "/loans/l1", true],
    ["/collection", "/collection/import", true],
    ["/decks", "/discover", true],
    ["/collection", "/collectors/friend/collection", true],
    ["/collection", "/collectors/friend/trade-list", true],
    ["/decks", "/published/token", true],
    ["/decks/d1", "/decks/d1", false],
    ["/collection", "/collection", false],
    ["/decks", "/trades/find", true],
  ] as const)
    expect(opensPage(from, to), `${from} -> ${to}`).toBe(entry);
  for (const view of [
    "/decks/want-list",
    "/trades/find",
    "/trades/list",
    ...OWNER_SUBPATHS.map((section) => `/owner/${section}`),
  ])
    expect(isViewAddress(view)).toBe(true);
  for (const path of [
    "/decks/d1",
    "/trades/t1",
    "/collection/import",
    "/discover",
  ])
    expect(isViewAddress(path)).toBe(false);
  for (const section of OWNER_SUBPATHS) {
    expect(opensPage("/owner", `/owner/${section}`)).toBe(false);
    expect(opensPage(`/owner/${OWNER_SUBPATHS[0]}`, `/owner/${section}`)).toBe(
      false
    );
  }
  expect(isViewSwitch("/decks", "/trades/find")).toBe(false);
  expect(isViewSwitch("/decks/d1", "/decks/want-list")).toBe(false);
});
