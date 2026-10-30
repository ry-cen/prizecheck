import { expect, test } from "vitest";
import { deckLine } from "./deckListModel";
import { deckReadiness } from "./deckReadiness";
import type { DeckListLine, LineOwnership } from "../decks_generated";

/** A line of `quantity` copies with `inDeck` in this Deck, `elsewhere` owned in other Locations and `lent` with a
 * Friend, built the way the deck builder builds it. */
function line(
  quantity: number,
  inDeck: number,
  elsewhere = 0,
  lent = 0,
  id = `card-${quantity}-${inDeck}-${elsewhere}-${lent}`
) {
  const ownership: LineOwnership = {
    edition_id: id,
    quantity: String(quantity),
    in_deck: String(inDeck),
    elsewhere: String(elsewhere),
    lent: String(lent),
    not_owned: "0",
    locations: [],
  };
  return deckLine(
    {
      edition_id: id,
      name: id,
      quantity: String(quantity),
      in_deck: String(inDeck),
      set_name: "Set",
      collector_number: "1",
      descriptor: {},
    } as DeckListLine,
    ownership,
    lent
      ? {
          edition_id: id,
          reserved: [],
          lent: [{ name: "Sam", copies: String(lent) }],
        }
      : undefined
  );
}

const sum = (parts: ReturnType<typeof deckReadiness>) =>
  parts.inDeck + parts.elsewhere + parts.lent + parts.notOwned;

test("an empty Deck List has nothing in any part", () => {
  expect(deckReadiness([])).toEqual({
    total: 0n,
    inDeck: 0n,
    elsewhere: 0n,
    lent: 0n,
    notOwned: 0n,
  });
});

test("a Deck whose copies are all in it has nothing elsewhere, lent or not owned", () => {
  expect(deckReadiness([line(4, 4), line(2, 2)])).toEqual({
    total: 6n,
    inDeck: 6n,
    elsewhere: 0n,
    lent: 0n,
    notOwned: 0n,
  });
});

test("the four parts split every line and add up to the Deck List", () => {
  const parts = deckReadiness([
    line(4, 1, 2),
    line(3, 0, 0, 1),
    line(2, 0),
    line(1, 1),
  ]);
  expect(parts).toEqual({
    total: 10n,
    inDeck: 2n,
    elsewhere: 2n,
    lent: 1n,
    notOwned: 5n,
  });
  expect(sum(parts)).toBe(parts.total);
});

test("copies owned elsewhere count only up to the line's need beyond this Deck", () => {
  const parts = deckReadiness([line(4, 3, 9)]);
  expect(parts.elsewhere).toBe(1n);
  expect(parts.notOwned).toBe(0n);
  expect(sum(parts)).toBe(4n);
});

test("a line that just grew past an older ownership entry counts its new copies as not owned", () => {
  // After an edit the line carries 4 while the Deck read still says 2 in the Deck and none elsewhere.
  const grown = deckLine(
    {
      edition_id: "grown",
      name: "grown",
      quantity: "4",
      in_deck: "2",
      set_name: "Set",
      collector_number: "1",
      descriptor: {},
    } as DeckListLine,
    {
      edition_id: "grown",
      quantity: "2",
      in_deck: "2",
      elsewhere: "0",
      lent: "0",
      not_owned: "0",
      locations: [],
    }
  );
  const parts = deckReadiness([grown]);
  expect(parts).toMatchObject({ total: 4n, inDeck: 2n, notOwned: 2n });
  expect(sum(parts)).toBe(parts.total);
});

test("lent copies never outnumber the copies the line misses", () => {
  const parts = deckReadiness([line(2, 1, 0, 5)]);
  expect(parts).toMatchObject({ inDeck: 1n, lent: 1n, notOwned: 0n });
  expect(sum(parts)).toBe(2n);
});
