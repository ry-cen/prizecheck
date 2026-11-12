// @vitest-environment jsdom
import { act, createElement as h, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { restorePageFocus } from "./restorePageFocus";
import { useRoute, type Route } from "./useRoute";

for (const late of [false, true])
  for (const completed of [false, true])
    it(`canonical replacement preserves ${completed ? "completed" : "cancelled"} intent with ${late ? "late" : "present"} heading`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      window.history.replaceState(null, "", "/trades");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let route!: Route;
      let visible = completed;
      function View() {
        route = useRoute();
        const container = useRef<HTMLDivElement>(null);
        useLayoutEffect(
          () => restorePageFocus(container.current, route.focusFor()),
          [route.entry, route.path]
        );
        return h(
          "div",
          { ref: container },
          h("button", null, "Collector control"),
          visible && route.path !== "/trades" ? h("h1", null, "Trade") : null
        );
      }
      try {
        await act(async () => root.render(h(View)));
        await act(async () => route.navigate("/trades/old-round"));
        if (completed)
          expect(document.activeElement).toBe(host.querySelector("h1"));
        const control = host.querySelector("button")!;
        control.focus();
        visible = !late;
        await act(async () =>
          route.navigate("/trades/thread", { replace: true })
        );
        if (late) {
          visible = true;
          await act(async () => root.render(h(View)));
        }
        expect(host.querySelector("h1")).not.toBeNull();
        expect(document.activeElement).toBe(control);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    });

for (const late of [false, true])
  it(`does not restart completed entry focus on a canonical replacement (${late ? "late" : "present"} heading)`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/trades");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let route!: Route;
    let visible = true;
    function View() {
      route = useRoute();
      const container = useRef<HTMLDivElement>(null);
      useLayoutEffect(
        () => restorePageFocus(container.current, route.focusFor()),
        [route.entry, route.path]
      );
      return h(
        "div",
        { ref: container },
        visible && route.path !== "/trades"
          ? h("h1", { key: route.path }, "Trade")
          : null
      );
    }
    try {
      await act(async () => root.render(h(View)));
      await act(async () => route.navigate("/trades/old-round"));
      expect(document.activeElement).toBe(host.querySelector("h1"));
      visible = !late;
      await act(async () =>
        route.navigate("/trades/thread", { replace: true })
      );
      if (late) {
        visible = true;
        await act(async () => root.render(h(View)));
      }
      expect(host.querySelector("h1")).not.toBeNull();
      expect(document.activeElement).toBe(document.body);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

it("carries a pending request through a canonical replacement to a late heading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/trades");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let route!: Route;
  let visible = false;
  function View() {
    route = useRoute();
    const container = useRef<HTMLDivElement>(null);
    useLayoutEffect(
      () => restorePageFocus(container.current, route.focusFor()),
      [route.entry, route.path]
    );
    return h(
      "div",
      { ref: container },
      visible ? h("h1", null, "Trade") : null
    );
  }
  try {
    await act(async () => root.render(h(View)));
    await act(async () => route.navigate("/trades/old-round"));
    const pending = route.focusFor();
    await act(async () => route.navigate("/trades/thread", { replace: true }));
    expect(route.focusFor()).toBe(pending);
    visible = true;
    await act(async () => root.render(h(View)));
    expect(document.activeElement).toBe(host.querySelector("h1"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

for (const role of ["tab", undefined])
  it(`keeps a section tab focused when it switches the Decks view and restores it on Back (role: ${role ?? "button"})`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/decks");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let route!: Route;
    function View() {
      route = useRoute();
      const container = useRef<HTMLDivElement>(null);
      useLayoutEffect(
        () => restorePageFocus(container.current, route.focusFor()),
        [route.entry, route.path]
      );
      return h(
        "div",
        { ref: container },
        h("h1", { key: route.path }, "Decks"),
        route.path !== "/decks/example"
          ? h(
              "button",
              { role, onClick: () => route.navigate("/decks/want-list") },
              "Want List"
            )
          : null
      );
    }
    try {
      await act(async () => root.render(h(View)));
      const tab = host.querySelector("button")!;
      tab.focus();
      await act(async () => tab.click());
      expect(document.activeElement).toBe(tab);
      const wantList = window.history.state;
      await act(async () => route.navigate("/decks/example"));
      await act(async () => {
        window.history.replaceState(wantList, "", "/decks/want-list");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(document.activeElement).toBe(host.querySelector("button"));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

it("opens a Deck with heading focus even when a Decks tab had focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/decks");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let route!: Route;
  function View() {
    route = useRoute();
    const container = useRef<HTMLDivElement>(null);
    useLayoutEffect(
      () => restorePageFocus(container.current, route.focusFor()),
      [route.entry, route.path]
    );
    return h(
      "div",
      { ref: container },
      route.path === "/decks"
        ? h("button", { role: "tab" }, "My Decks")
        : h("h1", null, "Deck")
    );
  }
  try {
    await act(async () => root.render(h(View)));
    const entry = window.history.state;
    host.querySelector("button")!.focus();
    await act(async () => route.navigate("/decks/example"));
    expect(document.activeElement).toBe(host.querySelector("h1"));
    await act(async () => {
      window.history.replaceState(entry, "", "/decks");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(document.activeElement).toBe(host.querySelector("button"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("a query-only replace cancels loading entry focus and disconnects its observer immediately", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/decks/example");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  let route!: Route;
  let loading = true;
  function View() {
    route = useRoute();
    const container = useRef<HTMLDivElement>(null);
    // Match the Shell effect: a query-only replace changes neither dependency.
    useLayoutEffect(
      () => restorePageFocus(container.current, route.focusFor()),
      [route.entry, route.path]
    );
    return h(
      "div",
      { ref: container },
      h("h1", { "data-page-heading": loading ? "loading" : undefined }, "Decks")
    );
  }
  try {
    await act(async () => root.render(h(View)));
    await act(async () => route.navigate("/decks/want-list"));
    const request = route.focusFor();
    expect(request).toMatchObject({ kind: "heading", state: "pending" });
    expect(document.activeElement).toBe(document.body);
    disconnect.mockClear();
    await act(async () =>
      route.navigate("/decks/want-list?deck=example", { replace: true })
    );
    expect(request).toMatchObject({ state: "cancelled" });
    const disconnectedBeforeReady = disconnect.mock.calls.length > 0;
    loading = false;
    await act(async () => root.render(h(View)));
    expect({ focus: document.activeElement, disconnectedBeforeReady }).toEqual({
      focus: document.body,
      disconnectedBeforeReady: true,
    });
  } finally {
    await act(async () => root.unmount());
    disconnect.mockRestore();
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("Back restores the originating Deck link after its descriptive price facts rerender", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/decks");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let route!: Route;
  let facts = "Checking prices…";
  function View() {
    route = useRoute();
    const container = useRef<HTMLDivElement>(null);
    useLayoutEffect(
      () => restorePageFocus(container.current, route.focusFor()),
      [route.entry, route.path]
    );
    return h(
      "div",
      { ref: container },
      route.path === "/decks"
        ? h(
            "a",
            {
              href: "/decks/example",
              onClick: (event) => {
                event.preventDefault();
                route.navigate("/decks/example");
              },
            },
            "Focus Deck",
            h("span", { "aria-hidden": "true" }, facts)
          )
        : h("h1", null, "Focus Deck")
    );
  }
  try {
    await act(async () => root.render(h(View)));
    const entry = window.history.state;
    const opener = host.querySelector("a")!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement).toBe(host.querySelector("h1"));
    facts = "To complete: no prices yet";
    await act(async () => {
      window.history.replaceState(entry, "", "/decks");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const restored = host.querySelector("a")!;
    expect(restored).not.toBe(opener);
    expect(document.activeElement).toBe(restored);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
