// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { restorePageFocus, saveFocus } from "./restorePageFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

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
