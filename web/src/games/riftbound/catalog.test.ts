import { describe, it, expect, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { emptyQuery, listKey } from "./catalog";
import { fixtureReader } from "./local/fixtures";
import { parseView, viewHash } from "./navigation";
import { useRead } from "./read";

describe("Riftbound local read contract", () => {
  it("separates finishes and printings, supports only supplied facets, and pages", async () => {
    vi.useFakeTimers();
    try {
      const reader = fixtureReader();
      const read = async (q = emptyQuery) => {
        const pending = reader.list(q, new AbortController().signal);
        await vi.runAllTimersAsync();
        return pending;
      };
      const first = await read();
      expect(first.editions).toHaveLength(8);
      expect(first.total).toBe(14);
      expect((await read({ ...emptyQuery, page: 2 })).editions).toHaveLength(6);
      const scout = await read({ ...emptyQuery, search: "ember" });
      expect(scout.editions.map((e) => [e.printingId, e.finish])).toEqual([
        ["1", "Standard"],
        ["1", "Foil"],
        ["4", "Showcase"],
      ]);
      expect(
        (await read({ ...emptyQuery, search: "001" })).editions
      ).toHaveLength(2);
      expect(
        (await read({ ...emptyQuery, type: "Battlefield" })).editions[0]
          .orientation
      ).toBe("landscape");
      expect(
        (await read({ ...emptyQuery, domain: "Fury", set: "2" })).total
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("round trips game-owned history with overlapping IDs and no preference writes", () => {
    const view = {
      query: { ...emptyQuery, search: "001", page: 2 },
      edition: "1",
      home: false,
    };
    expect(parseView(viewHash(view))).toEqual(view);
    expect(listKey(emptyQuery)).toContain("riftbound");
    expect(parseView("#pokemon:edition=1").edition).toBe("");
    expect(parseView("#riftbound:page=NaN").query.page).toBe(1);
  });
  it("ignores late success and failure, including leaving and returning, even when abort is ignored", async () => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let resolveOld!: (v: string) => void;
    let rejectOld!: (e: Error) => void;
    const old = () =>
      new Promise<string>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
    const current = () => Promise.resolve("new");
    const root = createRoot(document.getElementById("root")!);
    function Probe({
      id,
      active,
      load,
    }: {
      id: string;
      active: boolean;
      load: (s: AbortSignal) => Promise<string>;
    }) {
      const result = useRead(id, load, active);
      return createElement(
        "p",
        null,
        result.failed ? "failed" : (result.value ?? "loading")
      );
    }
    try {
      await act(async () =>
        root.render(
          createElement(Probe, { id: "riftbound:1", active: true, load: old })
        )
      );
      await act(async () =>
        root.render(
          createElement(Probe, {
            id: "riftbound:2",
            active: true,
            load: current,
          })
        )
      );
      await act(async () => resolveOld("old"));
      expect(document.body.textContent).toBe("new");
      await act(async () =>
        root.render(
          createElement(Probe, { id: "riftbound:1", active: true, load: old })
        )
      );
      await act(async () =>
        root.render(
          createElement(Probe, { id: "riftbound:1", active: false, load: old })
        )
      );
      await act(async () => rejectOld(new Error("late")));
      await act(async () =>
        root.render(
          createElement(Probe, {
            id: "riftbound:1",
            active: true,
            load: current,
          })
        )
      );
      expect(document.body.textContent).toBe("new");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
});
