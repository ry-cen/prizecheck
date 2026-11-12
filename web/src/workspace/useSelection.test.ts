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
