import { describe, expect, it } from "vitest";
import { loanDeckUseHint } from "./loanText";

describe("lender Deck-use hints", () => {
  it("includes allocated loose copies in the count", () => {
    expect(loanDeckUseHint({ for_decks: "4", need: "0" })).toBe(
      "Your Decks count on 4 copies."
    );
  });
  it("shows remaining need together with allocated copies", () => {
    expect(loanDeckUseHint({ for_decks: "2", need: "1" })).toBe(
      "Your Decks count on 2 copies. Your Decks still need 1."
    );
  });
  it("uses singular copy", () =>
    expect(loanDeckUseHint({ for_decks: "1", need: "0" })).toBe(
      "Your Decks count on 1 copy."
    ));
  it("can show only the remaining need", () =>
    expect(loanDeckUseHint({ for_decks: "0", need: "3" })).toBe(
      "Your Decks still need 3."
    ));
  it("shows nothing when neither is positive", () =>
    expect(loanDeckUseHint({ for_decks: "0", need: "0" })).toBeNull());
  it("shows nothing when the side has no own context", () =>
    expect(loanDeckUseHint(undefined)).toBeNull());
});
