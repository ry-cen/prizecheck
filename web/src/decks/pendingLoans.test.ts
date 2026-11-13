import { describe, expect, it } from "vitest";
import {
  borrowDefault,
  borrowOffer,
  borrowRemainder,
  pendingText,
  rowCoverage,
  waitingByDeck,
  type PendingState,
} from "./pendingLoans";

describe("the pending note", () => {
  it("names each lender, promises first as the API orders them", () => {
    expect(
      pendingText({
        edition_id: "iono",
        requested: "2",
        accepted: "1",
        lenders: [
          {
            lender: "Misty W.",
            lender_id: "Misty W.",
            state: "accepted",
            copies: "1",
          },
          {
            lender: "Brock S.",
            lender_id: "Brock S.",
            state: "requested",
            copies: "2",
          },
        ],
      })
    ).toBe("Misty W. agreed to lend 1 · Asked Brock S. for 2");
    expect(pendingText(undefined)).toBe("");
  });
});

describe("borrowing only the missing remainder", () => {
  it.each([
    [2, 4, 4, 2],
    [4, 2, 2, 2],
    [0, 2, 2, 0],
    [3, 0, 2, 2],
  ])(
    "defaults need %s, spare %s and cap %s to %s",
    (need, spare, cap, expected) => {
      expect(borrowDefault(need, spare, cap)).toBe(expected);
    }
  );
  it("subtracts unanswered requests from the Friend's spare and all pending copies from need", () => {
    const pending = {
      edition_id: "iono",
      requested: "1",
      accepted: "0",
      lenders: [
        {
          lender: "Misty",
          lender_id: "Misty",
          state: "requested" as const,
          copies: "1",
        },
      ],
    };
    expect(borrowRemainder(3, 2, pending, pending, "Misty")).toBe(1);
    expect(borrowRemainder(1, 2, pending, pending, "Misty")).toBe(0);
    expect(borrowRemainder(3, 1, pending, pending, "Misty")).toBe(0);
    expect(borrowRemainder(3, 2, pending, pending, "Brock")).toBe(2);
  });
  it("does not subtract accepted copies from already-reserved availability twice", () => {
    expect(
      borrowRemainder(
        3,
        2,
        {
          edition_id: "iono",
          requested: "0",
          accepted: "1",
          lenders: [
            {
              lender: "Misty",
              lender_id: "Misty",
              state: "accepted",
              copies: "1",
            },
          ],
        },
        undefined,
        "Misty"
      )
    ).toBe(2);
  });
});

it("keeps another acceptable Edition's requests separate from Deck coverage", () => {
  const a = {
    edition_id: "A",
    requested: "2",
    accepted: "0",
    lenders: [
      {
        lender: "Misty",
        lender_id: "one",
        state: "requested" as const,
        copies: "2",
      },
    ],
  };
  expect(borrowRemainder(4, 2, a, undefined, "one")).toBe(2);
  expect(borrowRemainder(4, 2, a, a, "one")).toBe(0);
});
it("two Friends named Misty retain separate availability", () => {
  const pending = {
    edition_id: "A",
    requested: "1",
    accepted: "0",
    lenders: [
      {
        lender: "Misty",
        lender_id: "one",
        state: "requested" as const,
        copies: "1",
      },
    ],
  };
  expect(borrowRemainder(4, 2, pending, pending, "one")).toBe(1);
  expect(borrowRemainder(4, 2, pending, pending, "two")).toBe(2);
});

it("defaults to the remaining spare copies, without borrowing from a Deck unnecessarily", () => {
  const pending = {
    edition_id: "A",
    requested: "1",
    accepted: "0",
    lenders: [
      {
        lender: "Misty",
        lender_id: "one",
        state: "requested" as const,
        copies: "1",
      },
    ],
  };
  expect(
    borrowOffer(
      5,
      { collector_id: "one", spare: "3", in_deck: "3" },
      pending,
      pending
    )
  ).toEqual({ cap: 4, quantity: 2, limit: 6 });
});

it("borrowOffer gives the Friend's whole availability as limit", () => {
  const covered = {
    edition_id: "A",
    requested: "3",
    accepted: "0",
    lenders: [],
  };
  expect(
    borrowOffer(
      3,
      { collector_id: "one", spare: "2", in_deck: "1" },
      covered,
      covered
    )
  ).toEqual({ cap: 0, quantity: 0, limit: 3 });
});

const waiting = (
  deck_id: string | null,
  edition_id: string,
  lender: string,
  state: "requested" | "accepted",
  copies: string
) => ({ deck_id, edition_id, lender, lender_id: lender, state, copies });

it("waitingByDeck groups each Deck's lines by Edition, sums requested and accepted, keeps lender order and leaves out Unsorted", () => {
  const byDeck = waitingByDeck([
    waiting("D1", "A", "Misty", "accepted", "1"),
    waiting("D1", "A", "Brock", "requested", "2"),
    waiting("D1", "B", "Misty", "requested", "1"),
    waiting("D2", "A", "Misty", "requested", "4"),
    waiting(null, "A", "Misty", "requested", "5"),
  ]);
  expect([...byDeck.keys()]).toEqual(["D1", "D2"]);
  const first = byDeck.get("D1")!.get("A")!;
  expect([first.requested, first.accepted]).toEqual(["2", "1"]);
  expect(
    first.lenders.map((who) => `${who.lender} ${who.state} ${who.copies}`)
  ).toEqual(["Misty accepted 1", "Brock requested 2"]);
  expect(byDeck.get("D1")!.get("B")!.requested).toBe("1");
  expect(byDeck.get("D2")!.get("A")!.requested).toBe("4");
});

const ready = (
  deckId: string,
  lines: ReturnType<typeof waitingByDeck>
): PendingState => ({
  kind: "ready",
  deckId,
  stale: false,
  lines: lines.get(deckId) ?? new Map(),
});

it("rowCoverage counts each Deck up to its own need and keeps every Deck's lenders", () => {
  const byDeck = waitingByDeck([
    waiting("D1", "A", "Misty", "requested", "5"),
    waiting("D2", "A", "Brock", "accepted", "1"),
  ]);
  const coverage = rowCoverage(
    [
      { deck_id: "D1", need: "2" },
      { deck_id: "D2", need: "3" },
    ],
    "A",
    (id) => ready(id, byDeck)
  )!;
  expect(coverage.requested).toBe("3");
  expect(coverage.lenders.map((who) => who.lender)).toEqual(["Misty", "Brock"]);
});

it("rowCoverage is undefined when no Deck is waiting", () => {
  const byDeck = waitingByDeck([waiting("D1", "B", "Misty", "requested", "1")]);
  expect(
    rowCoverage([{ deck_id: "D1", need: "2" }], "A", (id) => ready(id, byDeck))
  ).toBeUndefined();
  expect(
    rowCoverage([{ deck_id: "D1", need: "2" }], "B", () => ({
      kind: "loading",
      deckId: "D1",
    }))
  ).toBeUndefined();
});
