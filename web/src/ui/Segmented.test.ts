// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

vi.mock("./overlayScrollPolicy", () => ({ useOverlayScrollbars: () => false }));
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const geometry of [
  { left: 400, right: 480, scroll: 180 },
  { left: -80, right: 0, scroll: -80 },
  { left: 20, right: 100, scroll: 0 },
]) {
  it.each(["tabs", "choice"] as const)(
    `reveals the selected %s option at ${geometry.left}px only inside its horizontal row`,
    async (mode) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
      const intoView = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: intoView,
      });
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect"
      ).mockImplementation(function (this: HTMLElement) {
        return {
          left: this.tagName === "BUTTON" ? geometry.left : 0,
          right: this.tagName === "BUTTON" ? geometry.right : 300,
        } as DOMRect;
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        const common = {
          label: "Views",
          options: [{ value: "late", label: "Late" }],
          value: "late",
          onChange: vi.fn(),
        };
        await act(async () =>
          root.render(
            createElement(
              Segmented,
              mode === "choice"
                ? { ...common, mode }
                : { ...common, mode, idBase: "views", panelId: "panel" }
            )
          )
        );
        // scrollIntoView also scrolls the document, overriding a restored history position.
        expect(intoView).not.toHaveBeenCalled();
        expect(
          host.querySelector('[role="tablist"],[role="radiogroup"]')!.scrollLeft
        ).toBe(geometry.scroll);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  );
}
