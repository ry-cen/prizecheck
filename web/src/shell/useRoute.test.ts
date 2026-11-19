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

async function visit(to: string, y: number, options = {}) {
  vi.stubGlobal("scrollY", y);
  await act(async () => route.navigate(to, options));
}
test("a tab return keeps the listing's scroll though the Borrowed list was open when it left", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({ prizecheckEntry: "start" }, "", "/collection");
  await mount();
  await visit("/collection?location=X", 0);
  vi.stubGlobal("scrollY", 194);
  await visit("/collection?location=X&borrowed=1", 194, {
    overlay: true,
    preserveScroll: true,
  });
  await visit("/catalog", 194);
  await visit("/collection?location=X", 0);
  expect(route.scrollFor("/collection")).toBe(194);
});
test("a saved address for another Location, another card or a Borrowed list with another Location scrolls to the top", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({ prizecheckEntry: "start" }, "", "/collection");
  await mount();
  await visit("/collection?location=X&borrowed=1", 300);
  await visit("/catalog", 300);
  await visit("/collection?location=Y", 0);
  expect(route.scrollFor("/collection")).toBe(0);
  await visit("/collection?card=A", 250);
  await visit("/catalog", 250);
  await visit("/collection?card=B", 0);
  expect(route.scrollFor("/collection")).toBe(0);
});
test("a Back-restored entry's own position still wins", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({ prizecheckEntry: "start" }, "", "/collection");
  await mount();
  await visit("/collection?location=X", 400);
  await visit("/catalog", 400);
  await act(async () => window.history.back());
  await act(async () => {
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: window.history.state })
    );
  });
  expect(route.scrollFor("/collection")).toBe(400);
});
