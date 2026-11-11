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
