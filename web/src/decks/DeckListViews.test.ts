// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckListBody } from "./DeckListViews";
import { deckLine } from "./deckListModel";
import type { DeckListLine } from "../decks_generated";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
});
function render(editable = true) {
  root = createRoot(host);
  const onRemove = vi.fn();
  const lines = [3, 1].map((n, i) =>
    deckLine(
      {
        edition_id: String(i),
        name: String(i),
        quantity: String(n),
        in_deck: "0",
        descriptor: {},
        set_name: "Set",
        collector_number: "1",
      } as DeckListLine,
      undefined
    )
  );
  act(() =>
    root.render(
      createElement(DeckListBody, {
        view: "spread",
        groups: [{ key: "p", kind: "p", title: "Pokemon", copies: 4n, lines }],
        onOpen: vi.fn(),
        editing: editable
          ? { onRemove, onStep: vi.fn(), onDragStart: vi.fn() }
          : undefined,
      })
    )
  );
  return {
    buttons: [
      ...host.querySelectorAll<HTMLButtonElement>("li:first-child button"),
    ].slice(0, 3),
    onRemove,
  };
}
function key(button: HTMLButtonElement, key: string) {
  act(() => {
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}
test("a Spread line has one tabbable copy", () => {
  const { buttons } = render();
  expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
});
test("arrow keys, Home and End move within a line", () => {
  const { buttons: b } = render(false);
  act(() => b[0].focus());
  for (const [k, i] of [
    ["ArrowRight", 1],
    ["ArrowDown", 2],
    ["ArrowRight", 2],
    ["ArrowLeft", 1],
    ["ArrowUp", 0],
    ["ArrowUp", 0],
    ["End", 2],
    ["Home", 0],
  ] as const) {
    key(document.activeElement as HTMLButtonElement, k);
    expect(document.activeElement).toBe(b[i]);
  }
  expect(b[0].getAttribute("aria-keyshortcuts")).toBe(
    "ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
  );
});
test("focus on a copy makes it the line's tabbable copy", () => {
  const { buttons: b } = render();
  act(() => b[2].focus());
  expect(b.map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
});
test("Delete still calls onRemove", () => {
  const { buttons, onRemove } = render();
  key(buttons[0], "Delete");
  expect(onRemove).toHaveBeenCalledOnce();
});
