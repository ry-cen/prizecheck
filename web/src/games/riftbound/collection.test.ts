import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  collectionKey,
  emptyCollectionQuery,
  expandCopies,
  pageHoldings,
  plural,
} from "./collection";
import { collectionFixtureReader } from "./local/collectionFixtures";
import { editions } from "./local/fixtures";
import { parseView, viewHash } from "./navigation";
import { CollectionView } from "./CollectionView";
import { RiftboundApp } from "./RiftboundApp";
import { fixtureReader } from "./local/fixtures";
import { useRead } from "./read";
const signal = () => new AbortController().signal;
async function flush<T>(pending: Promise<T>) {
  await vi.runAllTimersAsync();
  return pending;
}
describe("fixture Collection", () => {
  it("pluralizes copy and edition totals locally", () => {
    expect(plural(1, "copy", "copies")).toBe("1 copy");
    expect(plural(2, "copy", "copies")).toBe("2 copies");
    expect(plural(1, "edition", "editions")).toBe("1 edition");
    expect(plural(2, "edition", "editions")).toBe("2 editions");
  });
  it("pages copy ranges without changing Holding quantities", () => {
    const before = {
      edition: editions[0],
      locationId: "1",
      quantity: 23,
      version: 1,
    };
    const split = {
      edition: editions[1],
      locationId: "1",
      quantity: 3,
      version: 1,
    };
    const first = pageHoldings([before, split], 1);
    const second = pageHoldings([before, split], 2);
    expect(first[1]).toEqual({ ...split, copies: { first: 0, count: 1 } });
    expect(second[0]).toEqual({ ...split, copies: { first: 1, count: 2 } });
    expect(expandCopies(first)).toHaveLength(24);
    expect(expandCopies(second).map((r) => r.copy)).toEqual([1, 2]);
  });
  it("expands copies, searches, pages, includes retained snapshots", async () => {
    vi.useFakeTimers();
    try {
      const reader = collectionFixtureReader("a");
      const read = (patch = {}) =>
        flush(reader.list({ ...emptyCollectionQuery, ...patch }, signal()));
      const all = await read();
      expect(expandCopies(all.rows)).toHaveLength(24);
      expect(all.totals).toEqual({ copies: 36, editions: 13 });
      expect(expandCopies((await read({ page: 2 })).rows)).toHaveLength(12);
      const scouts = await read({ search: "001" });
      expect(scouts.totals).toEqual({ copies: 7, editions: 2 });
      expect(new Set(scouts.rows.map((r) => r.edition.finish))).toEqual(
        new Set(["Standard", "Foil"])
      );
      expect((await read({ location: "3" })).totals.copies).toBe(30);
      expect((await read({ location: "2" })).rows).toEqual([]);
      const retained = await read({ search: "forgotten" });
      expect(retained.rows[0].edition.id).toBe("retained");
      expect(editions.some((e) => e.id === retained.rows[0].edition.id)).toBe(
        false
      );
      expect(
        (await read({ search: "moonlit" })).rows[0].edition.orientation
      ).toBe("landscape");
      const emptyLeaf = await read({ location: "5" });
      expect(emptyLeaf.rows).toEqual([]);
      expect(emptyLeaf.collectionEmpty).toBe(false);
      expect(
        (
          await flush(
            collectionFixtureReader("a", "empty").list(
              emptyCollectionQuery,
              signal()
            )
          )
        ).collectionEmpty
      ).toBe(true);
      const b = await flush(
        collectionFixtureReader("b").list(emptyCollectionQuery, signal())
      );
      expect(b.rows[0].edition.id).toBe(all.rows[0].edition.id);
      expect(b.rows[0].edition.name).toBe("Beacon Keeper");
      expect(b.totals.copies).toBe(2);
      expect(collectionKey("a", emptyCollectionQuery)).not.toBe(
        collectionKey("b", emptyCollectionQuery)
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("recovers independent tree and list failures and aborts timers", async () => {
    vi.useFakeTimers();
    try {
      const reader = collectionFixtureReader("a", "failure");
      const list = expect(
        reader.list(emptyCollectionQuery, signal())
      ).rejects.toThrow("Synthetic failure");
      const tree = expect(reader.locations(signal())).rejects.toThrow(
        "Synthetic failure"
      );
      await vi.runAllTimersAsync();
      await Promise.all([list, tree]);
      expect(
        (await flush(reader.list(emptyCollectionQuery, signal()))).rows.length
      ).toBeGreaterThan(0);
      expect(await flush(reader.locations(signal()))).toHaveLength(5);
      const controller = new AbortController();
      const aborted = expect(
        reader.locations(controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await aborted;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("round trips Collection addresses and preserves old Catalog addresses exactly", () => {
    const old = parseView(
      "#riftbound:search=001&page=2&edition=1&view=catalog"
    );
    expect(old).toEqual({
      query: { search: "001", page: 2, set: "", domain: "", type: "" },
      edition: "1",
      home: false,
    });
    const view = {
      ...old,
      section: "collection" as const,
      collection: { location: "2", search: "001", page: 2 },
    };
    expect(parseView(viewHash(view))).toEqual(view);
    for (const patch of [{ location: "2" }, { search: "x" }, { page: 2 }])
      expect(
        collectionKey("a", { ...emptyCollectionQuery, ...patch })
      ).not.toBe(collectionKey("a", emptyCollectionQuery));
  });
  it("rejects a late Location response and rekeys a changed owner with colliding ids", async () => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.getElementById("root")!);
    let resolve!: (s: string) => void;
    const old = () =>
      new Promise<string>((r) => {
        resolve = r;
      });
    const current = () => Promise.resolve("Blue binder");
    const otherOwner = () => Promise.resolve("Beacon Keeper");
    function Probe({
      owner,
      location,
      load,
    }: {
      owner: string;
      location: string;
      load: (s: AbortSignal) => Promise<string>;
    }) {
      const value = useRead(
        collectionKey(owner, { ...emptyCollectionQuery, location }),
        load
      );
      return createElement("p", null, value.value ?? "loading");
    }
    try {
      await act(async () =>
        root.render(
          createElement(Probe, { owner: "a", location: "1", load: old })
        )
      );
      await act(async () =>
        root.render(
          createElement(Probe, { owner: "a", location: "3", load: current })
        )
      );
      expect(document.body.textContent).toBe("Blue binder");
      await act(async () => resolve("Unsorted"));
      expect(document.body.textContent).toBe("Blue binder");
      await act(async () =>
        root.render(
          createElement(Probe, { owner: "b", location: "3", load: otherOwner })
        )
      );
      expect(document.body.textContent).toBe("Beacon Keeper");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
  it.each([1, 2])(
    "rekeys reads and selection when the owner changes on page %s",
    async (pageNumber) => {
      vi.useFakeTimers();
      const dom = new JSDOM('<div id="root"></div>', {
        url: `http://localhost/#riftbound:section=collection&collectionPage=${pageNumber}`,
      });
      Object.defineProperty(dom.window, "matchMedia", {
        value: () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        }),
      });
      for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        history: dom.window.history,
        HTMLElement: dom.window.HTMLElement,
        IS_REACT_ACT_ENVIRONMENT: true,
      }))
        vi.stubGlobal(name, value);
      const root = createRoot(document.getElementById("root")!);
      const reader = fixtureReader();
      try {
        await act(async () =>
          root.render(
            createElement(RiftboundApp, {
              reader,
              collection: collectionFixtureReader("a"),
            })
          )
        );
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        const tile = document.querySelector<HTMLButtonElement>(
          'section[aria-label="Collection results"] li button'
        )!;
        expect(tile.getAttribute("aria-label")).toContain(
          pageNumber === 1 ? "Ember Scout" : "Shore Guardian"
        );
        await act(async () => tile.click());
        expect(
          document.querySelectorAll('li button[aria-pressed="true"]')
        ).toHaveLength(1);
        await act(async () =>
          root.render(
            createElement(RiftboundApp, {
              reader,
              collection: collectionFixtureReader("b"),
            })
          )
        );
        expect(document.body.textContent).not.toContain("Ember Scout");
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(document.body.textContent).not.toContain(
          "No cards in this Location."
        );
        // A smaller owner's invalid page resolves first; its replacement page is a second read.
        expect(
          new URLSearchParams(location.hash.slice(11)).get("collectionPage")
        ).toBe("1");
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        const labels = [
          ...document.querySelectorAll(
            'section[aria-label="Collection results"] li button'
          ),
        ].map((e) => e.getAttribute("aria-label"));
        expect(labels).toHaveLength(2);
        expect(
          document.querySelector('aside[aria-label="Card details"] h2')
        ).toBeNull();
        expect(
          document.querySelectorAll('li button[aria-pressed="true"]')
        ).toHaveLength(0);
        expect(
          new URLSearchParams(location.hash.slice(11)).get("collectionPage")
        ).toBe("1");
        expect(document.body.textContent).not.toContain(
          "No cards in this Location."
        );
        expect(labels.every((label) => label?.includes("Beacon Keeper"))).toBe(
          true
        );
        expect(document.body.textContent).not.toContain("Ember Scout");
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  );
  it("pauses Collection reads while inactive and keeps values on return", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM('<div id="root"></div>');
    Object.defineProperty(dom.window, "matchMedia", {
      value: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.getElementById("root")!);
    const reader = collectionFixtureReader("a");
    const tree = vi.spyOn(reader, "locations");
    const list = vi.spyOn(reader, "list");
    const noop = () => {};
    const render = (active: boolean) =>
      act(async () =>
        root.render(
          createElement(CollectionView, {
            reader,
            active,
            query: emptyCollectionQuery,
            onQuery: noop,
            hrefFor: () => "#",
            onCatalog: noop,
          })
        )
      );
    try {
      await render(false);
      expect(tree).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      await render(true);
      expect(tree).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(
        document.querySelectorAll('section[aria-label="Collection results"] li')
      ).toHaveLength(24);
      await render(false);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(tree).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      await render(true);
      expect(
        document.querySelectorAll('section[aria-label="Collection results"] li')
      ).toHaveLength(24);
      expect(tree).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
