// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CopyTile } from "./CopyTile";
import { EditionTile } from "./EditionTile";

/** jsdom does not hit-test. Resolve the pointer-events inheritance of the
 * decorative surface before delivering the browser's gesture to its target. */
function pointerTarget(leaf: Element): Element {
  let target = leaf;
  for (let node: Element | null = leaf; node; node = node.parentElement) {
    if (getComputedStyle(node).pointerEvents === "none" && node.parentElement)
      target = node.parentElement;
  }
  return target;
}
for (const kind of ["copy", "edition"] as const)
  for (const rerender of ["waiting", "retry"] as const)
    it(`${kind} selection survives artwork replacement between pointerdown and click (${rerender})`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.useFakeTimers();
      // The real Tailwind utility, including its inherited pointer behavior.
      const style = document.createElement("style");
      style.textContent = ".pointer-events-none { pointer-events: none; }";
      document.head.append(style);
      const clicked = vi.fn();
      function View() {
        const [selected, setSelected] = useState(false);
        const props = {
          name: "Pikachu",
          setName: "Fixture Set",
          setCode: "FIX",
          collectorNumber: "1",
          variant: "Normal",
          imageUrl: "/api/art/tile/small?v=1",
          onClick: () => {
            clicked();
            setSelected((value) => !value);
          },
        };
        return h(
          "div",
          null,
          kind === "copy"
            ? h(CopyTile, {
                ...props,
                label: "Pikachu, copy 1",
                title: "Pikachu",
                names: true,
                selected,
              })
            : h(EditionTile, { ...props, owned: 1, "aria-pressed": selected }),
          selected &&
            h("section", { "aria-label": "Selection" }, "1 copy selected")
        );
      }
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(h(View)));
        const button = host.querySelector("button")!,
          image = host.querySelector("img")!;
        const target = pointerTarget(image);
        target.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0 })
        );
        // The same child replacement visible during the hosted failed click.
        await act(async () => image.dispatchEvent(new Event("error")));
        expect(image.isConnected).toBe(false);
        if (rerender === "retry") {
          await act(async () => vi.advanceTimersByTime(1500));
          expect(host.querySelector("img")).not.toBeNull();
          expect(host.querySelector("img")).not.toBe(image);
        }
        expect(host.querySelector("button")).toBe(button);
        await act(async () => {
          target.dispatchEvent(
            new MouseEvent("pointerup", { bubbles: true, button: 0 })
          );
          target.dispatchEvent(
            new MouseEvent("click", { bubbles: true, button: 0 })
          );
        });
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(
          host.querySelector('[aria-label="Selection"]')?.textContent
        ).toBe("1 copy selected");
        // Keyboard activation still selects exactly once after that rerender.
        await act(async () => button.click());
        expect(clicked).toHaveBeenCalledTimes(2);
        expect(button.getAttribute("aria-pressed")).toBe("false");
      } finally {
        await act(async () => root.unmount());
        host.remove();
        style.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
