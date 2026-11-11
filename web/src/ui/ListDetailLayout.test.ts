// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ListDetailLayout } from "./ListDetailLayout";

vi.mock("./overlayScrollPolicy", () => ({ useOverlayScrollbars: () => false }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["resize before scroll", "scroll before resize", "no resize"])(
  "keeps a newer queue position: %s",
  async (ordering) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      host
    );
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(ListDetailLayout, {
            selected: true,
            queue: "Queue",
            detail: "Detail",
          })
        )
      );
      const viewport = host.querySelector<HTMLDivElement>(
        ".list-detail-viewport"
      )!;
      viewport.scrollTop = 701;
      await act(async () => viewport.dispatchEvent(new Event("scroll")));
      viewport.scrollTop = 120;
      if (ordering === "scroll before resize")
        await act(async () => viewport.dispatchEvent(new Event("scroll")));
      if (ordering !== "no resize") window.dispatchEvent(new Event("resize"));
      expect(viewport.scrollTop).toBe(120);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
);

it.each([
  { selected: true, newer: 120 },
  { selected: true, newer: 0 },
  { selected: false, newer: 120 },
  { selected: false, newer: 0 },
])(
  "retains the native offset across phone layout (selected=$selected), then respects $newer",
  async ({ selected, newer }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    let wide = true;
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => (wide || !selected ? host : null)
    );
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(ListDetailLayout, {
            selected,
            queue: "Queue",
            detail: "Detail",
          })
        )
      );
      const viewport = host.querySelector<HTMLDivElement>(
        ".list-detail-viewport"
      )!;
      // Real browser measurement: phone layout reports zero (hidden or overflow:visible),
      // but the native offset is retained and exposed again when the desktop scrollport returns.
      let nativeOffset = 0;
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => (wide ? nativeOffset : 0),
        set: (value: number) => {
          if (wide) nativeOffset = value;
        },
      });
      viewport.scrollTop = 701;
      await act(async () => viewport.dispatchEvent(new Event("scroll")));
      wide = false;
      await act(async () => viewport.dispatchEvent(new Event("scroll")));
      window.dispatchEvent(new Event("resize"));
      expect(viewport.scrollTop).toBe(0);
      wide = true;
      window.dispatchEvent(new Event("resize"));
      // Read the restored offset before any application write can mask its loss.
      expect(viewport.scrollTop).toBe(701);
      viewport.scrollTop = newer;
      window.dispatchEvent(new Event("resize"));
      expect(viewport.scrollTop).toBe(newer);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
);
