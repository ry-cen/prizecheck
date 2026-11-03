import { describe, expect, it } from "vitest";
import type { LoanView } from "../social_generated";
import { lineOut, loanHeadline, loanRoleFact, waitingText } from "./loanText";

describe("the Loan role fact", () => {
  for (const role of ["lender", "borrower"] as const) {
    for (const state of [
      "requested",
      "offered",
      "accepted",
      "handed_over",
    ] as const) {
      it(`keeps the present tense for an open ${state} Loan's ${role}`, () => {
        expect(loanRoleFact({ state, role, closed_reason: null })).toBe(
          role === "lender" ? "You're lending" : "You're borrowing"
        );
      });
    }
    for (const closed_reason of [
      "declined",
      "withdrawn",
      "cancelled",
      null,
    ] as const) {
      it(`omits the ${role} fact when closed with ${closed_reason}`, () => {
        expect(
          loanRoleFact({ state: "closed", role, closed_reason })
        ).toBeNull();
      });
    }
    for (const closed_reason of ["returned", "written_off"] as const) {
      it(`uses past tense for the ${role} after copies were ${closed_reason}`, () => {
        expect(loanRoleFact({ state: "closed", role, closed_reason })).toBe(
          role === "lender" ? "You lent" : "You borrowed"
        );
      });
    }
  }
});

/** Four agreed copies: one already returned, one written off, two still canonically out. */
function returning(
  role: LoanView["role"],
  ownFirst: boolean,
  back: string
): LoanView {
  return {
    id: "loan",
    kind: "borrow_request",
    state: "handed_over",
    closed_reason: null,
    closed_by: null,
    role,
    other: { collector_id: "other", display_name: "Sam", handle: null },
    return_by: null,
    you_confirmed_handover: true,
    they_confirmed_handover: true,
    lines: [
      {
        edition_id: "iono",
        name: "Iono",
        set_code: "PAL",
        set_name: "Paldea Evolved",
        collector_number: "185",
        descriptor: { finish: "normal" },
        image_url: null,
        requested: "4",
        promised: "4",
        returned: "1",
        written_off: "1",
      },
    ],
    needs_you: !ownFirst,
    section: ownFirst ? "pending" : "needs_you",
    actions: ownFirst ? [] : ["confirm_return"],
    revision: 4,
    pending_return: {
      started_by: ownFirst ? "you" : "them",
      lines: [{ edition_id: "iono", copies: back }],
      you_confirmed: ownFirst,
      they_confirmed: !ownFirst,
    },
  };
}

describe("pending-return headlines", () => {
  const claims: {
    role: LoanView["role"];
    ownFirst: boolean;
    back: string;
    expected: string;
  }[] = [
    {
      role: "lender",
      ownFirst: true,
      back: "1",
      expected:
        "You recorded 1 card back · Waiting for Sam to confirm · 1 card still out",
    },
    {
      role: "lender",
      ownFirst: true,
      back: "2",
      expected: "You recorded 2 cards back · Waiting for Sam to confirm",
    },
    {
      role: "lender",
      ownFirst: false,
      back: "1",
      expected:
        "Sam says they gave back 1 card · Waiting for you to confirm · 1 card still out",
    },
    {
      role: "lender",
      ownFirst: false,
      back: "2",
      expected: "Sam says they gave back 2 cards · Waiting for you to confirm",
    },
    {
      role: "borrower",
      ownFirst: true,
      back: "1",
      expected:
        "You recorded giving back 1 card · Waiting for Sam to confirm · 1 card still out",
    },
    {
      role: "borrower",
      ownFirst: true,
      back: "2",
      expected: "You recorded giving back 2 cards · Waiting for Sam to confirm",
    },
    {
      role: "borrower",
      ownFirst: false,
      back: "1",
      expected:
        "Sam says they got 1 card back · Waiting for you to confirm · 1 card still out",
    },
    {
      role: "borrower",
      ownFirst: false,
      back: "2",
      expected: "Sam says they got 2 cards back · Waiting for you to confirm",
    },
  ];
  it.each(claims)(
    "$role, own confirmation first: $ownFirst, returning $back",
    ({ role, ownFirst, back, expected }) => {
      const loan = returning(role, ownFirst, back);
      expect(loanHeadline(loan)).toBe(expected);
      expect(waitingText(loan)).toBe(
        ownFirst ? "Waiting for Sam to confirm" : null
      );
      // A pending claim changes neither completed-return counts nor canonical copies out.
      expect(lineOut(loan.lines[0])).toBe(2);
      expect(loan.lines[0].returned).toBe("1");
      expect(loan.lines[0].written_off).toBe("1");
    }
  );
  for (const role of ["lender", "borrower"] as const) {
    it(`restores the ${role}'s possession heading after a completed partial return`, () => {
      const loan = returning(role, true, "1");
      loan.pending_return = null;
      loan.lines[0].returned = "2";
      expect(loanHeadline(loan)).toBe(
        role === "lender"
          ? "Sam has 1 card of yours"
          : "You have 1 card of Sam's"
      );
    });
    it(`keeps the closed ${role} headline after the final return`, () => {
      const loan = returning(role, true, "2");
      loan.pending_return = null;
      loan.lines[0].returned = "3";
      loan.state = "closed";
      loan.closed_reason = "returned";
      expect(loanHeadline(loan)).toBe(
        `Your Loan ${role === "lender" ? "to" : "from"} Sam ended`
      );
    });
    it(`doesn't wait on a deleted counterpart for the ${role}`, () => {
      const loan = returning(role, true, "2");
      loan.other.collector_id = null;
      expect(loanHeadline(loan)).toContain(" · Finish the return");
      expect(waitingText(loan)).toBeNull();
    });
  }
  it("keeps an outstanding write-off choice prominent for the borrower", () => {
    const loan = returning("borrower", true, "1");
    loan.awaiting_choice = "1";
    expect(loanHeadline(loan)).toBe("Sam wrote off 1 card you have");
  });
});
