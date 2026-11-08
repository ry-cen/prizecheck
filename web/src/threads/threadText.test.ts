import { expect, it } from "vitest";
import type { EventView, TimelineItem } from "../social_generated";
import { agreementText, itemState, timelineText } from "./threadText";
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
    "Misty: Sent a Counter · Changed Iono to 1 for you to give · Cash now: They pay $3.00"
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
  expect(text).toContain("Return by Nov 10, 2026");
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
it("labels recorded quantities as a claim until the other collector confirms", () => {
  const data = { returned: [{ edition_id: "private-card", quantity: 2 }] };
  expect(
    timelineText(event("return_recorded", data), "low", "Misty", {
      "private-card": "Iono",
    })
  ).toBe("Misty: Recorded a return · Recorded for return: 2 Iono");
  expect(
    timelineText(event("return_confirmed", data), "low", "Misty", {
      "private-card": "Iono",
    })
  ).toBe("Misty: Confirmed the return · Returned: 2 Iono");
});

it.each([
  [0, 2, "Added 2 Iono for you to give"],
  [2, 0, "Removed 2 Iono for you to give"],
  [1, 3, "Changed Iono to 3 for you to give"],
])(
  "describes a quantity change from %s to %s",
  (from_qty, to_qty, expected) => {
    expect(
      timelineText(
        event("revised", {
          lines: [{ giver: "low", edition_id: "iono", from_qty, to_qty }],
        }),
        "low",
        "Misty",
        { iono: "Iono" }
      )
    ).toBe(`Misty: Revised the offer · ${expected}`);
  }
);
it("uses lending language for Loan changes", () => {
  expect(
    timelineText(
      event("edited", {
        lines: [{ giver: "high", edition_id: "iono", from_qty: 0, to_qty: 2 }],
      }),
      "low",
      "Misty",
      { iono: "Iono" },
      "loan"
    )
  ).toBe("Misty: Changed the Loan terms · Added 2 Iono for Misty to lend");
});
it.each([
  ["loan", "2", "0", "Lending 2"],
  ["loan", "0", "3", "Borrowing 3"],
  ["trade", "2", "1", "You give 2 · You get 1"],
] as const)(
  "summarizes %s current quantities",
  (kind, you_give, you_get, expected) => {
    expect(
      agreementText({ kind, summary: { you_give, you_get, cards: [] } })
    ).toBe(expected);
  }
);

it("describes removing cash and a return date without a raw diff", () => {
  expect(
    timelineText(
      event("edited", {
        cash: {
          from: { cents: 100, payer: "low" },
          to: { cents: 0, payer: null },
        },
        return_by: { from: "2026-11-10", to: null },
      }),
      "low",
      "Misty",
      {},
      "loan"
    )
  ).toBe(
    "Misty: Changed the Loan terms · Cash now: No cash · Removed the return date"
  );
});
