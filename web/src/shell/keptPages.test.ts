import { describe, expect, it } from "vitest";
import { activationRead, mountedPages, pageAddress } from "./keptPages";
import { PAGES, type PageId } from "./routes";
const set = (...ids: PageId[]) => new Set(ids);

describe("kept page slots", () => {
  it("mounts the shown, visited and warmed roots once, in tab order", () => {
    expect(
      mountedPages(
        "decks",
        set("collection", "decks"),
        set("decks", "loans"),
        false
      ).map((p) => p.id)
    ).toEqual(["collection", "decks", "loans"]);
  });
  it("keeps roots under public and Friend pages", () => {
    expect(
      mountedPages(null, set("decks"), set("collection"), false).map(
        (p) => p.id
      )
    ).toEqual(["collection", "decks"]);
  });
  it("excludes a former owner's hidden slot but permits the explicit owner address", () => {
    expect(mountedPages(null, set("owner"), set("owner"), false)).toEqual([]);
    expect(mountedPages("owner", set(), set(), false).map((p) => p.id)).toEqual(
      ["owner"]
    );
    expect(
      mountedPages(null, set(), set("owner"), true).map((p) => p.id)
    ).toEqual(["owner"]);
  });
  it("uses the live address only for the shown slot", () => {
    for (const page of PAGES) {
      expect(pageAddress(page.id, false, "/trades/conversation/example")).toBe(
        page.path
      );
      expect(pageAddress(page.id, true, "/trades/conversation/example")).toBe(
        "/trades/conversation/example"
      );
    }
  });
});

describe("activation reads", () => {
  it("leaves a successful or in-flight warm read alone on the first show", () => {
    expect(activationRead(false, false, false)).toBeNull();
  });
  it("retries a failed warm read normally on the first show", () => {
    expect(activationRead(false, true, false)).toBe(false);
  });
  it("keeps later reads quiet even when an earlier read failed", () => {
    expect(activationRead(true, false, false)).toBe(true);
    expect(activationRead(true, true, false)).toBe(true);
  });
  it("preserves paginated rows by skipping activation reads", () => {
    expect(activationRead(true, false, true)).toBeNull();
  });
});
