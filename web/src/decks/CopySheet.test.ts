// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { CopySheet } from "./CopySheet";
import type { DeckLine } from "./deckListModel";
import type { EditNotice } from "./useDeckListEdits";

vi.mock("../ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", { role: "dialog" }, children) : null,
}));
vi.mock("../ui/CopyTile", () => ({ CopyArt: () => null }));
vi.mock("./SwapList", () => ({ SwapList: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
});

const LINE = {
  line: {
    edition_id: "edition",
    name: "Tangela",
    identity_name: "Tangela",
    image_url: null,
  },
  variant: "Normal",
  quantity: 3n,
  here: 3n,
  elsewhere: 0n,
  missing: 0n,
  places: [],
  copies: null,
  lent: 0n,
  reservedFor: [],
  lentTo: [],
  borrowedFrom: [],
  loans: [],
} as unknown as DeckLine;

function render(
  notice: EditNotice | null,
  extra: { quantity?: bigint; unconfirmed?: bigint } = {}
) {
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(CopySheet, {
        line: LINE,
        ordinal: null,
        onClose: vi.fn(),
        returnFocus: { current: null },
        editing: {
          deckId: "deck",
          quantity: extra.quantity ?? 3n,
          unconfirmed: extra.unconfirmed ?? 0n,
          onChange: vi.fn(),
          onSwap: vi.fn(),
          feedback: null,
          since: 0,
          notice,
        },
      })
    )
  );
}

const text = (node: Element | null | undefined) => node?.textContent ?? "";
const stepper = () => host.querySelector("[aria-label='Deck List copies']")!;

test("an unconfirmed change is explained inside the sheet, beside the stepper, with its Try again", () => {
  const retry = vi.fn();
  render(
    {
      id: 1,
      text: "Your last Deck List change may not have been saved. Try again to check safely.",
      retry,
    },
    { unconfirmed: 1n }
  );
  const status = [...host.querySelectorAll("[role='status']")].find((node) =>
    text(node).includes("may not have been saved")
  );
  expect(status).toBeTruthy();
  // The same block as the stepper, so the notice sits near the count it explains.
  expect(status!.parentElement!.contains(stepper())).toBe(true);
  const again = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Try again"
  );
  expect(again).toHaveLength(1);
  expect(again[0].parentElement!.contains(stepper())).toBe(true);
  act(() => again[0].click());
  expect(retry).toHaveBeenCalledTimes(1);
  // One count: the sheet's heading and the stepper agree, and the unconfirmed change is marked.
  expect(text(host.querySelector("#copy-sheet-copies"))).toBe(
    "3 on the Deck List"
  );
  expect(text(stepper())).toContain("3 on Deck List");
  expect(text(stepper().parentElement)).toContain("+1 not confirmed");
});

test("a refusal with no Try again still shows its words inside the sheet", () => {
  render({
    id: 1,
    text: "That card can't be added any more, so the Deck List wasn't changed.",
    retry: null,
  });
  expect(host.textContent).toContain("can't be added any more");
  expect(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent === "Try again"
    )
  ).toBe(false);
});

test("no notice, no error line or Try again", () => {
  render(null);
  expect(host.textContent).not.toContain("Try again");
  expect(host.textContent).not.toContain("not confirmed");
});

test("the error line is a polite status that is present before its words arrive, so it is announced once", () => {
  render(null);
  const before = host.querySelector("[data-edit-notice]");
  expect(before?.getAttribute("role")).toBe("status");
  act(() =>
    root.render(
      createElement(CopySheet, {
        line: LINE,
        ordinal: null,
        onClose: vi.fn(),
        returnFocus: { current: null },
        editing: {
          deckId: "deck",
          quantity: 3n,
          unconfirmed: 1n,
          onChange: vi.fn(),
          onSwap: vi.fn(),
          feedback: null,
          since: 0,
          notice: { id: 1, text: "May not have been saved.", retry: vi.fn() },
        },
      })
    )
  );
  const after = host.querySelector("[data-edit-notice]");
  expect(after).toBe(before);
  expect(text(after)).toBe("May not have been saved.");
  expect(host.querySelectorAll("[role='alert']")).toHaveLength(0);
});

test("the heading and the stepper show the same number: the page's count for the Edition, not the line's confirmed one", () => {
  // The line says 3 confirmed; a tap made after an unconfirmed +1 is queued, so the collector's count is 4.
  render(
    { id: 1, text: "May not have been saved.", retry: vi.fn() },
    { quantity: 4n, unconfirmed: 1n }
  );
  expect(text(host.querySelector("#copy-sheet-copies"))).toBe(
    "4 on the Deck List"
  );
  expect(text(stepper())).toContain("4 on Deck List");
  expect(text(stepper().parentElement)).toContain("+1 not confirmed");
});

test("a sheet without editing keeps the line's own count in its heading", () => {
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(CopySheet, {
        line: LINE,
        ordinal: null,
        onClose: vi.fn(),
        returnFocus: { current: null },
      })
    )
  );
  expect(text(host.querySelector("#copy-sheet-copies"))).toBe(
    "3 on the Deck List"
  );
});

test("the empty status region is never hidden from the accessibility tree", () => {
  render(null);
  const region = host.querySelector("[data-edit-notice]")!;
  expect(region.getAttribute("role")).toBe("status");
  expect(region.hasAttribute("hidden")).toBe(false);
  expect(region.className).not.toMatch(/(^|\s)(\S*:)?(hidden|invisible)(\s|$)/);
  expect(region.getAttribute("aria-hidden")).toBeNull();
});
