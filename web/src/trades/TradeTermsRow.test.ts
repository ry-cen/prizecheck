// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { TradeTermsRow } from "./TradeTermsRow";

describe("closed Trade artwork", () => {
  for (const count of [1, 100]) {
    it(`renders only lazy thumbnails for ${count} unopened card details`, () => {
      const markup = renderToStaticMarkup(
        createElement(
          "ul",
          null,
          Array.from({ length: count }, (_, index) =>
            createElement(TradeTermsRow, {
              key: index,
              card: {
                edition_id: `edition-${index}`,
                name: `Card ${index}`,
                set_code: "TEST",
                set_name: "Test set",
                collector_number: String(index),
                descriptor: { finish: "normal" },
                image_url: `/api/art/card-${index}/small?v=1`,
              },
              quantity: "×1",
              context: "Your Decks need 2 copies.",
              details: createElement("p", null, "Your Decks need 2 copies."),
            })
          )
        )
      );
      const images = [...markup.matchAll(/<img\b[^>]*>/g)].map(
        (match) => match[0]
      );
      expect(images).toHaveLength(count);
      expect(images.every((image) => image.includes('loading="lazy"'))).toBe(
        true
      );
      expect(markup).not.toContain("/large");
      expect(markup.match(/Your Decks need 2 copies\./g)).toHaveLength(count);
    });
  }
});

it("shrinks only an oversized Trade name by one phone font step and restores it after widening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(update: () => void) {
        resize = update;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: () => ({ width: 100 }),
  } as unknown as CanvasRenderingContext2D);
  let width = 80;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(TradeTermsRow, {
          card: {
            edition_id: "card",
            name: "Centiskorch",
            set_code: "TEST",
            set_name: "Test",
            collector_number: "1",
            descriptor: {},
            image_url: null,
          },
          quantity: "×1",
          fullWidthPhoneName: true,
        })
      )
    );
    const name = host.querySelector('[lang="en"]')!;
    expect(name.classList.contains("phone:text-control")).toBe(true);
    expect(name.classList.contains("phone:hyphens-auto")).toBe(true);
    expect(name.classList.contains("phone:wrap-normal")).toBe(true);
    expect(name.classList.contains("text-body")).toBe(true);
    width = 120;
    await act(async () => resize());
    expect(name.classList.contains("phone:text-control")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
