// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  InboxProvider,
  useNoteLoansChanged,
  useThreadCounts,
} from "../inbox/Inbox";
import { ThreadList } from "./ThreadList";
import {
  getTrades,
  getInbox,
  getThreadPulse,
  getDiscovery,
  type ThreadItem,
} from "../social_generated";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrades: vi.fn(),
  getInbox: vi.fn(),
  getThreadPulse: vi.fn(),
  getDiscovery: vi.fn(),
}));
function row(id: string, waiting: boolean, unread: boolean): ThreadItem {
  return {
    id,
    kind: "trade",
    other: {
      trader_id: `public-${id}`,
      display_name: id,
      friend: false,
      available: true,
    },
    you_are: "low",
    summary: { cards: [], you_give: "1", you_get: "1" },
    section: "needs_you",
    state: waiting ? "agreed" : "closed",
    waiting: waiting ? "confirm_swap" : null,
    unread: unread ? 1 : 0,
    needs_you: true,
    last_activity_at: "2026-11-04T12:00:00Z",
  };
}
for (const overlap of [false, true]) {
  it(`S2-04: Friend changes refresh the exact item union and both badges without a timer or focus (overlap=${overlap})`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let changed = false;
    const before = {
      trades: { needs_you: 4, waiting: 3, unread: 1 },
      loans: { needs_you: 2, waiting: 2, unread: 0 },
      watermark: "before",
    };
    const after = {
      trades: overlap
        ? { needs_you: 3, waiting: 2, unread: 2 }
        : { needs_you: 1, waiting: 1, unread: 0 },
      loans: { needs_you: 1, waiting: 0, unread: 1 },
      watermark: "after",
    };
    vi.mocked(getInbox).mockResolvedValue({
      waiting: [],
      updates: [],
      trade_waiting: [],
      trade_updates: [],
    });
    vi.mocked(getDiscovery).mockResolvedValue({
      status: "off",
      zip: null,
      radius_mi: 5,
      zip_changes_left: 3,
      visible_beyond_friends: true,
    });
    vi.mocked(getThreadPulse).mockImplementation(async () =>
      changed ? after : before
    );
    vi.mocked(getTrades).mockImplementation(async () =>
      changed
        ? overlap
          ? [
              row("Ash", true, true),
              row("Brock", true, false),
              row("Misty", false, true),
            ]
          : [row("Ash", true, false)]
        : [
            row("Ash", true, false),
            row("Brock", true, false),
            row("Erika", true, false),
            row("Misty", false, true),
          ]
    );
    function View() {
      const notify = useNoteLoansChanged(),
        counts = useThreadCounts();
      return h(
        "div",
        null,
        h(
          "button",
          {
            onClick: () => {
              changed = true;
              notify();
            },
          },
          "Friend changed"
        ),
        h("pre", { "data-counts": true }, JSON.stringify(counts)),
        h(ThreadList, { kind: "trade", active: true, onOpen: vi.fn() })
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(InboxProvider, {
            onOpenLoan: vi.fn(),
            onOpenTrade: vi.fn(),
            children: h(View),
          })
        )
      );
      expect(host.querySelectorAll("a[data-thread]")).toHaveLength(4);
      expect(
        JSON.parse(host.querySelector("[data-counts]")!.textContent!)
      ).toEqual({ trades: before.trades, loans: before.loans });
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Friend changed")!
          .click()
      );
      expect(host.querySelectorAll("a[data-thread]")).toHaveLength(
        after.trades.needs_you
      );
      expect(
        JSON.parse(host.querySelector("[data-counts]")!.textContent!)
      ).toEqual({ trades: after.trades, loans: after.loans });
      expect(getThreadPulse).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
}
