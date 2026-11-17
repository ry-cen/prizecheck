import { describe, expect, it } from "vitest";
import type { LoanView } from "../social_generated";
import {
  borrowedPlace,
  copiesLabel,
  loanStepConfirmation,
  handoverConfirmText,
  returnConfirmText,
  lineOut,
  loanHeadline,
  loanRoleFact,
  waitingText,
} from "./loanText";

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
    thread_id: "loan-thread",
    loan_id: "loan",
    kind: "borrow_request",
    state: "handed_over",
    closed_reason: null,
    closed_by: null,
    role,
    other: { collector_id: "other", display_name: "Sam" },
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
      return_id: "return",
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

describe("Loan confirmation labels", () => {
  it("counts promised copies across lines for handover", () => {
    const loan = returning("borrower", false, "1");
    loan.lines = [{ ...loan.lines[0], promised: "1" }];
    expect(handoverConfirmText(loan)).toBe("Yes, I have it");
    loan.lines.push({ ...loan.lines[0], edition_id: "other" });
    expect(handoverConfirmText(loan)).toBe("Yes, I have them");
    loan.lines = [{ ...loan.lines[0], promised: "2" }];
    expect(handoverConfirmText(loan)).toBe("Yes, I have them");
    expect(handoverConfirmText({ ...loan, role: "lender" })).toBe(
      "Mark as handed over"
    );
  });
  it.each([
    [true, 1, "Yes, it's back"],
    [true, 2, "Yes, they're back"],
    [false, 1, "Yes, I gave it back"],
    [false, 2, "Yes, I gave them back"],
  ] as const)(
    "labels lender=%s returning %s copies",
    (lender, copies, label) => {
      expect(returnConfirmText(lender, copies)).toBe(label);
    }
  );
});

it("confirms the performed step in Loan terms, preserving singular receipt wording", () => {
  const loan = {
    kind: "borrow_request",
    role: "borrower",
    lines: [{ promised: "1", requested: "1" }],
    other: { collector_id: "friend" },
  } as LoanView;
  expect(loanStepConfirmation("accept", loan)).toBe("Borrow Request accepted.");
  expect(loanStepConfirmation("decline", loan)).toBe(
    "Borrow Request declined."
  );
  expect(loanStepConfirmation("handover", loan)).toBe("Confirmed you have it.");
  expect(
    loanStepConfirmation("handover", {
      ...loan,
      lines: [{ ...loan.lines[0], promised: "2" }],
    })
  ).toBe("Confirmed you have them.");
  expect(loanStepConfirmation("confirm_return", loan)).toBe(
    "Return confirmed."
  );
});

describe("quantity labels", () => {
  it.each([
    [1, "1 copy"],
    [2, "2 copies"],
    [0, "0 copies"],
  ])("labels %s as %s", (count, label) => {
    expect(copiesLabel(count)).toBe(label);
  });
});

describe("where a borrower's copies are", () => {
  const goes = { deck: "For", unsorted: "Goes to Unsorted" };
  const arrived = { deck: "Arrived in", unsorted: "Arrived in Unsorted" };
  const loan = (
    state: LoanView["state"],
    role: LoanView["role"],
    you: boolean,
    they: boolean
  ) => ({
    state,
    role,
    you_confirmed_handover: you,
    they_confirmed_handover: they,
  });
  for (const state of ["requested", "accepted"] as const)
    it(`says where they will go while the Loan is ${state} and nobody confirmed`, () => {
      expect(borrowedPlace(loan(state, "borrower", false, false))).toEqual(
        goes
      );
    });
  it("says where they arrived once the borrower confirmed first, though the Loan is still accepted", () => {
    expect(borrowedPlace(loan("accepted", "borrower", true, false))).toEqual(
      arrived
    );
  });
  it("still says where they will go when only the lender confirmed", () => {
    expect(borrowedPlace(loan("accepted", "borrower", false, true))).toEqual(
      goes
    );
  });
  it("goes back to where they will go when the borrower takes the confirmation back", () => {
    expect(borrowedPlace(loan("accepted", "borrower", true, false))).toEqual(
      arrived
    );
    expect(borrowedPlace(loan("accepted", "borrower", false, false))).toEqual(
      goes
    );
  });
  it("says where they arrived once handed over", () => {
    expect(borrowedPlace(loan("handed_over", "borrower", true, true))).toEqual(
      arrived
    );
  });
  it("reads the borrower's confirmation from the lender's side too", () => {
    expect(borrowedPlace(loan("accepted", "lender", false, true))).toEqual(
      arrived
    );
    expect(borrowedPlace(loan("accepted", "lender", true, false))).toEqual(
      goes
    );
  });
});
