// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRoute, type Route } from "./useRoute";

it("keeps Collection queries reactive and restores separate visits to the same detail address", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/collection?location=binder");
  let route!: Route;
  function View() {
    route = useRoute();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(View)));
    expect(route.path).toBe("/collection");
    expect(route.address).toBe("/collection?location=binder");
    vi.stubGlobal("scrollY", 320);
    await act(async () => route.navigate("/collection?location=other"));
    expect(route.scrollFor(route.path)).toBe(0);
    expect(route.address).toBe("/collection?location=other");
    await act(async () =>
      route.navigate("/collection?location=other&card=edition", {
        preserveScroll: true,
      })
    );
    expect(route.scrollFor(route.path)).toBe(320);
    expect(route.address).toBe("/collection?location=other&card=edition");
    await act(async () => route.navigate("/decks/want-list"));
    const first = window.history.state;
    vi.stubGlobal("scrollY", 450);
    await act(async () => route.navigate("/decks/example"));
    vi.stubGlobal("scrollY", 0);
    await act(async () => route.navigate("/decks/want-list"));
    expect(route.scrollFor(route.path)).toBe(0);
    await act(async () => {
      window.history.replaceState(first, "", "/decks/want-list");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(route.scrollFor(route.path)).toBe(450);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
