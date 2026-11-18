// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeaveGuard } from "../../shell/useRoute";
import {
  draftIsUnapplied,
  usePasteLeaveGuard,
  type Flow,
  type Pending,
} from "./PasteLeaveGuard";

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
let pending: Pending = "none";

function Page({ flow }: { flow: Flow }) {
  const { dialog } = usePasteLeaveGuard(() => pending, flow);
  return React.createElement("main", null, dialog);
}

async function show(flow: Flow) {
  await act(async () => root.render(React.createElement(Page, { flow })));
}
const REPLACE: Flow = { kind: "replace", deckName: "Garden practice" };

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
  pending = "none";
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
  expect(draftIsUnapplied({ text: "", picks: 0, drops: 0 })).toBe(false);
  expect(draftIsUnapplied({ text: " \n\t ", picks: 0, drops: 0 })).toBe(false);
  expect(draftIsUnapplied({ text: "4 Iono PAL 185", picks: 0, drops: 0 })).toBe(
    true
  );
  // A copy of a Published Deck has no text; the collector's fixes are what would be lost.
  expect(draftIsUnapplied({ text: "", picks: 1, drops: 0 })).toBe(true);
  expect(draftIsUnapplied({ text: "", picks: 0, drops: 2 })).toBe(true);
});

it("blocks a leave while the page holds an unapplied draft or a save that hasn't finished, and not otherwise", async () => {
  await show(REPLACE);
  expect(registered.guard?.blocks()).toBe(false);
  pending = "unapplied";
  expect(registered.guard?.blocks()).toBe(true);
  pending = "saving";
  expect(registered.guard?.blocks()).toBe(true);
  // The save landed: the page clears it before it navigates, with no render in between.
  pending = "none";
  expect(registered.guard?.blocks()).toBe(false);
});

it("asks 'Discard this pasted list?', naming the Deck List that stays as it was; Keep editing doesn't leave and Discard leaves once", async () => {
  pending = "unapplied";
  await show(REPLACE);
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
  pending = "unapplied";
  await show({ kind: "new" });
  await act(async () => registered.guard?.ask(vi.fn()));
  expect(dialog()?.textContent).toContain(
    "Your pasted list will be discarded."
  );
  expect(dialog()?.textContent).not.toContain("Deck List");
});

it("names the review changes, not a pasted list, when the draft is a copy of a Published Deck", async () => {
  pending = "unapplied";
  await show({ kind: "copy" });
  const leave = vi.fn();
  await act(async () => registered.guard?.ask(leave));
  expect(dialog()?.textContent).toContain("Discard your review changes?");
  expect(dialog()?.textContent).toContain(
    "The cards you picked or removed while checking this list won't be kept."
  );
  expect(dialog()?.textContent).not.toMatch(/paste/i);
  expect(dialog()?.innerHTML).toContain("Back to the review");
  await act(async () => button("Keep editing")?.click());
  expect(leave).not.toHaveBeenCalled();
  await act(async () => registered.guard?.ask(leave));
  await act(async () => button("Discard")?.click());
  expect(leave).toHaveBeenCalledTimes(1);
});

it("says the list is still saving while a save is pending: Stay keeps the page, Leave goes", async () => {
  pending = "saving";
  await show(REPLACE);
  const leave = vi.fn();
  await act(async () => registered.guard?.ask(leave));
  expect(dialog()?.textContent).toContain("Your list is still saving");
  expect(dialog()?.textContent).toContain(
    "Leave now and you won't see whether it replaced Garden practice's Deck List."
  );
  expect(dialog()?.textContent).not.toMatch(/discard/i);
  await act(async () => button("Stay")?.click());
  expect(dialog()?.hasAttribute("open")).toBeFalsy();
  expect(leave).not.toHaveBeenCalled();
  await act(async () => registered.guard?.ask(leave));
  await act(async () => button("Leave")?.click());
  expect(leave).toHaveBeenCalledTimes(1);
});

it("keeps the question it was asked with even if the page's state changes while it is open", async () => {
  pending = "saving";
  await show({ kind: "new" });
  await act(async () => registered.guard?.ask(vi.fn()));
  expect(dialog()?.textContent).toContain(
    "Leave now and you won't see whether it saved."
  );
  pending = "unapplied";
  await act(async () =>
    root.render(React.createElement(Page, { flow: { kind: "new" } }))
  );
  expect(dialog()?.textContent).toContain("Your list is still saving");
});

it("asks the browser to warn on a reload or close while a draft is unapplied or a save is pending", async () => {
  await show(REPLACE);
  const warns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(warns()).toBe(false);
  pending = "unapplied";
  expect(warns()).toBe(true);
  pending = "saving";
  expect(warns()).toBe(true);
  pending = "none";
  expect(warns()).toBe(false);
  await act(async () => root.unmount());
  pending = "unapplied";
  // The page is gone, so its warning is too.
  expect(warns()).toBe(false);
  root = createRoot(host);
});
