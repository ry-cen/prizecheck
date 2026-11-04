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
