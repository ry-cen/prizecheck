import { describe, expect, it } from "vitest";
import type { TradeMatchCard } from "../social_generated";
import { tradeDeckNeed } from "./tradeDeckNeed";

const card: TradeMatchCard = {
  edition_id: "iono-pal",
  name: "Iono",
  set_code: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  copies: "3",
  need: "7",
  want_list_need: "2",
  origin: "both",
  accepts_as: "exact",
  need_groups: ["deck", "trade"],
};
const groups = [
  { id: "deck", need: "2", cards: "2" },
  { id: "trade", need: "5", cards: "1" },
];
describe("incoming Trade Deck-need hints", () => {
  it("marks shared need even for an exact match and excludes Trade Wants", () => {
    expect(tradeDeckNeed(card, groups)).toBe(
      "Your Decks need 2 Iono, including need shared across printings."
    );
  });
  it("uses the Want List count for a single group", () => {
    expect(
      tradeDeckNeed(
        { ...card, need: "2", origin: "want_list", need_groups: ["deck"] },
        [{ ...groups[0], cards: "1" }]
      )
    ).toBe("Your Decks need 2 Iono.");
  });
  it.each(["any_finish", "same_name"] as const)(
    "does not claim an exact-only need under %s widening",
    (accepts_as) => {
      expect(tradeDeckNeed({ ...card, accepts_as }, groups)).toBe(
        tradeDeckNeed(card, groups)
      );
    }
  );
  it("shows nothing for Trade Wants without Deck need", () => {
    expect(
      tradeDeckNeed(
        { ...card, want_list_need: "0", origin: "trade_wants" },
        groups
      )
    ).toBeNull();
  });
  it("shows nothing for an unmatched card", () =>
    expect(tradeDeckNeed(undefined, groups)).toBeNull());
  it("shows nothing when group lists are absent", () =>
    expect(tradeDeckNeed(card, undefined)).toBeNull());
  it("shows nothing when a referenced group is missing", () =>
    expect(tradeDeckNeed(card, [groups[0]])).toBeNull());
  it("shows nothing without references", () =>
    expect(tradeDeckNeed({ ...card, need_groups: [] }, groups)).toBeNull());
  it("does not invent a count from malformed need", () =>
    expect(
      tradeDeckNeed({ ...card, want_list_need: "unknown" }, groups)
    ).toBeNull());
});
