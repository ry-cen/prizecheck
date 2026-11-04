import { expect, it } from "vitest";
import type { EventView, TimelineItem } from "../social_generated";
import { itemState, timelineText } from "./threadText";
const event = (kind: string, data?: EventView["data"]): TimelineItem => ({
  kind: "event",
  at: "2026-11-04T10:00:00Z",
  cursor: "private-cursor",
  event: {
    id: "private-event",
    round_id: "private-round",
    actor: "high",
    at: "2026-11-04T10:00:00Z",
    kind,
    data,
  },
});
it.each([
  ["offered", "Proposal"],
  ["agreed", "Agreed"],
  ["confirming", "Swap confirmations"],
  ["done", "Swapped"],
  ["closed", "Closed"],
])("shows Trade state %s as %s", (state, label) => {
  expect(itemState({ state, kind: "trade" })).toBe(label);
});
it("keeps Borrow and Lend intent separate from Trade proposals", () => {
  expect(itemState({ state: "offered", kind: "loan" })).toBe("Lend offer");
  expect(itemState({ state: "requested", kind: "loan" })).toBe(
    "Borrow Request"
  );
});
it("renders replacement terms as diffs without round, card or cursor identities", () => {
  const text = timelineText(
    event("countered", {
      lines: [
        { giver: "low", edition_id: "private-card", from_qty: 2, to_qty: 1 },
      ],
      cash: {
        from: { cents: 500, payer: "low" },
        to: { cents: 300, payer: "high" },
      },
    }),
    "low",
    "Misty",
    { "private-card": "Iono" }
  );
  expect(text).toBe(
    "Misty: Sent a Counter · You give Iono: 2 → 1 · Cash: You pay $5.00 → They pay $3.00"
  );
  expect(text).not.toContain("private-");
});
it("states partial acceptance and the unpromised copies and return date immediately", () => {
  const text = timelineText(
    event("partly_accepted", {
      not_lent: [{ edition_id: "private-card", quantity: 1 }],
      return_by: { from: null, to: "2026-11-10" },
    }),
    "low",
    "Misty",
    { "private-card": "Iono" }
  );
  expect(text).toContain("Agreed to changed Loan terms");
  expect(text).toContain("Not lent: 1 Iono");
  expect(text).toContain("No return date → Nov 10, 2026");
  expect(text).not.toContain("private-");
});
it("distinguishes a recorded return from its confirmation and completion", () => {
  expect(timelineText(event("return_recorded"), "low", "Misty", {})).toBe(
    "Misty: Recorded a return"
  );
  expect(timelineText(event("return_confirmed"), "low", "Misty", {})).toBe(
    "Misty: Confirmed the return"
  );
  expect(timelineText(event("returned"), "low", "Misty", {})).toBe(
    "Misty: All copies are back"
  );
});
it("uses neutral text for unknown events and never exposes their internal reason", () => {
  expect(
    timelineText(event("closed_internal_reason"), "low", "Misty", {})
  ).toBe("Misty: Agreement updated");
});
it("attributes each swap confirmation separately from completion", () => {
  expect(timelineText(event("swap_confirmed"), "high", "Misty", {})).toBe(
    "You: Confirmed the swap"
  );
  expect(
    timelineText(
      {
        ...event("swapped"),
        event: { ...event("swapped").event!, actor: null },
      },
      "low",
      "Misty",
      {}
    )
  ).toBe("Swap complete");
});
