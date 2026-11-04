// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getLoan, getLoanSide, type LoanView } from "../social_generated";
import { LoanScreen } from "./LoanScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoan: vi.fn(),
  getLoanSide: vi.fn(),
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
