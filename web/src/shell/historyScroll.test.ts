// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLeaveGuard, useRoute, type Route } from "./useRoute";

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

it("closes pushed sheets through Back and replaces directly opened sheets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/collection?q=Abra&location=binder");
  let route!: Route;
  function View() {
    route = useRoute();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  try {
    await act(async () => root.render(createElement(View)));
    await act(async () =>
      route.navigate("/collection?location=binder&q=Abra&card=one", {
        overlay: true,
        preserveScroll: true,
      })
    );
    const sheetEntry = route.entry;
    await act(async () =>
      route.navigate("/collection?location=binder&q=Abra&card=one&copy=1", {
        replace: true,
        overlay: true,
        preserveScroll: true,
      })
    );
    expect(route.entry).toBe(sheetEntry);
    expect(window.history.state.prizecheckOverlayParent).toBe(
      "/collection?q=Abra&location=binder"
    );
    await act(async () =>
      route.closeOverlay("/collection?location=binder&q=Abra")
    );
    expect(back).toHaveBeenCalledTimes(1);
    window.history.replaceState(
      { prizecheckEntry: route.entry },
      "",
      "/collection?card=direct"
    );
    await act(async () => route.closeOverlay("/collection"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(route.address).toBe("/collection");
    await act(async () =>
      route.navigate("/collection?card=direct", {
        replace: true,
        overlay: true,
      })
    );
    expect(window.history.state.prizecheckOverlayParent).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("evicts old history positions after many distinct visits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/decks/old");
  let route!: Route;
  function View() {
    route = useRoute();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(View)));
    const old = window.history.state;
    vi.stubGlobal("scrollY", 500);
    for (let visit = 0; visit < 140; visit++)
      await act(async () => route.navigate(`/decks/visit-${visit}`));
    await act(async () => {
      window.history.replaceState(old, "", "/decks/old");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(route.scrollFor(route.path)).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("retains a pushed sheet's parent when a leave guard blocks Back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/collection");
  let route!: Route;
  let blocked = false;
  const ask = vi.fn();
  function View() {
    route = useRoute();
    useLeaveGuard({ blocks: () => blocked, ask });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  try {
    await act(async () => root.render(createElement(View)));
    const parent = window.history.state;
    await act(async () =>
      route.navigate("/collection?card=one", { overlay: true })
    );
    blocked = true;
    await act(async () => {
      window.history.replaceState(parent, "", "/collection");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(window.history.state.prizecheckOverlayParent).toBe("/collection");
    expect(window.location.search).toBe("?card=one");
    await act(async () => route.closeOverlay("/collection"));
    expect(back).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("records the control that left each entry and offers it back on Back, not on a new visit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/decks/want-list");
  let route!: Route;
  function View() {
    route = useRoute();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const link = document.createElement("a");
  link.href = "/decks/d1";
  link.textContent = "Open Deck Gardevoir";
  document.body.append(link);
  try {
    await act(async () => root.render(createElement(View)));
    expect(route.focusFor()).toBeNull();
    const wantList = window.history.state;
    link.focus();
    await act(async () => route.navigate("/decks/d1"));
    expect(route.focusFor()).toBeNull();
    link.remove();
    await act(async () => {
      window.history.replaceState(wantList, "", "/decks/want-list");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(route.focusFor()).toMatchObject({
      tag: "A",
      href: "/decks/d1",
      name: "Open Deck Gardevoir",
    });
    // A replace shows another address on the same entry: the saved control goes with the old one.
    await act(async () =>
      route.navigate("/decks/want-list?deck=d2", { replace: true })
    );
    expect(route.focusFor()).toBeNull();
    await act(async () => route.navigate("/decks/want-list"));
    expect(route.focusFor()).toBeNull();
  } finally {
    link.remove();
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
