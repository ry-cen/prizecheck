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
