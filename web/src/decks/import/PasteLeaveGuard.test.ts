// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeaveGuard } from "../../shell/useRoute";
import { pasteIsUnapplied, usePasteLeaveGuard } from "./PasteLeaveGuard";

// The page's leave guard is the shell's registry; here it is a stand-in that keeps the registered guard.
const registered: { guard: LeaveGuard | null } = { guard: null };
vi.mock("../../shell/useRoute", () => ({
  useLeaveGuard: (guard: LeaveGuard) => {
    registered.guard = guard;
  },
}));
vi.mock("../../ui/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let unapplied = false;

function Page({ deckName }: { deckName: string | null }) {
  const { dialog } = usePasteLeaveGuard(() => unapplied, deckName);
  return React.createElement("main", null, dialog);
}

async function show(deckName: string | null) {
  await act(async () => root.render(React.createElement(Page, { deckName })));
}

const dialog = () => host.querySelector("dialog");
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (each) => each.textContent === name
  );

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  registered.guard = null;
  unapplied = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.style.overflow = "";
});

it("counts pasted text, or a fix made to a pasted line, as unapplied, and whitespace as nothing", () => {
  expect(pasteIsUnapplied({ text: "", picks: 0, drops: 0 })).toBe(false);
  expect(pasteIsUnapplied({ text: " \n\t ", picks: 0, drops: 0 })).toBe(false);
  expect(pasteIsUnapplied({ text: "4 Iono PAL 185", picks: 0, drops: 0 })).toBe(
    true
  );
  // A copy of a Published Deck has no text; the collector's fixes are what would be lost.
  expect(pasteIsUnapplied({ text: "", picks: 1, drops: 0 })).toBe(true);
  expect(pasteIsUnapplied({ text: "", picks: 0, drops: 2 })).toBe(true);
});

it("blocks a leave only while the page says the paste is unapplied", async () => {
  await show("Garden practice");
  expect(registered.guard?.blocks()).toBe(false);
  unapplied = true;
  expect(registered.guard?.blocks()).toBe(true);
  // The save landed: the page clears it before it navigates, with no render in between.
  unapplied = false;
  expect(registered.guard?.blocks()).toBe(false);
});

it("asks 'Discard this pasted list?', naming the Deck List that stays as it was; Keep editing doesn't leave and Discard leaves once", async () => {
  unapplied = true;
  await show("Garden practice");
  const leave = vi.fn();
  expect(dialog()?.hasAttribute("open")).toBeFalsy();

  await act(async () => registered.guard?.ask(leave));
  expect(dialog()?.hasAttribute("open")).toBe(true);
  expect(dialog()?.textContent).toContain("Discard this pasted list?");
  expect(dialog()?.textContent).toContain(
    "Your pasted list will be discarded. Garden practice's Deck List stays as it was."
  );

  await act(async () => button("Keep editing")?.click());
  expect(dialog()?.hasAttribute("open")).toBeFalsy();
  expect(leave).not.toHaveBeenCalled();

  await act(async () => registered.guard?.ask(leave));
  await act(async () => button("Discard")?.click());
  expect(leave).toHaveBeenCalledTimes(1);
  expect(dialog()?.hasAttribute("open")).toBeFalsy();
});

it("says only that the pasted list is discarded when it was going into a new Deck", async () => {
  unapplied = true;
  await show(null);
  await act(async () => registered.guard?.ask(vi.fn()));
  expect(dialog()?.textContent).toContain(
    "Your pasted list will be discarded."
  );
  expect(dialog()?.textContent).not.toContain("Deck List");
});

it("asks the browser to warn on a reload or close only while the paste is unapplied", async () => {
  await show("Garden practice");
  const warns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(warns()).toBe(false);
  unapplied = true;
  expect(warns()).toBe(true);
  unapplied = false;
  expect(warns()).toBe(false);
  await act(async () => root.unmount());
  unapplied = true;
  // The page is gone, so its warning is too.
  expect(warns()).toBe(false);
  root = createRoot(host);
});
