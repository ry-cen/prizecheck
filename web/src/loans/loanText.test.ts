import { describe, expect, it } from "vitest";
import { loanRoleFact } from "./loanText";

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
