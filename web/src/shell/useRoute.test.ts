// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useRoute, type Route } from "./useRoute";

let route: Route;
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
function Probe() {
  route = useRoute();
  return null;
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("reload keeps the current entry's position and its overlay ownership", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(
    { prizecheckEntry: "want-list" },
    "",
    "/decks/want-list"
  );
  await mount();
  vi.stubGlobal("scrollY", 3621);
  window.dispatchEvent(new Event("beforeunload"));
  expect(window.history.state.prizecheckScroll).toBe(3621);
  await act(async () => root.unmount());
  host.remove();
  await mount();
  expect(route.entry).toBe("want-list");
  expect(route.scrollFor("/decks/want-list")).toBe(3621);
  await act(async () =>
    route.navigate("/decks/example?edition=card", { overlay: true })
  );
  window.dispatchEvent(new Event("pagehide"));
  expect(window.history.state.prizecheckOverlayParent).toBe("/decks/want-list");
  expect(window.history.state.prizecheckScroll).toBe(3621);
});
