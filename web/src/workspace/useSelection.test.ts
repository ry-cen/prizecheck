// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useSelection, type SelectionState } from "./useSelection";
import type { GalleryHolding } from "./galleryModel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("a sheet action selects one viewed copy and restores the prior selection on cancel", () => {
  const holding = {
    key: "leaf:edition",
    copies: 5,
    start: 0,
    holding: { location_id: "leaf", edition_id: "edition", version: 1 },
  } as GalleryHolding;
  const holdings = [holding];
  const byKey = new Map([[holding.key, holding]]);
  let selection!: SelectionState;
  const node = document.createElement("div");
  const root = createRoot(node);
  function Host() {
    selection = useSelection({
      holdings,
      byKey,
      status: "ready",
      scope: "all",
      mobile: true,
    });
    return null;
  }
  act(() => root.render(React.createElement(Host)));
  try {
    // Existing Select-mode selection remains intact after cancelling a shortcut.
    act(() =>
      selection.marquee({ phase: "move", additive: false, spans: [[0, 1]] })
    );
    const previous = selection.selected;
    let restore!: () => void;
    act(() => {
      restore = selection.selectForAction({ holding, ordinal: 3 });
    });
    expect(selection.summary.copies).toBe(1);
    expect(selection.selected.get(holding.key)?.runs).toEqual([[3, 4]]);
    act(() => restore());
    expect(selection.selected).toBe(previous);
    expect(selection.summary.copies).toBe(2);
    act(() => selection.clear());
    act(() => {
      restore = selection.selectForAction({ holding, ordinal: 4 });
    });
    expect(selection.summary.copies).toBe(1);
    act(() => restore());
    expect(selection.summary.copies).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});

test("cancel reconciles the saved selection and focus after a complete action-error refresh", () => {
  const a = {
    key: "leaf:a",
    start: 0,
    copies: 3,
    holding: { location_id: "leaf", edition_id: "a", version: 1 },
  } as GalleryHolding;
  const b = {
    key: "leaf:b",
    start: 3,
    copies: 2,
    holding: { location_id: "leaf", edition_id: "b", version: 1 },
  } as GalleryHolding;
  let holdings = [a, b];
  let byKey = new Map(holdings.map((holding) => [holding.key, holding]));
  let selection!: SelectionState;
  const root = createRoot(document.createElement("div"));
  function Host() {
    selection = useSelection({
      holdings,
      byKey,
      status: "ready",
      scope: "all",
      mobile: false,
    });
    return null;
  }
  act(() => root.render(React.createElement(Host)));
  try {
    // Select A and B, with B as the inspector's focus.
    act(() =>
      selection.activate(
        { holding: a, ordinal: 0, index: 0 },
        { kind: "click", toggle: false, range: false }
      )
    );
    act(() =>
      selection.activate(
        { holding: b, ordinal: 0, index: 3 },
        { kind: "click", toggle: true, range: false }
      )
    );
    let restore!: () => void;
    act(() => {
      restore = selection.selectForAction({ holding: a, ordinal: 0 });
    });
    const updated = { ...a, copies: 1, holding: { ...a.holding, version: 7 } };
    holdings = [updated];
    byKey = new Map([[updated.key, updated]]);
    act(() => root.render(React.createElement(Host)));
    // Reconciliation of the temporary selection has already settled before Cancel.
    act(() => restore());
    expect(selection.selected.has(b.key)).toBe(false);
    expect(selection.selected.get(a.key)?.version).toBe(7);
    expect(selection.summary.copies).toBe(1);
    expect(selection.inspected?.holding).toBe(updated);
    expect(selection.inspected?.ordinal).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});

for (const hadCompleteSnapshot of [false, true]) {
  test.each(["loading", "partial", "error"] as const)(
    `Cancel preserves an incomplete %s selection (prior complete snapshot: ${hadCompleteSnapshot})`,
    (initialStatus) => {
      const holding = {
        key: "leaf:partial",
        start: 0,
        copies: 3,
        holding: { location_id: "leaf", edition_id: "partial", version: 1 },
      } as GalleryHolding;
      let holdings: GalleryHolding[] = [];
      let byKey = new Map<string, GalleryHolding>();
      let status: import("./galleryModel").GalleryStatus = hadCompleteSnapshot
        ? "ready"
        : "loading";
      let selection!: SelectionState;
      const root = createRoot(document.createElement("div"));
      function Host() {
        selection = useSelection({
          holdings,
          byKey,
          status,
          scope: "all",
          mobile: false,
        });
        return null;
      }
      const render = () => act(() => root.render(React.createElement(Host)));
      render();
      try {
        holdings = [holding];
        byKey = new Map([[holding.key, holding]]);
        status = initialStatus;
        render();
        act(() =>
          selection.activate(
            { holding, ordinal: 0, index: 0 },
            { kind: "click", toggle: false, range: false }
          )
        );
        act(() =>
          selection.activate(
            { holding, ordinal: 1, index: 1 },
            { kind: "click", toggle: true, range: false }
          )
        );
        const previous = selection.selected;
        let restore!: () => void;
        act(() => {
          restore = selection.selectForAction({ holding, ordinal: 1 });
        });
        expect(selection.summary.copies).toBe(1);
        act(() => restore());
        expect(selection.selected).toBe(previous);
        expect(selection.summary.copies).toBe(2);
        expect(selection.inspected?.ordinal).toBe(1);
        status = "ready";
        render();
        expect(selection.selected).toBe(previous);
        expect(selection.summary.copies).toBe(2);
      } finally {
        act(() => root.unmount());
      }
    }
  );
}

test("completion after Cancel during refresh reconciles the inspected ordinal as well as selection", () => {
  const holding = {
    key: "leaf:refresh",
    start: 0,
    copies: 3,
    holding: { location_id: "leaf", edition_id: "refresh", version: 1 },
  } as GalleryHolding;
  let holdings = [holding];
  let byKey = new Map([[holding.key, holding]]);
  let status: import("./galleryModel").GalleryStatus = "ready";
  let selection!: SelectionState;
  const root = createRoot(document.createElement("div"));
  function Host() {
    selection = useSelection({
      holdings,
      byKey,
      status,
      scope: "all",
      mobile: false,
    });
    return null;
  }
  const render = () => act(() => root.render(React.createElement(Host)));
  render();
  try {
    act(() =>
      selection.activate(
        { holding, ordinal: 0, index: 0 },
        { kind: "click", toggle: false, range: false }
      )
    );
    act(() =>
      selection.activate(
        { holding, ordinal: 2, index: 2 },
        { kind: "click", toggle: false, range: true }
      )
    );
    expect(selection.summary.copies).toBe(3);
    expect(selection.inspected?.ordinal).toBe(2);
    let restore!: () => void;
    act(() => {
      restore = selection.selectForAction({ holding, ordinal: 2 });
    });
    status = "loading";
    holdings = [];
    byKey = new Map();
    render();
    act(() => restore());
    expect(selection.summary.copies).toBe(3);
    const updated = {
      ...holding,
      copies: 1,
      holding: { ...holding.holding, version: 2 },
    };
    holdings = [updated];
    byKey = new Map([[updated.key, updated]]);
    status = "ready";
    render();
    expect(selection.summary.copies).toBe(1);
    expect(selection.inspected?.ordinal).toBe(0);
    expect(selection.inspected?.holding).toBe(updated);
    act(() => selection.openDetails());
    expect(selection.details?.ordinal).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});

for (const changed of [false, true]) {
  test.each(["loading", "partial", "error", "ready"] as const)(
    `Cancel/complete matrix: %s gallery, inventory ${changed ? "changed" : "unchanged"}`,
    (cancelStatus) => {
      const holding = {
        key: "leaf:matrix",
        start: 0,
        copies: 3,
        holding: { location_id: "leaf", edition_id: "matrix", version: 1 },
      } as GalleryHolding;
      let holdings = [holding];
      let byKey = new Map([[holding.key, holding]]);
      let status: import("./galleryModel").GalleryStatus = "ready";
      let selection!: SelectionState;
      const root = createRoot(document.createElement("div"));
      function Host() {
        selection = useSelection({
          holdings,
          byKey,
          status,
          scope: "all",
          mobile: false,
        });
        return null;
      }
      const render = () => act(() => root.render(React.createElement(Host)));
      render();
      try {
        act(() =>
          selection.activate(
            { holding, ordinal: 0, index: 0 },
            { kind: "click", toggle: false, range: false }
          )
        );
        act(() =>
          selection.activate(
            { holding, ordinal: 2, index: 2 },
            { kind: "click", toggle: false, range: true }
          )
        );
        const previous = selection.selected;
        let restore!: () => void;
        act(() => {
          restore = selection.selectForAction({ holding, ordinal: 2 });
        });
        const updated = changed
          ? {
              ...holding,
              copies: 1,
              holding: { ...holding.holding, version: 2 },
            }
          : holding;
        holdings = cancelStatus === "loading" ? [] : [updated];
        byKey = new Map(holdings.map((row) => [row.key, row]));
        status = cancelStatus;
        render();
        act(() => restore());
        if (cancelStatus !== "ready" || !changed) {
          expect(selection.selected).toBe(previous);
          expect(selection.inspected?.ordinal).toBe(2);
        }
        holdings = [updated];
        byKey = new Map([[updated.key, updated]]);
        status = "ready";
        render();
        expect(selection.summary.copies).toBe(changed ? 1 : 3);
        expect(selection.inspected?.ordinal).toBe(changed ? 0 : 2);
        expect(selection.selected.get(updated.key)?.version).toBe(
          changed ? 2 : 1
        );
        act(() => selection.openDetails());
        expect(selection.details?.ordinal).toBe(changed ? 0 : 2);
        if (!changed) expect(selection.selected).toBe(previous);
      } finally {
        act(() => root.unmount());
      }
    }
  );
}

// Desktop inspector address (S14e): the inspected card is reported once per change, desktop only.
function inspectHarness(initial: { mobile: boolean; scope?: string }) {
  const make = (key: string, start: number, copies: number) =>
    ({
      key,
      start,
      copies,
      holding: { location_id: "leaf", edition_id: key, version: 1 },
    }) as GalleryHolding;
  const a = make("leaf:a", 0, 3);
  const b = make("leaf:b", 3, 2);
  let holdings = [a, b];
  let byKey = new Map(holdings.map((row) => [row.key, row]));
  let scope = initial.scope ?? "all";
  const reports: Array<{ key: string; ordinal: number } | null> = [];
  let selection!: SelectionState;
  const root = createRoot(document.createElement("div"));
  function Host() {
    selection = useSelection({
      holdings,
      byKey,
      status: "ready",
      scope,
      mobile: initial.mobile,
      onInspect: (card) =>
        reports.push(card && { key: card.holding.key, ordinal: card.ordinal }),
    });
    return null;
  }
  const render = () => act(() => root.render(React.createElement(Host)));
  render();
  const click = (
    holding: GalleryHolding,
    ordinal: number,
    gesture: { toggle?: boolean; range?: boolean } = {}
  ) =>
    act(() =>
      selection.activate(
        { holding, ordinal, index: holding.start + ordinal },
        { kind: "click", toggle: !!gesture.toggle, range: !!gesture.range }
      )
    );
  return {
    a,
    b,
    reports,
    click,
    render,
    get selection() {
      return selection;
    },
    setScope: (next: string) => {
      scope = next;
      render();
    },
    setHoldings: (next: GalleryHolding[]) => {
      holdings = next;
      byKey = new Map(next.map((row) => [row.key, row]));
      render();
    },
    unmount: () => act(() => root.unmount()),
  };
}

test("a desktop click reports the inspected card, and deselecting reports null", () => {
  const h = inspectHarness({ mobile: false });
  try {
    expect(h.reports).toEqual([]);
    h.click(h.a, 1);
    expect(h.reports).toEqual([{ key: "leaf:a", ordinal: 1 }]);
    h.click(h.a, 1);
    expect(h.reports).toEqual([{ key: "leaf:a", ordinal: 1 }, null]);
  } finally {
    h.unmount();
  }
});

test("a ctrl-click reports the last clicked card, and Escape-style clear reports null", () => {
  const h = inspectHarness({ mobile: false });
  try {
    h.click(h.a, 0);
    h.click(h.b, 1, { toggle: true });
    expect(h.reports.at(-1)).toEqual({ key: "leaf:b", ordinal: 1 });
    expect(h.reports).toHaveLength(2);
    act(() => h.selection.clear());
    expect(h.reports.at(-1)).toBeNull();
  } finally {
    h.unmount();
  }
});

test("a marquee reports once, when the drag ends", () => {
  const h = inspectHarness({ mobile: false });
  try {
    act(() =>
      h.selection.marquee({ phase: "start", additive: false, spans: [] })
    );
    act(() =>
      h.selection.marquee({ phase: "move", additive: false, spans: [[0, 1]] })
    );
    act(() =>
      h.selection.marquee({ phase: "move", additive: false, spans: [[0, 3]] })
    );
    expect(h.reports).toEqual([]);
    act(() =>
      h.selection.marquee({ phase: "end", additive: false, spans: [[0, 3]] })
    );
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).not.toBeNull();
  } finally {
    h.unmount();
  }
});

test("a phone tap and Select mode report nothing", () => {
  const h = inspectHarness({ mobile: true });
  try {
    h.click(h.a, 0);
    act(() => h.selection.setSelectMode(true));
    h.click(h.b, 0);
    expect(h.reports).toEqual([]);
  } finally {
    h.unmount();
  }
});

test("mount and a scope change report nothing", () => {
  const h = inspectHarness({ mobile: false });
  try {
    expect(h.reports).toEqual([]);
    h.setScope("other");
    expect(h.reports).toEqual([]);
    h.click(h.a, 0);
    h.setScope("third");
    expect(h.reports).toEqual([{ key: "leaf:a", ordinal: 0 }, null]);
  } finally {
    h.unmount();
  }
});

test("reconcile dropping the inspected Holding reports null", () => {
  const h = inspectHarness({ mobile: false });
  try {
    h.click(h.a, 0);
    h.setHoldings([h.b]);
    expect(h.reports).toEqual([{ key: "leaf:a", ordinal: 0 }, null]);
  } finally {
    h.unmount();
  }
});
