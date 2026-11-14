import { useLoanCommand } from "./PendingLoanRequest";
import { LoanTermsEditor as Editor } from "./LoanTermsEditor";
// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  editLoanTerms,
  getLoan,
  getLoanSide,
  startReturn,
  writeOff,
  acceptBorrowRequest,
  changeReturnBy,
  SocialError,
  type LoanView,
} from "../social_generated";
import { useRoute } from "../shell/useRoute";
import { LoanScreen as Screen } from "./LoanScreen";
import { LoanRecoveryProvider } from "./LoanRecovery";
import { fixture, reply } from "./testing/loanFakes";
import { createTabContext } from "./loanIntents";
const threadId = "00000000-0000-4000-8000-000000000099";
let keepReadView = false;
let packets: string[] = [];
let screenData = new Map<string, string>();
function LoanScreen(props: Parameters<typeof Screen>[0]) {
  const [recovery] = useState(() => {
    const f = fixture();
    screenData = f.shared.data;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (
        String(input).endsWith("/returns") ||
        String(input).endsWith("/write-off")
      ) {
        packets.push(String(init?.body));
        const next = await (
          String(input).endsWith("/returns") ? startReturn : writeOff
        )(threadId, JSON.parse(String(init?.body)));
        await f.server.fetchImpl(input, init);
        if (!keepReadView) vi.mocked(getLoan).mockResolvedValue(next);
        return reply(200, next);
      }
      return f.server.fetchImpl(input, init);
    };
    return { ports: { ...f.ports, fetchImpl }, tab: createTabContext() };
  });
  return h(LoanRecoveryProvider, {
    accountId: "A",
    accountName: "Ana",
    ...recovery,
    children: h(Screen, props),
  });
}
type EditorProps = Omit<Parameters<typeof Editor>[0], "onReread"> & {
  onReread?: () => void;
};
function LoanTermsEditor(props: EditorProps) {
  const [recovery] = useState(() => ({
    ports: fixture().ports,
    tab: createTabContext(),
  }));
  return h(LoanRecoveryProvider, {
    accountId: "A",
    accountName: "Ana",
    ...recovery,
    children: h(Editor, { ...props, onReread: props.onReread ?? vi.fn() }),
  });
}
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  editLoanTerms: vi.fn(),
  getLoan: vi.fn(),
  getLoanSide: vi.fn(),
  startReturn: vi.fn(),
  writeOff: vi.fn(),
  acceptBorrowRequest: vi.fn(),
  changeReturnBy: vi.fn(),
}));
vi.mock("../threads/ThreadTimeline", () => ({
  ThreadTimeline: ({ onChanged }: { onChanged?: () => void }) =>
    h("button", { onClick: onChanged }, "Chat moderation completed"),
}));
vi.mock("./BorrowDrafts", async (original) => ({
  ...(await original<typeof import("./BorrowDrafts")>()),
  useBorrowDrafts: () => ({}),
}));
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
      packets = [];
      keepReadView = false;
      const active: LoanView = {
        ...loan,
        thread_id: threadId,
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
              loanId: threadId,
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
            (b) => b.textContent === "Send it again"
          )!;
          await act(async () => retry.click());
          expect(JSON.stringify(vi.mocked(startReturn).mock.calls[1])).toBe(
            JSON.stringify(vi.mocked(startReturn).mock.calls[0])
          );
        }
        expect(
          host.querySelector('[role="alert"]')?.textContent?.trim() ?? ""
        ).toBe("");
        if (lost)
          expect(host.querySelector('[role="status"]')?.textContent).toContain(
            "It was sent."
          );
        else expect(host.textContent).not.toContain("It was sent.");
        expect(startReturn).toHaveBeenCalledTimes(lost ? 2 : 1);
        expect(JSON.parse(packets[0]).account_id).toBe("A");
        if (lost) expect(packets[1]).toBe(packets[0]);
        expect(startReturn).toHaveBeenLastCalledWith(
          threadId,
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
      "No return date. Accepting agrees to these quantities with no return date."
    );
    const dateInput =
      host.querySelector<HTMLInputElement>('input[type="date"]');
    if (!dateInput) throw new Error("Missing optional return date");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(dateInput, "2099-01-31");
      dateInput.dispatchEvent(new Event("input", { bubbles: true }));
      dateInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(preview.textContent).toContain(
      "Accepting agrees to these quantities and this return date."
    );
    expect(preview.textContent).not.toContain("No return date.");
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
      packets = [];
      keepReadView = false;
      const active: LoanView = {
        ...loan,
        thread_id: threadId,
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
            loanId: threadId,
            onCanonicalLoan: vi.fn(),
            onLoanChanged: vi.fn(),
            onAllLoans: vi.fn(),
            onOpenDeck: vi.fn(),
          })
        );
      }
      try {
        window.history.replaceState(null, "", `/loans/${threadId}`);
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
          expect(window.location.pathname).toBe(
            lost ? "/collection" : `/loans/${threadId}`
          );
          expect(
            window.dispatchEvent(
              new Event("beforeunload", { cancelable: true })
            )
          ).toBe(lost);
          expect(
            button("Chat moderation completed")!.matches(":disabled")
          ).toBe(false);
        }
        const retry = button("Send it again")!;
        expect(retry.matches(":disabled")).toBe(false);
        await act(async () => retry.click());
        expect(startReturn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(vi.mocked(startReturn).mock.calls[1])).toBe(
          original
        );
        expect(packets[1]).toBe(packets[0]);
        expect(button("Send it again")).toBeUndefined();
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

it("S2-02: completed chat moderation refreshes the live requested Loan and its focused outcome", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const active: LoanView = {
    ...loan,
    role: "lender",
    state: "requested",
    closed_reason: null,
    closed_by: null,
    actions: ["accept", "decline"],
    needs_you: true,
    section: "needs_you",
  };
  const closed: LoanView = {
    ...active,
    state: "closed",
    closed_reason: "cancelled",
    closed_by: "you",
    actions: [],
    needs_you: false,
    section: "history",
    revision: 3,
  };
  vi.mocked(getLoan)
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(active)
    .mockResolvedValue(closed);
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
    expect(host.querySelector("h1")?.textContent).toContain("wants to borrow");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Chat moderation completed")!
        .click()
    );
    expect(host.querySelector("h1")?.textContent).toBe(
      "You cancelled this Loan"
    );
    expect(document.activeElement).toBe(host.querySelector("h1"));
    expect(getLoan).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
for (const lateStatus of ["none", "404", "200"] as const) {
  const lateRead = lateStatus !== "none";
  it(`S2-01/S2-02: moderation and late reads preserve an unknown return then refresh once after exact replay (read=${lateStatus})`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    packets = [];
    keepReadView = true;
    const active: LoanView = {
      ...loan,
      thread_id: threadId,
      state: "handed_over",
      closed_reason: null,
      closed_by: null,
      role: "borrower",
      you_confirmed_handover: true,
      they_confirmed_handover: true,
      lines: [
        { ...loan.lines[0], requested: "3", promised: "3", returned: "0" },
      ],
      actions: ["start_return"],
      revision: 4,
      section: "out_now",
    };
    const receipt: LoanView = {
      ...active,
      actions: [],
      revision: 5,
      pending_return: {
        return_id: "claim",
        started_by: "you",
        lines: [{ edition_id: "iono", copies: "3" }],
        you_confirmed: true,
        they_confirmed: false,
      },
    };
    const closed: LoanView = {
      ...active,
      state: "closed",
      closed_reason: "returned",
      closed_by: null,
      lines: [{ ...active.lines[0], returned: "3" }],
      actions: [],
      revision: 6,
      section: "history",
    };
    let rejectRead!: (cause: Error) => void,
      resolveRead!: (value: LoanView) => void,
      rejectPost!: (cause: Error) => void;
    const heldRead = new Promise<LoanView>((resolve, reject) => {
      rejectRead = reject;
      resolveRead = resolve;
    });
    vi.mocked(getLoan)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active);
    if (lateRead)
      vi.mocked(getLoan)
        .mockReturnValueOnce(heldRead)
        .mockReturnValueOnce(heldRead);
    vi.mocked(getLoan).mockResolvedValue(closed);
    vi.mocked(getLoanSide).mockResolvedValue({
      loan_id: "round",
      deck: null,
      can_promise: [],
      picks: [],
      suggested: [],
    });
    vi.mocked(startReturn)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectPost = reject;
          })
      )
      .mockResolvedValueOnce(receipt);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const button = (name: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
    try {
      await act(async () =>
        root.render(
          h(LoanScreen, {
            loanId: threadId,
            onCanonicalLoan: vi.fn(),
            onLoanChanged: vi.fn(),
            onAllLoans: vi.fn(),
            onOpenDeck: vi.fn(),
          })
        )
      );
      if (lateRead) {
        await act(async () => button("Chat moderation completed").click());
        expect(getLoan).toHaveBeenCalledTimes(4);
      }
      await act(async () => button("All back").click());
      const original = JSON.stringify(vi.mocked(startReturn).mock.calls[0]);
      if (lateRead) {
        await act(async () => {
          if (lateStatus === "404")
            rejectRead(new SocialError(404, "LOAN_NOT_FOUND"));
          else resolveRead(closed);
        });
        expect(host.querySelector("h1")?.textContent).toBe(
          "You have 3 cards of Misty's"
        );
      }
      await act(async () => rejectPost(new TypeError("lost response")));
      await act(async () => button("Chat moderation completed").click());
      await act(async () => button("Chat moderation completed").click());
      expect(getLoan).toHaveBeenCalledTimes(lateRead ? 4 : 2);
      expect(button("Send it again").matches(":disabled")).toBe(false);
      await act(async () => button("Send it again").click());
      expect(startReturn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(vi.mocked(startReturn).mock.calls[1])).toBe(
        original
      );
      expect(getLoan).toHaveBeenCalledTimes(lateRead ? 5 : 3);
      expect(host.querySelector("h1")?.textContent).toBe(
        "Your Loan from Misty ended"
      );
      expect(host.textContent).toContain("3 returned");
      expect(button("Send it again")).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
}

for (const closePath of [
  "Close",
  "header",
  "Escape",
  "scrim",
  "cancel",
  "native close",
  "navigation",
] as const) {
  it(`keeps unknown terms authoritative through ${closePath}, then replays exact bytes`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      1000
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      1000
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 10, 30, 30)
    );
    window.history.replaceState(null, "", "/loans/item");
    const prototype = HTMLDialogElement.prototype;
    const descriptors = ["showModal", "close"].map((name) =>
      Object.getOwnPropertyDescriptor(prototype, name)
    );
    Object.defineProperty(prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    });
    const current: LoanView = {
      ...loan,
      state: "requested",
      closed_reason: null,
      closed_by: null,
      actions: ["edit_and_resend"],
      lines: [{ ...loan.lines[0], requested: "3" }],
    };
    vi.mocked(getLoan).mockResolvedValue(current);
    vi.mocked(getLoanSide).mockResolvedValue({
      loan_id: "round",
      deck: null,
      can_promise: [],
      picks: [],
      suggested: [],
    });
    let lose!: (cause: Error) => void;
    vi.mocked(editLoanTerms)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          lose = reject;
        })
      )
      .mockResolvedValueOnce({ ...current, revision: 3 });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === name
      )!;
    function View() {
      const route = useRoute();
      return h(
        "div",
        null,
        h(
          "button",
          { onClick: () => route.navigate("/collection") },
          "Navigate away"
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
      await act(async () => root.render(h(View)));
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="More for this Loan"]'
          )!
          .click()
      );
      await act(async () => button("Change terms").click());
      await act(async () => button("Save terms").click());
      const first = JSON.stringify(vi.mocked(editLoanTerms).mock.calls[0]);
      expect(JSON.parse(first)[1].account_id).toBe("A");
      expect(
        [...screenData.keys()].filter((key) =>
          key.startsWith("prizecheck:loan-intent:v2:")
        )
      ).toEqual([]);
      expect(JSON.parse(first)[1].lines).toEqual([
        { edition_id: "iono", quantity: "3" },
      ]);
      const dismiss = () => {
        const dialog = host.querySelector("dialog")!;
        switch (closePath) {
          case "Close":
            button("Close").click();
            break;
          case "header":
            dialog
              .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
              .click();
            break;
          case "Escape":
            dialog.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
            );
            break;
          case "scrim":
            dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
            dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            break;
          case "cancel":
            dialog.dispatchEvent(
              new Event("cancel", { bubbles: true, cancelable: true })
            );
            break;
          case "native close":
            dialog.open = false;
            dialog.dispatchEvent(new Event("close", { bubbles: true }));
            break;
          case "navigation":
            button("Navigate away").click();
            break;
        }
      };
      for (const lost of [false, true]) {
        if (lost)
          await act(async () =>
            lose(new TypeError("response lost, original may still execute"))
          );
        await act(async () => dismiss());
        expect(host.querySelector("dialog")?.open).toBe(true);
        expect(window.location.pathname).toBe("/loans/item");
        expect(
          host.querySelector<HTMLInputElement>('input[type="number"]')?.disabled
        ).toBe(true);
        expect(editLoanTerms).toHaveBeenCalledTimes(1);
        expect(
          [...screenData.keys()].filter((key) =>
            key.startsWith("prizecheck:loan-intent:v2:")
          )
        ).toEqual([]);
      }
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(false);
      await act(async () => button("Retry request").click());
      expect(editLoanTerms).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(vi.mocked(editLoanTerms).mock.calls[1])).toBe(
        first
      );
      expect(host.querySelector("dialog")).toBeNull();
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(true);
      await act(async () => button("Navigate away").click());
      expect(window.location.pathname).toBe("/collection");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      for (const [i, name] of ["showModal", "close"].entries()) {
        const descriptor = descriptors[i];
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
        else Reflect.deleteProperty(prototype, name);
      }
      vi.unstubAllGlobals();
      vi.clearAllMocks();
      vi.restoreAllMocks();
    }
  });
}

it("closing terms cancels a delayed preflight before a parent can commit the close", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const prototype = HTMLDialogElement.prototype;
  const descriptors = ["showModal", "close"].map((name) =>
    Object.getOwnPropertyDescriptor(prototype, name)
  );
  Object.defineProperty(prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const current: LoanView = {
    ...loan,
    state: "requested",
    closed_reason: null,
    actions: ["edit_and_resend"],
  };
  let deliver!: (value: LoanView) => void;
  vi.mocked(getLoan)
    .mockReset()
    .mockResolvedValueOnce(current)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        deliver = resolve;
      })
    );
  const save = vi.fn(async (): Promise<"applied"> => "applied"),
    closed = vi.fn();
  vi.mocked(editLoanTerms).mockReset();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () =>
      root.render(
        h(LoanTermsEditor, {
          loan: current,
          deckId: null,
          onSave: save,
          onClose: closed,
          canClose: () => true,
          pending: false,
          commandMessage: "",
          pendingRequest: null,
        })
      )
    );
    await act(async () => button("Save terms").click());
    // The parent has received close intent, but its render has not committed yet.
    await act(async () => {
      button("Close").click();
      deliver(current);
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(editLoanTerms).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [i, name] of ["showModal", "close"].entries()) {
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("one Loan authority owns both its retained packet and its in-flight attempt before render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  window.history.replaceState(null, "", "/loans/item");
  type Packet = { body: string; key: string };
  let owner!: ReturnType<typeof useLoanCommand<Packet>>;
  let navigate!: () => void;
  function View() {
    owner = useLoanCommand<Packet>();
    const route = useRoute();
    navigate = () => route.navigate("/collection");
    return h("p", null, owner.pending ? "Retry" : "Ready");
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const first = { body: "3 copies", key: "retained" };
  try {
    await act(async () => root.render(h(View)));
    await act(async () => {
      expect(owner.beginAttempt()).toBe(true);
      expect(owner.retain(first)).toBe(first);
      expect(owner.beginAttempt()).toBe(false);
      expect(owner.retain({ body: "2 copies", key: "different" })).toBe(first);
      navigate();
      expect(window.location.pathname).toBe("/loans/item");
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(false);
      owner.endAttempt();
    });
    expect(owner.pending).toBe(true);
    await act(async () => {
      expect(owner.beginAttempt()).toBe(true);
      expect(owner.command.current).toBe(first);
      owner.settle();
      owner.endAttempt();
    });
    expect(owner.pending).toBe(false);
    await act(async () => navigate());
    expect(window.location.pathname).toBe("/collection");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("a lost write-off owns its round, hides other commands, keeps chat and replays exact bytes", async () => {
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
  packets = [];
  keepReadView = false;
  const active: LoanView = {
    ...loan,
    thread_id: threadId,
    role: "lender",
    state: "handed_over",
    closed_reason: null,
    closed_by: null,
    lines: [{ ...loan.lines[0], requested: "3", promised: "3" }],
    actions: ["write_off", "start_return", "change_return_by"],
    revision: 4,
    section: "out_now",
  };
  vi.mocked(getLoan).mockResolvedValue(active);
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [],
    picks: [],
    suggested: [],
  });
  vi.mocked(writeOff)
    .mockRejectedValueOnce(new TypeError("lost answer"))
    .mockResolvedValueOnce({
      ...active,
      revision: 5,
      lines: [{ ...active.lines[0], written_off: "1" }],
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  try {
    await act(async () =>
      root.render(
        h(LoanScreen, {
          loanId: threadId,
          onCanonicalLoan: vi.fn(),
          onLoanChanged: vi.fn(),
          onAllLoans: vi.fn(),
          onOpenDeck: vi.fn(),
        })
      )
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="More for this Loan"]')!
        .click()
    );
    await act(async () => button("Write off…").click());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="Increase Copies of Iono"]'
        )!
        .click()
    );
    await act(async () => button("Write off").click());
    expect(writeOff).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.objectContaining({
        account_id: "A",
        loan_id: "round",
        revision: 4,
        lines: [{ edition_id: "iono", quantity: "1" }],
      })
    );
    expect(host.querySelector('[aria-label="More for this Loan"]')).toBeNull();
    expect(button("Keep it").matches(":disabled")).toBe(true);
    expect(button("Chat moderation completed").matches(":disabled")).toBe(
      false
    );
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
    ).toBe(true);
    await act(async () => button("Send it again").click());
    expect(writeOff).toHaveBeenCalledTimes(2);
    expect(packets[1]).toBe(packets[0]);
    expect(host.textContent).toContain("1 written off");
    expect(button("Send it again")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  }
});

async function termsHarness(
  run: (
    host: HTMLDivElement,
    button: (name: string) => HTMLButtonElement
  ) => Promise<void>,
  screen = false
) {
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
  const prototype = HTMLDialogElement.prototype;
  const descriptors = ["showModal", "close"].map((name) =>
    Object.getOwnPropertyDescriptor(prototype, name)
  );
  Object.defineProperty(prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const current: LoanView = {
    ...loan,
    state: "requested",
    closed_reason: null,
    closed_by: null,
    actions: ["edit_and_resend"],
  };
  vi.mocked(getLoan).mockReset().mockResolvedValue(current);
  vi.mocked(getLoanSide).mockResolvedValue({
    loan_id: "round",
    deck: null,
    can_promise: [],
    picks: [],
    suggested: [],
  });
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () =>
      root.render(
        screen
          ? h(LoanScreen, {
              loanId: "item",
              onCanonicalLoan: vi.fn(),
              onLoanChanged: vi.fn(),
              onAllLoans: vi.fn(),
              onOpenDeck: vi.fn(),
            })
          : h(LoanTermsEditor, {
              loan: current,
              deckId: null,
              onClose: vi.fn(),
              onSave: vi.fn(),
              canClose: () => true,
              pending: false,
              commandMessage: "",
              pendingRequest: null,
            })
      )
    );
    if (screen) {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="More for this Loan"]'
          )!
          .click()
      );
      await act(async () => button("Change terms").click());
    }
    await run(host, button);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [i, name] of ["showModal", "close"].entries()) {
      if (descriptors[i])
        Object.defineProperty(prototype, name, descriptors[i]!);
      else Reflect.deleteProperty(prototype, name);
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  }
}
it("a Terms check that fails shows Retry check beside a seen change", async () => {
  await termsHarness(async (host, button) => {
    vi.mocked(getLoan).mockResolvedValueOnce({ ...loan, revision: 9 });
    await act(async () => button("Save terms").click());
    expect(host.textContent).toContain(
      "This Loan changed. Close this editor to view the current terms."
    );
    vi.mocked(getLoan).mockRejectedValueOnce(new TypeError("lost read"));
    await act(async () => button("Retry check").click());
    expect(host.textContent).toContain(
      "This Loan changed. Close this editor to view the current terms."
    );
    expect(host.textContent).toContain(
      "The Loan could not be checked. Your changes are kept. Retry the check."
    );
    expect(button("Save terms").disabled).toBe(true);
    expect(button("Retry check")).toBeDefined();
    expect(editLoanTerms).not.toHaveBeenCalled();
  });
});
it("ACCOUNT_CHANGED on Terms says who to sign in as and the Terms body carries the account", async () => {
  vi.mocked(editLoanTerms)
    .mockReset()
    .mockRejectedValueOnce(new SocialError(409, "ACCOUNT_CHANGED"));
  await termsHarness(async (host, button) => {
    await act(async () => button("Save terms").click());
    expect(editLoanTerms).toHaveBeenCalledExactlyOnceWith(
      "item",
      expect.objectContaining({
        account_id: "A",
        loan_id: "round",
        revision: 2,
      })
    );
    expect(host.textContent).toContain("Sign in as Ana to finish this.");
    expect(
      [...screenData.keys()].filter((key) =>
        key.startsWith("prizecheck:loan-intent:v2:")
      )
    ).toEqual([]);
  }, true);
});
