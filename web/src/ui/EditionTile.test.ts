// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EditionTile } from "./EditionTile";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (props: Partial<Parameters<typeof EditionTile>[0]>) =>
  act(async () =>
    root.render(
      h(EditionTile, {
        name: "Chikorita",
        setName: "Mega Evolution",
        setCode: "MEG",
        collectorNumber: "1",
        variant: "Reverse Holo",
        imageUrl: null,
        owned: 2,
        ...props,
      })
    )
  );
const badge = () =>
  host.querySelector("button span.bg-accent")?.textContent ?? null;

test("the owned badge reads ×N by default, queued or not", async () => {
  await render({ queued: 1 });
  expect(badge()).toBe("×2");
});

test("an opted-in tile with queued copies says how many are owned in words", async () => {
  await render({ queued: 1, labelOwned: true });
  expect(badge()).toBe("×2 owned");
  expect(host.querySelector("button")!.getAttribute("aria-label")).toContain(
    "2 owned, 1 to add"
  );
});

test("an opted-in tile with nothing queued keeps the short badge", async () => {
  await render({ queued: 0, labelOwned: true });
  expect(badge()).toBe("×2");
});

test("an explicit badge is never replaced", async () => {
  await render({ queued: 1, labelOwned: true, badge: "3 free" });
  expect(badge()).toBe("3 free");
});

const art = () => host.querySelector("[data-tile-art]")!;
const ownedBadge = () => host.querySelector("[data-owned-badge]");

test("by default and at the top right the owned badge sits on the artwork", async () => {
  await render({});
  expect(art().contains(ownedBadge())).toBe(true);
  await render({ ownedBadgePosition: "top-right" });
  expect(art().contains(ownedBadge())).toBe(true);
});

test("on the Names line the owned badge is off the artwork, shares the text of the others and never shows without copies", async () => {
  await render({ ownedBadgePosition: "names", queued: 1, labelOwned: true });
  expect(ownedBadge()).not.toBeNull();
  expect(art().contains(ownedBadge())).toBe(false);
  expect(ownedBadge()!.textContent).toBe("×2 owned");
  expect(host.querySelectorAll("[data-owned-badge]")).toHaveLength(1);
  await render({ ownedBadgePosition: "names", owned: 0 });
  expect(ownedBadge()).toBeNull();
});
