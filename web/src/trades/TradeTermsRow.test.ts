import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
