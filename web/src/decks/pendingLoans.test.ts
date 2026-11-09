import { describe, expect, it } from "vitest";
import {
  borrowDefault,
  borrowOffer,
  borrowRemainder,
  pendingText,
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
  ).toEqual({ cap: 4, quantity: 2 });
});
