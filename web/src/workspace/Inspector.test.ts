// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { DetailsSheet, Inspector } from "./Inspector";
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

test.each([false, true])(
  "the desktop aside offers Move… and Remove… for the copy shown (borrowed=%s)",
  (borrowed) => {
    const card = {
      ordinal: 0,
      holding: {
        key: "leaf:edition",
        copies: 1,
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
    const render = (actionsDisabled: boolean) =>
      act(() =>
        root.render(
          React.createElement(Inspector, {
            card,
            locationPath: () => "Binder",
            ownerRevision: 1,
            ownedTotals: new Map([["1:edition", []]]),
            onMove,
            onRemove,
            actionsDisabled,
          })
        )
      );
    render(false);
    try {
      const buttons = () => [...node.querySelectorAll("button")];
      expect(buttons().map((button) => button.textContent)).toEqual(
        borrowed ? ["Move…"] : ["Move…", "Remove…"]
      );
      const [move, remove] = buttons();
      act(() => move.click());
      expect(onMove).toHaveBeenCalledWith(move);
      if (!borrowed) {
        act(() => remove.click());
        expect(onRemove).toHaveBeenCalledWith(remove);
      }
      render(true);
      expect(buttons().every((button) => button.disabled)).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  }
);

test("the empty aside has no Move… or Remove…", () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  act(() =>
    root.render(
      React.createElement(Inspector, {
        card: null,
        locationPath: () => "Binder",
        ownerRevision: 1,
        ownedTotals: new Map(),
        onMove: vi.fn(),
        onRemove: vi.fn(),
      })
    )
  );
  try {
    expect(node.querySelectorAll("button")).toHaveLength(0);
  } finally {
    act(() => root.unmount());
  }
});
