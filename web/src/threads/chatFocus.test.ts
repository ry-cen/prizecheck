// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";
import {
  getThreadDetail,
  getThreadTimeline,
  sendThreadMessage,
  type LoanView,
  type TradeView,
  type LoanDetail,
  type TradeDetail,
} from "../social_generated";
const pulse = vi.hoisted(() => ({ changed: 0 }));
vi.mock("../inbox/Inbox", () => ({
  usePulseChanged: () => pulse.changed,
  usePollPulse: () => () => {},
  useConversationOpen: () => {},
}));
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getThreadDetail: vi.fn(),
  getThreadTimeline: vi.fn(),
  sendThreadMessage: vi.fn(),
}));
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "item",
  kind: "borrow_request",
  state: "requested",
  closed_reason: null,
  closed_by: null,
  role: "lender",
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
  needs_you: true,
  section: "needs_you",
  actions: ["accept", "decline"],
  revision: 1,
  waiting: "answer",
};
const trade: TradeView = {
  id: "round",
  thread_id: "item",
  offer_id: "round",
  revision: 1,
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    display_name: "Misty",
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [],
  you_get: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea Evolved",
      collector_number: "185",
      descriptor: {},
      image_url: null,
      copies: "1",
    },
  ],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["accept", "decline"],
  created_at: "2026-11-04T00:00:00Z",
};

function detail(
  kind: "trade" | "loan",
  writable: boolean
): TradeDetail | LoanDetail {
  const common = { id: "item", can_message: writable, can_report: false };
  return kind === "trade"
    ? { ...common, live_offer: trade }
    : {
        ...common,
        live_terms: loan,
        other: {
          trader_id: null,
          display_name: "Misty",
          friend: true,
          available: writable,
        },
      };
}
for (const kind of ["trade", "loan"] as const)
  for (const signal of ["pulse", "revision"] as const)
    for (const outcome of ["writable", "readonly", "failed"] as const) {
      it(`S2-07: ${kind} keeps the focused draft through a ${signal} permission read (${outcome})`, async () => {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        pulse.changed = 0;
        vi.mocked(getThreadDetail).mockResolvedValue(detail(kind, true));
        vi.mocked(getThreadTimeline).mockResolvedValue({
          you_are: "low",
          items: [],
          next_before: null,
        });
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
          await act(async () =>
            root.render(
              h(ThreadTimeline, { kind, id: "item", revision: "one" })
            )
          );
          const editor = host.querySelector("textarea")!;
          await act(async () => {
            editor.focus();
            Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value"
            )!.set!.call(editor, "A held draft");
            editor.dispatchEvent(new Event("input", { bubbles: true }));
          });
          let resolve!: (value: TradeDetail | LoanDetail) => void,
            reject!: (cause: unknown) => void;
          vi.mocked(getThreadDetail).mockReturnValueOnce(
            new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            })
          );
          if (signal === "pulse") pulse.changed++;
          await act(async () =>
            root.render(
              h(ThreadTimeline, {
                kind,
                id: "item",
                revision: signal === "revision" ? "two" : "one",
              })
            )
          );
          expect(host.querySelector("textarea")).toBe(editor);
          expect(document.activeElement).toBe(editor);
          expect(editor.value).toBe("A held draft");
          expect(
            host.querySelector<HTMLButtonElement>('button[type="submit"]')!
              .disabled
          ).toBe(true);
          await act(async () =>
            host
              .querySelector("form")!
              .dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true })
              )
          );
          expect(sendThreadMessage).not.toHaveBeenCalled();
          await act(async () => {
            if (outcome === "failed") reject(new TypeError("lost read"));
            else resolve(detail(kind, outcome === "writable"));
          });
          if (outcome === "readonly") {
            expect(host.querySelector("textarea")).toBeNull();
            expect(document.activeElement).toBe(host.querySelector("h2"));
            expect(host.textContent).toContain(
              "This collector is no longer available"
            );
          } else {
            expect(host.querySelector("textarea")).toBe(editor);
            expect(document.activeElement).toBe(editor);
            expect(editor.value).toBe("A held draft");
            if (outcome === "failed") {
              expect(
                host.querySelector<HTMLButtonElement>('button[type="submit"]')!
                  .disabled
              ).toBe(true);
              const retry = [...host.querySelectorAll("button")].find(
                (b) => b.textContent === "Retry"
              )!;
              expect(retry).toBeDefined();
              await act(async () => retry.click());
              expect(host.querySelector("textarea")).toBe(editor);
            }
            expect(
              host.querySelector<HTMLButtonElement>('button[type="submit"]')!
                .disabled
            ).toBe(false);
            await act(async () =>
              host
                .querySelector("form")!
                .dispatchEvent(
                  new Event("submit", { bubbles: true, cancelable: true })
                )
            );
            expect(sendThreadMessage).toHaveBeenCalledExactlyOnceWith(
              kind,
              "item",
              expect.objectContaining({ body: "A held draft" })
            );
          }
        } finally {
          await act(async () => root.unmount());
          host.remove();
          vi.clearAllMocks();
          vi.unstubAllGlobals();
        }
      });
    }

for (const kind of ["loan", "trade"] as const) {
  it(`S2-07: a late read-only ${kind} reply cannot remove exact message replay`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pulse.changed = 0;
    vi.mocked(getThreadDetail).mockResolvedValue(detail(kind, true));
    vi.mocked(getThreadTimeline).mockResolvedValue({
      you_are: "low",
      items: [],
      next_before: null,
    });
    let lose!: (cause: unknown) => void;
    vi.mocked(sendThreadMessage).mockReturnValueOnce(
      new Promise((_yes, no) => {
        lose = no;
      })
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(h(ThreadTimeline, { kind, id: "item", revision: "one" }))
      );
      const editor = host.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(editor, "Exactly this message");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      );
      const first = JSON.stringify(vi.mocked(sendThreadMessage).mock.calls[0]);
      vi.mocked(getThreadDetail).mockResolvedValue(detail(kind, false));
      await act(async () =>
        root.render(h(ThreadTimeline, { kind, id: "item", revision: "two" }))
      );
      expect(host.querySelector("textarea")).toBe(editor);
      await act(async () => lose(new TypeError("lost POST")));
      const retry = host.querySelector<HTMLButtonElement>(
        'button[type="submit"]'
      )!;
      expect(retry.textContent).toBe("Retry");
      expect(retry.disabled).toBe(false);
      expect(editor.disabled).toBe(true);
      retry.focus();
      await act(async () => retry.click());
      expect(JSON.stringify(vi.mocked(sendThreadMessage).mock.calls[1])).toBe(
        first
      );
      expect(host.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(host.querySelector("h2"));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    }
  });
}
