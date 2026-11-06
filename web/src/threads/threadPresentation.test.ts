import { describe, expect, it } from "vitest";
import { itemTabName, waitingAction } from "./threadPresentation";
describe("item badge accessible names", () => {
  it("keeps the server union separate from overlapping waiting and unread counts", () => {
    expect(itemTabName("Trades", { needs_you: 3, waiting: 2, unread: 2 })).toBe(
      "Trades, 3 need you: 2 waiting on you, 2 with new messages"
    );
    expect(itemTabName("Trades", { needs_you: 3, waiting: 2, unread: 1 })).toBe(
      "Trades, 3 need you: 2 waiting on you, 1 with new messages"
    );
    expect(itemTabName("Trades", { needs_you: 4, waiting: 3, unread: 2 })).toBe(
      "Trades, 4 need you: 3 waiting on you, 2 with new messages"
    );
    expect(itemTabName("Loans", { needs_you: 1, waiting: 0, unread: 1 })).toBe(
      "Loans, 1 need you: 0 waiting on you, 1 with new messages"
    );
    expect(
      itemTabName("Trades", { needs_you: 0, waiting: 0, unread: 0 })
    ).toBeUndefined();
  });
});

it("keeps Trade counter wording out of Loan actions", () => {
  expect(waitingAction("loan", "answer")).toBe("Answer Loan");
  expect(waitingAction("trade", "answer")).toBe("Accept or counter");
});
