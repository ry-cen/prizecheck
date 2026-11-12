// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { DetailsSheet } from "./Inspector";
import type { Inspected } from "./useSelection";
vi.mock("../ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
vi.mock("../EditionPrice", () => ({ EditionPrice: () => null }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test.each([false, true])(
  "sheet shortcuts preserve the borrowed restriction (borrowed=%s)",
  (borrowed) => {
    const card = {
      ordinal: 2,
      holding: {
        key: "leaf:edition",
        copies: 4,
        borrowed: borrowed ? { lender: "Sam" } : undefined,
        holding: {
          edition_id: "edition",
          printing_id: "printing",
          printing_name: "Abra",
          location_id: "leaf",
          descriptor: {},
        },
      },
    } as Inspected;
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const node = document.createElement("div");
    const root = createRoot(node);
    act(() =>
      root.render(
        React.createElement(DetailsSheet, {
          card,
          locationPath: () => "Binder",
          ownerRevision: 1,
          ownedTotals: new Map([["1:edition", []]]),
          onClose: vi.fn(),
          onMove,
          onRemove,
        })
      )
    );
    try {
      const buttons = [...node.querySelectorAll("button")];
      const move = buttons.find((button) => button.textContent === "Move…")!;
      expect(move).toBeDefined();
      act(() => move.click());
      expect(onMove).toHaveBeenCalledWith(move);
      const remove = buttons.find((button) => button.textContent === "Remove…");
      expect(!!remove).toBe(!borrowed);
      if (remove) {
        act(() => remove.click());
        expect(onRemove).toHaveBeenCalledWith(remove);
      }
    } finally {
      act(() => root.unmount());
    }
  }
);
