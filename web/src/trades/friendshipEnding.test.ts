import { expect, it } from "vitest";
import type { LoanView } from "../social_generated";
import { traderEnding } from "../social/friendshipEnding";
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "item",
  kind: "borrow_request",
  state: "accepted",
  closed_reason: null,
  closed_by: null,
  role: "borrower",
  other: { collector_id: "friend-id", display_name: "Ash" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [],
  needs_you: false,
  section: "pending",
  actions: ["cancel"],
  revision: 1,
};
it("counts a known Friend’s Loan in a block warning without needing any Trade", () => {
  expect(traderEnding([loan], [], "trader", "ash", "friend-id")).toEqual({
    loans: 1,
    proposals: 0,
    trades: 0,
    staying: 0,
  });
  expect(traderEnding([loan], [], "other-trader", null)).toEqual({
    loans: 0,
    proposals: 0,
    trades: 0,
    staying: 0,
  });
});
