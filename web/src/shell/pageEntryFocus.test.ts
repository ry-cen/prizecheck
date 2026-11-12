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
