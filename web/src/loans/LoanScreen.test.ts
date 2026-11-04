// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  getLoan,
  getLoanSide,
  startReturn,
  acceptBorrowRequest,
  changeReturnBy,
  type LoanView,
} from "../social_generated";
import { useRoute } from "../shell/useRoute";
import { LoanScreen } from "./LoanScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoan: vi.fn(),
  getLoanSide: vi.fn(),
  startReturn: vi.fn(),
  acceptBorrowRequest: vi.fn(),
  changeReturnBy: vi.fn(),
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
            (b) => b.textContent === "Retry request"
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
it("previews a partial acceptance without presenting draft quantities as agreed terms", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoan).mockResolvedValue({
    ...loan,
    state: "requested",
    role: "lender",
    closed_reason: null,
    closed_by: null,
    lines: [{ ...loan.lines[0], requested: "3", promised: "0" }],
    section: "needs_you",
    needs_you: true,
    actions: ["accept", "decline"],
  });
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [{ edition_id: "iono", available: "2" }],
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
    expect(host.querySelector("h1")?.textContent).toBe(
      "Misty wants to borrow 3 cards"
    );
    const preview = host.querySelector('[aria-label="Acceptance preview"]')!;
    expect(preview.textContent).toContain("2 to lend; 1 not lent.");
    expect(preview.textContent).toContain(
      "No return date. Accepting agrees to these quantities and this return date."
    );
    expect(acceptBorrowRequest).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

for (const role of ["lender", "borrower"] as const) {
  for (const entry of ["All back", "Some back"] as const) {
    it(`S2-01: ${role} retains ${entry} through edits, Not now and Some back until exact replay settles`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const active: LoanView = {
        ...loan,
        role,
        state: "handed_over",
        closed_reason: null,
        closed_by: null,
        you_confirmed_handover: true,
        they_confirmed_handover: true,
        lines: [{ ...loan.lines[0], requested: "3", promised: "3" }],
        section: "out_now",
        revision: 4,
        actions: ["start_return", "change_return_by"],
      };
      vi.mocked(getLoan).mockResolvedValue(active);
      vi.mocked(getLoanSide).mockResolvedValue({
        loan_id: "round",
        deck: null,
        can_promise: [],
        picks: [],
        suggested: [],
      });
      let lose!: (cause: Error) => void;
      vi.mocked(startReturn).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            lose = reject;
          })
      );
      vi.mocked(startReturn).mockResolvedValueOnce({
        ...active,
        actions: [],
        revision: 5,
        pending_return: {
          return_id: "claim",
          started_by: "you",
          lines: [
            { edition_id: "iono", copies: entry === "All back" ? "3" : "2" },
          ],
          you_confirmed: true,
          they_confirmed: false,
        },
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const button = (name: string) =>
        [...host.querySelectorAll("button")].find(
          (b) => b.textContent === name
        );
      function View() {
        const route = useRoute();
        return h(
          "div",
          null,
          h(
            "button",
            {
              "data-navigate": true,
              onClick: () => route.navigate("/collection"),
            },
            "Collection"
          ),
          h(LoanScreen, {
            loanId: "item",
            onCanonicalLoan: vi.fn(),
            onLoanChanged: vi.fn(),
            onAllLoans: vi.fn(),
            onOpenDeck: vi.fn(),
          })
        );
      }
      try {
        window.history.replaceState(null, "", "/loans/item");
        vi.stubGlobal("scrollTo", vi.fn());
        await act(async () => root.render(h(View)));
        await act(async () => button(entry)!.click());
        const decrease = () =>
          host.querySelector<HTMLButtonElement>(
            'button[aria-label^="Decrease Copies of Iono"]'
          )!;
        if (entry === "Some back") {
          await act(async () => decrease().click());
          await act(async () =>
            button(
              role === "lender" ? "Record return" : "Give these back"
            )!.click()
          );
        }
        const original = JSON.stringify(vi.mocked(startReturn).mock.calls[0]);
        expect(JSON.parse(original)[1].lines).toEqual([
          { edition_id: "iono", quantity: entry === "All back" ? "3" : "2" },
        ]);
        // Try the same edits while the POST is in flight, then after its response is lost.
        for (const lost of [false, true]) {
          if (lost) await act(async () => lose(new TypeError("lost response")));
          expect(decrease().matches(":disabled")).toBe(true);
          await act(async () => decrease().click());
          expect(button("Not now")!.matches(":disabled")).toBe(true);
          await act(async () => button("Not now")!.click());
          expect(button("Some back")).toBeUndefined();
          expect(button("All back")).toBeUndefined();
          expect(
            host.querySelector('[aria-label="More for this Loan"]')
          ).toBeNull();
          expect(startReturn).toHaveBeenCalledTimes(1);
          await act(async () =>
            host.querySelector<HTMLButtonElement>("[data-navigate]")!.click()
          );
          expect(window.location.pathname).toBe("/loans/item");
          expect(
            window.dispatchEvent(
              new Event("beforeunload", { cancelable: true })
            )
          ).toBe(false);
        }
        const retry = button("Retry request")!;
        expect(retry.matches(":disabled")).toBe(false);
        await act(async () => retry.click());
        expect(startReturn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(vi.mocked(startReturn).mock.calls[1])).toBe(
          original
        );
        expect(button("Retry request")).toBeUndefined();
        expect(
          window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
        ).toBe(true);
        await act(async () =>
          host.querySelector<HTMLButtonElement>("[data-navigate]")!.click()
        );
        expect(window.location.pathname).toBe("/collection");
        expect(host.querySelector("h1")?.textContent).toContain(
          "Waiting for Misty to confirm"
        );
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
      }
    });
  }
}
it("S2-01: an unknown date save cannot become Clear date or a return command", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1000
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    1000
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 30, 30)
  );
  const active: LoanView = {
    ...loan,
    role: "lender",
    state: "handed_over",
    closed_reason: null,
    closed_by: null,
    return_by: "2026-12-03",
    lines: [{ ...loan.lines[0], promised: "3" }],
    actions: ["change_return_by", "start_return"],
  };
  vi.mocked(getLoan).mockResolvedValue(active);
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [],
    picks: [],
    suggested: [],
  });
  vi.mocked(changeReturnBy)
    .mockRejectedValueOnce(new TypeError("lost response"))
    .mockResolvedValueOnce({ ...active, revision: 3 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name);
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
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="More for this Loan"]'
        )!
        .click()
    );
    expect(
      [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (b) => b.textContent
      )
    ).toContain("Change return-by date");
    await act(async () =>
      [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((b) => b.textContent === "Change return-by date")!
        .click()
    );
    await act(async () => button("Save")!.click());
    const original = JSON.stringify(vi.mocked(changeReturnBy).mock.calls[0]);
    expect(button("Clear date")!.matches(":disabled")).toBe(true);
    await act(async () => button("Clear date")!.click());
    expect(button("Cancel")!.matches(":disabled")).toBe(true);
    await act(async () => button("Cancel")!.click());
    expect(button("All back")).toBeUndefined();
    expect(startReturn).not.toHaveBeenCalled();
    await act(async () => button("Retry request")!.click());
    expect(changeReturnBy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(changeReturnBy).mock.calls[1])).toBe(
      original
    );
    expect(button("All back")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  }
});
