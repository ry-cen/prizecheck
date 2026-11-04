// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  getLoan,
  getLoanSide,
  startReturn,
  type LoanView,
} from "../social_generated";
import { LoanScreen } from "./LoanScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoan: vi.fn(),
  getLoanSide: vi.fn(),
  startReturn: vi.fn(),
}));
vi.mock("../threads/ThreadTimeline", () => ({ ThreadTimeline: () => null }));
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "item",
  kind: "borrow_request",
  state: "closed",
  closed_reason: "declined",
  closed_by: "them",
  role: "borrower",
  other: { collector_id: "friend", display_name: "Misty" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea Evolved",
      collector_number: "185",
      descriptor: {},
      image_url: null,
      requested: "1",
      promised: "0",
      written_off: "0",
    },
  ],
  needs_you: false,
  section: "history",
  actions: [],
  revision: 2,
};
it("replaces a historical round address before rendering the current Loan's controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/loans/round");
  vi.mocked(getLoan).mockResolvedValue(loan);
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [],
    picks: [],
    suggested: [],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    canonical = vi.fn();
  function View() {
    const [id, setId] = useState("round");
    return h(
      "main",
      null,
      h(LoanScreen, {
        key: id,
        loanId: id,
        onLoanChanged: vi.fn(),
        onAllLoans: vi.fn(),
        onOpenDeck: vi.fn(),
        onCanonicalLoan: (next) => {
          canonical(next);
          window.history.replaceState(null, "", `/loans/${next}`);
          setId(next);
        },
      })
    );
  }
  try {
    await act(async () => root.render(h(View)));
    expect(canonical).toHaveBeenCalledExactlyOnceWith("item");
    expect(window.location.pathname).toBe("/loans/item");
    expect(host.querySelectorAll("main")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe(
      "Misty declined your request for 1 card"
    );
    expect(host.querySelector('[aria-label="Loan details"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
for (const role of ["lender", "borrower"] as const) {
  it.each([false, true])(
    `records All back in one press as ${role}, never confirms for the other collector (lost=%s)`,
    async (lost) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const active: LoanView = {
        ...loan,
        state: "handed_over",
        role,
        closed_reason: null,
        closed_by: null,
        you_confirmed_handover: true,
        they_confirmed_handover: true,
        lines: [{ ...loan.lines[0], requested: "3", promised: "3" }],
        section: "out_now",
        revision: 4,
        actions: ["start_return"],
      };
      const pending: LoanView = {
        ...active,
        revision: 5,
        actions: [],
        pending_return: {
          return_id: "claim",
          started_by: "you",
          lines: [{ edition_id: "iono", copies: "3" }],
          you_confirmed: true,
          they_confirmed: false,
        },
      };
      vi.mocked(getLoan).mockResolvedValue(active);
      vi.mocked(getLoanSide).mockResolvedValue({
        loan_id: "round",
        deck: null,
        can_promise: [],
        picks: [],
        suggested: [],
      });
      vi.mocked(startReturn).mockResolvedValue(pending);
      if (lost)
        vi.mocked(startReturn).mockRejectedValueOnce(
          new TypeError("lost response")
        );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            h(LoanScreen, {
              loanId: "item",
              onCanonicalLoan: vi.fn(),
              onLoanChanged: vi.fn(),
              onAllLoans: vi.fn(),
              onOpenDeck: vi.fn(),
            })
          )
        );
        const all = [...host.querySelectorAll("button")].find(
          (b) => b.textContent === "All back"
        )!;
        expect(host.textContent).toContain(
          "Record only after the physical return."
        );
        expect(startReturn).not.toHaveBeenCalled();
        await act(async () => all.click());
        if (lost) {
          const retry = [...host.querySelectorAll("button")].find(
            (b) =>
              b.textContent ===
              (role === "lender" ? "Record return" : "Give these back")
          )!;
          await act(async () => retry.click());
          expect(JSON.stringify(vi.mocked(startReturn).mock.calls[1])).toBe(
            JSON.stringify(vi.mocked(startReturn).mock.calls[0])
          );
        }
        expect(startReturn).toHaveBeenCalledTimes(lost ? 2 : 1);
        expect(startReturn).toHaveBeenLastCalledWith(
          "item",
          expect.objectContaining({
            loan_id: "round",
            revision: 4,
            lines: [{ edition_id: "iono", quantity: "3" }],
          })
        );
        expect(host.querySelector("h1")?.textContent).toBe(
          role === "lender"
            ? "You recorded 3 cards back · Waiting for Misty to confirm"
            : "You recorded giving back 3 cards · Waiting for Misty to confirm"
        );
        expect(
          [...host.querySelectorAll("button")].some(
            (b) =>
              b.textContent === "Yes, they're back" ||
              b.textContent === "Yes, I gave them back"
          )
        ).toBe(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
      }
    }
  );
}
it("Some back opens quantities without posting a return", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoan).mockResolvedValue({
    ...loan,
    state: "handed_over",
    role: "borrower",
    closed_reason: null,
    closed_by: null,
    lines: [{ ...loan.lines[0], requested: "3", promised: "3" }],
    section: "out_now",
    actions: ["start_return"],
  });
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [],
    picks: [],
    suggested: [],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(LoanScreen, {
          loanId: "item",
          onCanonicalLoan: vi.fn(),
          onLoanChanged: vi.fn(),
          onAllLoans: vi.fn(),
          onOpenDeck: vi.fn(),
        })
      )
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Some back")!
        .click()
    );
    expect(startReturn).not.toHaveBeenCalled();
    expect(
      [...host.querySelectorAll("button")].some(
        (b) => b.textContent === "Give these back"
      )
    ).toBe(true);
    expect(
      host.querySelector('[role="group"][aria-label^="Copies of Iono"]')
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
