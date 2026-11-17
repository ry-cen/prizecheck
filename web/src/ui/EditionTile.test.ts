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
