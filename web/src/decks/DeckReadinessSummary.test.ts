import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DeckReadinessSummary } from "./DeckReadinessSummary";
import { deckLine } from "./deckListModel";
import { missingCountNote } from "./deckReadiness";
import { deckReadiness } from "./deckReadiness";
import type { DeckListLine } from "../decks_generated";

test.each([0, 15])(
  "explains promised copies when %i borrowed copies fill the Deck",
  (borrowed) => {
    const line = deckLine(
      {
        edition_id: "energy",
        name: "Basic Grass Energy",
        quantity: "51",
        in_deck: String(borrowed),
        descriptor: {},
      } as DeckListLine,
      {
        edition_id: "energy",
        quantity: "51",
        in_deck: String(borrowed),
        elsewhere: "20",
        lent: "0",
        not_owned: String(31 - borrowed),
        locations: [],
      }
    );
    // All 20 owned copies count here; the accepted Trade promises one, leaving 19 for the Want List.
    expect(deckReadiness([line]).notOwned).toBe(BigInt(31 - borrowed));
    const html = renderToStaticMarkup(
      createElement(DeckReadinessSummary, {
        lines: [line],
        toGet: String(32 - borrowed),
      })
    );
    expect(html).toContain(
      "Ways to get missing cards counts 1 more copy: a copy you own is promised in a Trade or Loan, or counted for another Deck."
    );
  }
);

test.each([undefined, "0", "31"])(
  "no explanation when to-get is absent, lower or equal (%s)",
  (toGet) => {
    expect(missingCountNote(31n, toGet)).toBeNull();
  }
);

test("plural counts stay exact beyond JavaScript's safe integer range", () => {
  expect(missingCountNote(31n, "34")).toBe(
    "Ways to get missing cards counts 3 more copies: some copies you own are promised in a Trade or Loan, or counted for another Deck."
  );
  expect(missingCountNote(9007199254740993n, "9007199254740994")).toContain(
    "1 more copy:"
  );
});
