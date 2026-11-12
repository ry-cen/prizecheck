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

it("only recovers a removed heading within the entry window", async () => {
  vi.useFakeTimers();
  const page = document.createElement("div");
  page.innerHTML = "<h1>Loading</h1>";
  document.body.append(page);
  const stop = restorePageFocus(page, createPageEntryFocus());
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + 1);
  page.innerHTML = "<h1>Ready</h1>";
  await vi.runAllTimersAsync();
  expect(document.activeElement).toBe(document.body);
  stop();
});
