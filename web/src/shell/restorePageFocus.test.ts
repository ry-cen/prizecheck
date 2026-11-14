// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { RESTORE_WINDOW_MS } from "./restorePageScroll";
import {
  createPageEntryFocus,
  restorePageFocus,
  saveFocus,
} from "./restorePageFocus";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** A page whose Open Deck link had focus, then went away with the page. */
function left() {
  const page = document.createElement("div");
  document.body.append(page);
  link(page, "Open Deck Gardevoir").focus();
  const saved = saveFocus();
  page.replaceChildren();
  return { page, saved };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function link(container: HTMLElement, name: string) {
  const a = document.createElement("a");
  a.href = "/decks/d1";
  a.textContent = name;
  container.append(a);
  return a;
}

it("gives focus back to the remounted control that left the entry, once it is drawn", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  link(page, "Open Deck Gardevoir").focus();
  const saved = saveFocus();
  page.replaceChildren();
  expect(document.activeElement).toBe(document.body);

  const stop = restorePageFocus(page, saved);
  link(page, "Open Deck Charizard");
  const again = link(page, "Open Deck Gardevoir");
  await flush();
  expect(document.activeElement).toBe(again);
  stop();
});

it("leaves focus the page or the collector moved elsewhere", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  link(page, "Open Deck Gardevoir").focus();
  const saved = saveFocus();
  page.replaceChildren();
  const heading = document.createElement("h1");
  heading.tabIndex = -1;
  page.append(heading);
  const stop = restorePageFocus(page, saved);
  heading.focus();
  link(page, "Open Deck Gardevoir");
  await flush();
  expect(document.activeElement).toBe(heading);
  stop();
});

it("saves nothing when focus was on the body", () => {
  expect(saveFocus()).toBeNull();
});

for (const input of ["keydown", "pointerdown"] as const)
  it(`releases on ${input}, so a control drawn later is not focused`, async () => {
    const { page, saved } = left();
    restorePageFocus(page, saved);
    window.dispatchEvent(new Event(input));
    link(page, "Open Deck Gardevoir");
    await flush();
    expect(document.activeElement).toBe(document.body);
  });

it("releases after the restore window", async () => {
  vi.useFakeTimers();
  const { page, saved } = left();
  restorePageFocus(page, saved);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + 1);
  link(page, "Open Deck Gardevoir");
  await vi.runAllTimersAsync();
  expect(document.activeElement).toBe(document.body);
});

it("skips a twin that is hidden or inert, and takes it once shown", async () => {
  const { page, saved } = left();
  const hidden = document.createElement("div");
  hidden.hidden = true;
  page.append(hidden);
  const stop = restorePageFocus(page, saved);
  const twin = link(hidden, "Open Deck Gardevoir");
  await flush();
  expect(document.activeElement).toBe(document.body);
  hidden.hidden = false;
  hidden.setAttribute("inert", "");
  page.append(document.createElement("span"));
  await flush();
  expect(document.activeElement).toBe(document.body);
  hidden.removeAttribute("inert");
  page.append(document.createElement("span"));
  await flush();
  expect(document.activeElement).toBe(twin);
  stop();
});

it("focuses nothing when two controls match what was left", async () => {
  const { page, saved } = left();
  const stop = restorePageFocus(page, saved);
  link(page, "Open Deck Gardevoir");
  link(page, "Open Deck Gardevoir");
  await flush();
  expect(document.activeElement).toBe(document.body);
  stop();
});

it("focuses the forward entry heading without scrolling", () => {
  const page = document.createElement("div");
  page.innerHTML = "<h1>Deck</h1>";
  document.body.append(page);
  const heading = page.querySelector("h1")!;
  const focus = vi.spyOn(heading, "focus");
  restorePageFocus(page, createPageEntryFocus());
  expect(document.activeElement).toBe(heading);
  expect(heading.tabIndex).toBe(-1);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("waits for a forward entry heading", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  page.innerHTML = "<h1>Loan</h1>";
  await flush();
  expect(document.activeElement).toBe(page.firstChild);
  stop();
});

it("never takes heading focus after the collector focused elsewhere, even if focus returns to body", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  const control = link(page, "Something else");
  control.focus();
  control.remove();
  page.innerHTML = "<h1>Loan</h1>";
  await flush();
  expect(document.activeElement).toBe(document.body);
  stop();
});

it("waits while the navigation opener remains in the page during loading", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  link(page, "Open Deck").focus();
  const stop = restorePageFocus(page, createPageEntryFocus());
  page.innerHTML = "<h1>Deck</h1>";
  await flush();
  expect(document.activeElement).toBe(page.firstChild);
  stop();
});

it("keeps forward entry intent through a slow data read until the collector interacts", async () => {
  vi.useFakeTimers();
  const page = document.createElement("div");
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + 1);
  page.innerHTML = "<h1>Deck</h1>";
  await vi.runAllTimersAsync();
  expect(document.activeElement).toBe(page.firstChild);
  stop();
});

it("waits for a loading heading to become ready", async () => {
  const page = document.createElement("div");
  page.innerHTML = '<h1 data-page-heading="loading">Loading</h1>';
  document.body.append(page);
  const heading = page.querySelector("h1")!;
  const stop = restorePageFocus(page, createPageEntryFocus());
  try {
    expect(document.activeElement).toBe(document.body);
    heading.removeAttribute("data-page-heading");
    await flush();
    expect(document.activeElement).toBe(heading);
  } finally {
    stop();
  }
});

it("skips a loading heading and focuses its replacement", async () => {
  const page = document.createElement("div");
  page.innerHTML = '<h1 data-page-heading="loading">Loading</h1>';
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  try {
    expect(document.activeElement).toBe(document.body);
    page.innerHTML = "<h1>Ready</h1>";
    await flush();
    expect(document.activeElement).toBe(page.firstChild);
  } finally {
    stop();
  }
});

it("focuses a heading that becomes ready long after the restore window", async () => {
  vi.useFakeTimers();
  const page = document.createElement("div");
  page.innerHTML = '<h1 data-page-heading="loading">Loading</h1>';
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  try {
    expect(document.activeElement).toBe(document.body);
    vi.advanceTimersByTime(RESTORE_WINDOW_MS * 3);
    page.firstElementChild!.removeAttribute("data-page-heading");
    await vi.runAllTimersAsync();
    expect(document.activeElement).toBe(page.firstChild);
  } finally {
    stop();
  }
});

for (const input of ["pointerdown", "keydown", "wheel"])
  it(`a ${input} before the heading is ready cancels for good`, async () => {
    const page = document.createElement("div");
    document.body.append(page);
    const stop = restorePageFocus(page, createPageEntryFocus());
    try {
      window.dispatchEvent(new Event(input));
      page.innerHTML = "<h1>Ready</h1>";
      await flush();
      expect(document.activeElement).toBe(document.body);
      page.innerHTML = "<h1>Another ready heading</h1>";
      await flush();
      expect(document.activeElement).toBe(document.body);
    } finally {
      stop();
    }
  });

it("an interaction whose propagation is stopped still cancels", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  const child = document.createElement("button");
  child.addEventListener("pointerdown", (event) => event.stopPropagation());
  page.append(child);
  const stop = restorePageFocus(page, createPageEntryFocus());
  try {
    child.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    page.innerHTML = "<h1>Ready</h1>";
    await flush();
    expect(document.activeElement).toBe(document.body);
  } finally {
    stop();
  }
});

for (const state of ["cancelled", "completed"] as const)
  it(`detaches immediately and rejects a queued callback after the request is ${state}`, () => {
    const NativeObserver = MutationObserver;
    let notify!: () => void;
    class QueuedObserver extends NativeObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        notify = () => callback([], this);
      }
    }
    vi.stubGlobal("MutationObserver", QueuedObserver);
    const disconnect = vi.spyOn(QueuedObserver.prototype, "disconnect");
    const page = document.createElement("div");
    page.innerHTML = '<h1 data-page-heading="loading">Loading</h1>';
    document.body.append(page);
    const request = createPageEntryFocus();
    const stop = restorePageFocus(page, request);
    try {
      request.state = state;
      const disconnectedBeforeReady = disconnect.mock.calls.length > 0;
      page.innerHTML = "<h1>Ready</h1>";
      // Even a callback already queued before cancellation must reject terminal intent.
      notify();
      expect({
        focus: document.activeElement,
        disconnectedBeforeReady,
      }).toEqual({
        focus: document.body,
        disconnectedBeforeReady: true,
      });
      expect(request.state).toBe(state);
    } finally {
      stop();
      disconnect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

it("restores the Deck link when its aria-hidden price facts change after Back", () => {
  const page = document.createElement("div");
  document.body.append(page);
  const opener = link(page, "Focus Deck");
  const facts = document.createElement("span");
  facts.setAttribute("aria-hidden", "true");
  facts.textContent = "0/1 in DeckChecking prices…";
  opener.append(facts);
  opener.focus();
  const saved = saveFocus();
  page.replaceChildren();
  const restored = link(page, "Focus Deck");
  const changedFacts = facts.cloneNode(true);
  changedFacts.textContent = "0/1 in DeckTo complete: no prices yet";
  restored.append(changedFacts);
  const focus = vi.spyOn(restored, "focus");
  const stop = restorePageFocus(page, saved);
  try {
    expect(document.activeElement).toBe(restored);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  } finally {
    stop();
  }
});

it("heading focus survives focus a closing dialog returned outside the page", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  const outside = document.createElement("button");
  document.body.append(outside);
  const request = createPageEntryFocus();
  // The dialog's close returned focus to its opener, outside the page, with no focusin after the attach.
  outside.focus();
  const stop = restorePageFocus(page, request);
  page.innerHTML = "<h1>Friend</h1>";
  await flush();
  expect(document.activeElement).toBe(page.firstChild);
  stop();
});

it("a focusin elsewhere after the first attempt still cancels", async () => {
  const page = document.createElement("div");
  document.body.append(page);
  const outside = document.createElement("button");
  const other = document.createElement("button");
  document.body.append(outside, other);
  outside.focus();
  const stop = restorePageFocus(page, createPageEntryFocus());
  other.focus();
  page.innerHTML = "<h1>Friend</h1>";
  await flush();
  expect(document.activeElement).toBe(other);
  stop();
});
