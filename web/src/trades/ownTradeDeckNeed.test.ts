import { describe, expect, it } from "vitest";
import { ownTradeDeckNeed } from "./tradeDeckNeed";

describe("own-only incoming Trade need hints", () => {
  it("shows exact Deck need", () =>
    expect(
      ownTradeDeckNeed({ want_list_need: "2", widened: false, shared: false })
    ).toBe("Your Decks need 2."));
  it("marks widened need as shared across accepted printings", () =>
    expect(
      ownTradeDeckNeed({ want_list_need: "3", widened: true, shared: true })
    ).toBe(
      "Your Decks need 3, including need shared across accepted printings."
    ));
  it("qualifies an exact Edition whose need accepts other printings", () =>
    expect(
      ownTradeDeckNeed({ want_list_need: "2", widened: false, shared: true })
    ).toBe(
      "Your Decks need 2, including need shared across accepted printings."
    ));
  it("shows nothing for Trade Wants alone", () =>
    expect(
      ownTradeDeckNeed({ want_list_need: "0", widened: false, shared: false })
    ).toBeNull());
  it("shows nothing for an absent or failed read", () =>
    expect(ownTradeDeckNeed(undefined)).toBeNull());
  it("does not invent malformed quantities", () =>
    expect(
      ownTradeDeckNeed({ want_list_need: "bad", widened: true, shared: true })
    ).toBeNull());
});
