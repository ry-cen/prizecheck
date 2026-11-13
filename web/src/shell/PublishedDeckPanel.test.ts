// @vitest-environment jsdom
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PublishedDeckPanel } from "../public/PublishedDeckPanel";
it("uses H2 card groups immediately beneath the page H1", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    h(PublishedDeckPanel, {
      view: "list",
      groups: [
        {
          key: "pokemon",
          kind: "pokemon",
          title: "Pokémon",
          lines: [],
          copies: 1n,
        },
      ],
      prices: null,
      flagged: new Set<string>(),
      formatName: "Standard",
      onOpen: vi.fn(),
    })
  );
  expect(host.querySelector("h2")?.textContent).toContain("Pokémon");
  expect(host.querySelector("h3")).toBeNull();
});
