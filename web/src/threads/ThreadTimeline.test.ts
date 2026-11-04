// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  SocialError,
  sendThreadMessage,
  getThreadTimeline,
} from "../social_generated";
import { ThreadTimeline } from "./ThreadTimeline";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getThreadDetail: vi.fn(async () => ({
    can_message: true,
    live_offer: { other: { display_name: "Misty" } },
  })),
  getThreadTimeline: vi.fn(async () => ({
    you_are: "low",
    items: [],
    next_before: null,
  })),
  sendThreadMessage: vi.fn(),
  readThread: vi.fn(async () => ({ read: false })),
}));
it.each([
  [
    "MESSAGE_RATE_LIMITED",
    "You're sending messages quickly. Try again in a few minutes.",
  ],
  ["MESSAGE_TOO_LONG", "Messages can be up to 1,000 characters."],
])(
  "keeps the draft and states the actionable %s refusal",
  async (code, text) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(sendThreadMessage).mockRejectedValue(new SocialError(429, code));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(h(ThreadTimeline, { kind: "trade", id: "item" }))
      );
      const field = host.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(field, "One more");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      );
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
      expect(field.value).toBe("One more");
      expect(field.disabled).toBe(false);
      expect(sendThreadMessage).toHaveBeenLastCalledWith(
        "trade",
        "item",
        expect.objectContaining({ body: "One more" })
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  }
);
it("reads a known command's new timeline without needing a pulse change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getThreadTimeline)
    .mockResolvedValueOnce({ you_are: "low", items: [], next_before: null })
    .mockResolvedValueOnce({
      you_are: "low",
      items: [
        {
          kind: "event",
          at: "2026-11-04T10:00:00Z",
          cursor: "new",
          event: {
            id: "event",
            round_id: "offer",
            actor: null,
            at: "2026-11-04T10:00:00Z",
            kind: "accepted",
          },
        },
      ],
      next_before: null,
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadTimeline, { kind: "trade", id: "item", revision: "offer:1" })
      )
    );
    expect(host.querySelectorAll("ol li")).toHaveLength(0);
    await act(async () =>
      root.render(
        h(ThreadTimeline, { kind: "trade", id: "item", revision: "offer:2" })
      )
    );
    expect(getThreadTimeline).toHaveBeenCalledTimes(2);
    expect(host.querySelector("ol")?.textContent).toBe("Agreed");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("S2-03: removed Editions and same-name variants keep public identities across earlier pages and live-offer changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const at = "2026-11-04T12:00:00Z",
    old = "2026-11-03T12:00:00Z";
  vi.mocked(getThreadTimeline)
    .mockResolvedValueOnce({
      you_are: "low",
      items: [
        {
          kind: "event",
          at,
          cursor: "latest",
          event: {
            id: "latest-event",
            round_id: "private-round",
            actor: "high",
            kind: "countered",
            at,
            data: {
              lines: [
                { giver: "high", edition_id: "arven", from_qty: 0, to_qty: 1 },
              ],
            },
            editions: [
              {
                edition_id: "arven",
                name: "Arven",
                set_code: "SVI",
                collector_number: "166",
                descriptor: { finish: "normal", productId: "source-only" },
              },
            ],
          },
        },
      ],
      next_before: "earlier",
    })
    .mockResolvedValueOnce({
      you_are: "low",
      items: [
        {
          kind: "event",
          at: old,
          cursor: "old",
          event: {
            id: "old-event",
            round_id: "private-round",
            actor: "high",
            kind: "countered",
            at: old,
            data: {
              lines: [
                {
                  giver: "high",
                  edition_id: "removed-edition",
                  from_qty: 1,
                  to_qty: 0,
                },
                {
                  giver: "high",
                  edition_id: "different-edition",
                  from_qty: 0,
                  to_qty: 1,
                },
              ],
            },
            editions: [
              {
                edition_id: "removed-edition",
                name: "Iono",
                set_code: "PAL",
                collector_number: "185",
                descriptor: { finish: "normal", productId: "source-only" },
              },
              {
                edition_id: "different-edition",
                name: "Iono",
                set_code: "PAL",
                collector_number: "254",
                descriptor: { finish: "reverse" },
              },
            ],
          },
        },
      ],
      next_before: null,
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadTimeline, {
          kind: "trade",
          id: "item",
          editionNames: { arven: "Arven" },
        })
      )
    );

    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Show earlier")!
        .click()
    );
    expect(getThreadTimeline).toHaveBeenLastCalledWith(
      "trade",
      "item",
      "earlier"
    );
    const labels = host.querySelector("ol")?.textContent;
    expect(labels).toContain("They give Iono (PAL 185): 1 → 0");
    expect(labels).toContain("They give Arven (SVI 166): 0 → 1");
    expect(labels).toContain("They give Iono (PAL 254, Reverse Holo): 0 → 1");
    await act(async () =>
      root.render(
        h(ThreadTimeline, { kind: "trade", id: "item", editionNames: {} })
      )
    );
    expect(host.querySelector("ol")?.textContent).toBe(labels);
    for (const id of [
      "removed-edition",
      "different-edition",
      "private-round",
      "source-only",
    ])
      expect(labels).not.toContain(id);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("keeps an oversized pasted draft intact for explicit validation without posting a truncated message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(ThreadTimeline, { kind: "trade", id: "item" }))
    );
    const field = host.querySelector("textarea")!;
    expect(field.maxLength < 0 || field.maxLength >= 4001).toBe(true);
    const oversized = "é".repeat(4001);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(field, oversized);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(field.value).toBe(oversized);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Messages can be up to 1,000 characters."
    );
    expect(sendThreadMessage).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }
});
