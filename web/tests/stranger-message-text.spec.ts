import { expect, test } from "@playwright/test";
import { endSentence } from "../src/social/sentenceEnd";
import type { TradeView } from "../src/social_generated";
import {
  prefilledMessagePath,
  readPrefill,
  withoutPrefill,
} from "../src/trades/messagePrefill";
import {
  cardQuestion,
  meetTipShows,
  newConversationLimit,
} from "../src/trades/strangerMessages";

// Trading #301 (messaging strangers): the card question, the prefill in the address, the daily limit's wait in hours,
// and when the meet-in-public tip shows. Pure functions, no browser.
const FIRST = "You've started 10 new conversations in the last 24 hours.";

test("the card question names the card as Trade messages do", () => {
  expect(cardQuestion("Iono (PAL 185)")).toBe(
    "Is your Iono (PAL 185) still available?"
  );
});

test("the prefill round-trips and refuses what it shouldn't take", () => {
  const text = "Is your Iono (PAL 185) still available? a&b #1 100% 🙂";
  const path = prefilledMessagePath("t-1", text);
  expect(path.startsWith("/trades/with/t-1?draft=")).toBe(true);
  expect(readPrefill(new URL(path, "http://x").search)).toBe(text);
  expect(readPrefill("")).toBe("");
  expect(readPrefill("?draft=%20%20")).toBe("");
  expect(readPrefill(`?draft=${"🙂".repeat(301)}`)).toBe("");
  expect(readPrefill(`?draft=${"🙂".repeat(300)}`)).toBe("🙂".repeat(300));
  expect(withoutPrefill("?draft=a&x=1")).toBe("?x=1");
  expect(withoutPrefill("?draft=a")).toBe("");
});

test("the daily limit says hours", () => {
  const ends = (detail: Record<string, unknown>, tail: string) => {
    const text = newConversationLimit(detail);
    expect(text.startsWith(FIRST)).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
  };
  ends({ retry_after_minutes: 60 }, "Try again in 1 hour.");
  ends({ retry_after_minutes: 61 }, "Try again in 2 hours.");
  ends({ retry_after_minutes: 1380 }, "Try again in 23 hours.");
  ends({}, "Try again later.");
  ends({ retry_after_minutes: 0 }, "Try again later.");
  ends({ retry_after_minutes: "x" }, "Try again later.");
});

test("the meetup tip shows only on accepted Trades with someone available who isn't a Friend", () => {
  for (const state of ["proposed", "accepted", "closed"]) {
    for (const friend of [true, false, undefined]) {
      for (const available of [true, false, undefined]) {
        const trade = {
          state,
          other: { friend, available },
        } as unknown as Pick<TradeView, "state" | "other">;
        expect(
          meetTipShows(trade),
          `${state} friend=${friend} available=${available}`
        ).toBe(state === "accepted" && friend !== true && available === true);
      }
    }
  }
});

test("a name ending a sentence gets no second period", () => {
  expect(endSentence("Misty W.")).toBe("Misty W.");
  expect(endSentence("Misty")).toBe("Misty.");
});
