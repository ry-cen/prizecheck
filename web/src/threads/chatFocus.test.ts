// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";
import {
  SocialError,
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
        vi.mocked(sendThreadMessage).mockRejectedValue(
          new SocialError(429, "MESSAGE_RATE_LIMITED")
        );
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
          ).toBe(false);
          const keys = vi.spyOn(crypto, "randomUUID");
          await act(async () =>
            host
              .querySelector("form")!
              .dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true })
              )
          );
          expect(sendThreadMessage).not.toHaveBeenCalled();
          expect(keys).not.toHaveBeenCalled();
          expect(
            host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly
          ).toBe(true);
          expect(host.querySelector('button[type="submit"]')?.textContent).toBe(
            "Sending…"
          );
          // A second click/Enter cannot create another held body.
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
            expect(sendThreadMessage).not.toHaveBeenCalled();
            expect(keys).not.toHaveBeenCalled();
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
              expect(sendThreadMessage).not.toHaveBeenCalled();
              expect(keys).not.toHaveBeenCalled();
              expect(editor.readOnly).toBe(false);
              expect(host.textContent).toContain("Chat couldn't be checked.");
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
              expect(sendThreadMessage).not.toHaveBeenCalled();
            }
            expect(
              host.querySelector<HTMLButtonElement>('button[type="submit"]')!
                .disabled
            ).toBe(false);
            if (outcome === "failed")
              await act(async () =>
                host
                  .querySelector("form")!
                  .dispatchEvent(
                    new Event("submit", { bubbles: true, cancelable: true })
                  )
              );
            expect(keys).toHaveBeenCalledTimes(1);
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
          vi.restoreAllMocks();
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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mountedChat(kind: "trade" | "loan") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pulse.changed = 0;
  vi.mocked(getThreadDetail).mockResolvedValue(detail(kind, true));
  vi.mocked(getThreadTimeline).mockResolvedValue({
    you_are: "low",
    items: [],
    next_before: null,
  });
  vi.mocked(sendThreadMessage).mockRejectedValue(
    new SocialError(429, "MESSAGE_RATE_LIMITED")
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let revision = 0;
  const render = (id = "item") =>
    act(async () =>
      root.render(h(ThreadTimeline, { kind, id, revision: String(revision) }))
    );
  await render();
  const keys = vi.spyOn(crypto, "randomUUID");
  return {
    host,
    keys,
    async edit(body = "A held draft") {
      await act(async () => {
        const editor = host.querySelector("textarea")!;
        editor.focus();
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(editor, body);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    async press() {
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      );
    },
    async recheck() {
      const read = deferred<TradeDetail | LoanDetail>();
      vi.mocked(getThreadDetail).mockReturnValueOnce(read.promise);
      revision++;
      await render();
      return read;
    },
    changeThread: () => render("another-item"),
    async close() {
      await act(async () => root.unmount());
    },
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      vi.clearAllMocks();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

for (const kind of ["trade", "loan"] as const) {
  for (const outcome of ["writable", "readonly", "failed"] as const)
    for (const order of ["old-first", "new-first"] as const)
      it(`holds one ${kind} send for only the newest permission read (${outcome}, ${order})`, async () => {
        const chat = await mountedChat(kind);
        try {
          await chat.edit();
          const old = await chat.recheck();
          await chat.press();
          const newest = await chat.recheck();
          const settleNewest = () =>
            act(async () => {
              if (outcome === "failed")
                newest.reject(new TypeError("lost newest read"));
              else newest.resolve(detail(kind, outcome === "writable"));
            });
          if (order === "old-first") {
            await act(async () => old.resolve(detail(kind, true)));
            expect(sendThreadMessage).not.toHaveBeenCalled();
            expect(chat.keys).not.toHaveBeenCalled();
            expect(
              chat.host.querySelector('button[type="submit"]')?.textContent
            ).toBe("Sending…");
            await settleNewest();
          } else {
            await settleNewest();
            await act(async () => old.resolve(detail(kind, true)));
          }
          expect(sendThreadMessage).toHaveBeenCalledTimes(
            outcome === "writable" ? 1 : 0
          );
          expect(chat.keys).toHaveBeenCalledTimes(
            outcome === "writable" ? 1 : 0
          );
          if (outcome === "writable")
            expect(sendThreadMessage).toHaveBeenLastCalledWith(
              kind,
              "item",
              expect.objectContaining({ body: "A held draft" })
            );
          if (outcome === "readonly") {
            expect(chat.host.querySelector("textarea")).toBeNull();
            expect(document.activeElement).toBe(chat.host.querySelector("h2"));
          }
          if (outcome === "failed") {
            expect(chat.host.querySelector("textarea")?.value).toBe(
              "A held draft"
            );
            expect(chat.host.textContent).toContain(
              "Chat couldn't be checked."
            );
            const retry = [...chat.host.querySelectorAll("button")].find(
              (b) => b.textContent === "Retry"
            )!;
            await act(async () => retry.click());
            expect(sendThreadMessage).not.toHaveBeenCalled();
            await chat.press();
            expect(sendThreadMessage).toHaveBeenCalledExactlyOnceWith(
              kind,
              "item",
              expect.objectContaining({ body: "A held draft" })
            );
          }
        } finally {
          await chat.cleanup();
        }
      });
  for (const leave of ["unmount", "thread-change"] as const)
    it(`drops a held ${kind} send without a key or POST on ${leave}`, async () => {
      const chat = await mountedChat(kind);
      try {
        await chat.edit();
        const read = await chat.recheck();
        await chat.press();
        if (leave === "unmount") await chat.close();
        else await chat.changeThread();
        await act(async () => read.resolve(detail(kind, true)));
        expect(sendThreadMessage).not.toHaveBeenCalled();
        expect(chat.keys).not.toHaveBeenCalled();
        if (leave === "thread-change")
          expect(chat.host.querySelector("textarea")?.value).toBe("");
      } finally {
        await chat.cleanup();
      }
    });
  for (const writable of [true, false])
    it(`holds ${kind} unknown-message replay without replacing its body/key (writable=${writable})`, async () => {
      const chat = await mountedChat(kind);
      try {
        const post = deferred<Awaited<ReturnType<typeof sendThreadMessage>>>();
        vi.mocked(sendThreadMessage).mockReturnValueOnce(post.promise);
        await chat.edit("Exactly this message");
        await chat.press();
        const original = JSON.stringify(
          vi.mocked(sendThreadMessage).mock.calls[0]
        );
        const old = await chat.recheck();
        await chat.press(); // A POST already in flight cannot become a second hold.
        expect(sendThreadMessage).toHaveBeenCalledTimes(1);
        await act(async () => post.reject(new TypeError("lost POST")));
        await chat.press();
        const newest = await chat.recheck();
        await act(async () => old.resolve(detail(kind, true)));
        expect(sendThreadMessage).toHaveBeenCalledTimes(1);
        expect(chat.keys).toHaveBeenCalledTimes(1);
        await act(async () => newest.resolve(detail(kind, writable)));
        if (!writable) {
          expect(sendThreadMessage).toHaveBeenCalledTimes(1);
          expect(
            chat.host.querySelector('button[type="submit"]')?.textContent
          ).toBe("Retry");
          await chat.press(); // Explicit replay remains possible after a read-only observation.
        }
        expect(sendThreadMessage).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(vi.mocked(sendThreadMessage).mock.calls[1])).toBe(
          original
        );
        expect(chat.keys).toHaveBeenCalledTimes(1);
      } finally {
        await chat.cleanup();
      }
    });
}

for (const kind of ["trade", "loan"] as const)
  it(`cannot hold or POST a ${kind} message before the first permission is known`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pulse.changed = 0;
    const read = deferred<TradeDetail | LoanDetail>();
    vi.mocked(getThreadDetail).mockReturnValueOnce(read.promise);
    vi.mocked(getThreadTimeline).mockResolvedValue({
      you_are: "low",
      items: [],
      next_before: null,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const keys = vi.spyOn(crypto, "randomUUID");
    try {
      await act(async () =>
        root.render(h(ThreadTimeline, { kind, id: "item" }))
      );
      expect(host.querySelector('button[type="submit"]')).toBeNull();
      expect(host.querySelector("textarea")).toBeNull();
      expect(sendThreadMessage).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
      await act(async () => read.resolve(detail(kind, true)));
      expect(
        host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
      ).toBe(true);
      expect(sendThreadMessage).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.clearAllMocks();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
