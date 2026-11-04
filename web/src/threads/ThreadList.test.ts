// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getLoans, readThread, type ThreadItem } from "../social_generated";
import { ThreadList } from "./ThreadList";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoans: vi.fn(),
  readThread: vi.fn(),
}));
it("keeps a successful empty list quiet after a failed return read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoans)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("offline"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { kind: "loan" as const, active: true, onOpen: vi.fn() };
  try {
    await act(async () => root.render(h(ThreadList, props)));
    expect(host.textContent).toContain("No Loans yet.");
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(getLoans).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
it("exposes Retry on a failed first load and recovers without a reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoans)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadList, { kind: "loan", active: true, onOpen: vi.fn() })
      )
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Your Loans couldn't be loaded."
    );
    const retry = host.querySelector("button")!;
    expect(retry.textContent).toBe("Retry");
    await act(async () => retry.click());
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
it("reuses a quiet read still in flight across another hide and show", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: (rows: []) => void;
  const held = new Promise<[]>((resolve) => {
    release = resolve;
  });
  vi.mocked(getLoans)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(held)
    .mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { kind: "loan" as const, active: true, onOpen: vi.fn() };
  try {
    await act(async () => root.render(h(ThreadList, props)));
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(getLoans).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(getLoans).mock.calls[1][0]!;
    await act(async () =>
      root.render(h(ThreadList, { ...props, active: false }))
    );
    await act(async () => root.render(h(ThreadList, props)));
    expect(signal.aborted).toBe(false);
    expect(getLoans).toHaveBeenCalledTimes(2);
    await act(async () => release([]));
    expect(host.textContent).toContain("No Loans yet.");
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    release([]);
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

for (const state of ["active", "closed", "blocked"] as const) {
  it(`S2-16: ${state} item previews its own latest message as plain text without marking it read`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const row: ThreadItem = {
      id: "item",
      kind: "loan",
      other: {
        trader_id: "public-trader",
        display_name: "Misty",
        friend: state === "active",
        available: state !== "blocked",
      },
      you_are: "low",
      summary: { you_give: "0", you_get: "1", cards: [] },
      section: "needs_you",
      state: state === "active" ? "accepted" : "closed",
      waiting: null,
      needs_you: true,
      unread: 1,
      last_activity_at: "2026-11-04T12:00:00Z",
      latest: {
        kind: "message",
        at: "2026-11-04T12:00:00Z",
        cursor: "private-cursor",
        message: {
          id: "private-message",
          from: "them",
          body: 'Hi Ash! <img src=x onerror="secret()">',
          at: "2026-11-04T12:00:00Z",
        },
      },
    };
    vi.mocked(getLoans).mockResolvedValue([row]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host),
      open = vi.fn();
    try {
      await act(async () =>
        root.render(h(ThreadList, { kind: "loan", active: true, onOpen: open }))
      );
      const link = host.querySelector('a[data-thread="item"]')!;
      expect(link.textContent).toContain(
        'Misty: Hi Ash! <img src=x onerror="secret()">'
      );
      expect(link.querySelector("img")).toBeNull();
      expect(link.textContent).toContain("New messages");
      for (const secret of [
        "private-cursor",
        "private-message",
        "public-trader",
      ])
        expect(link.textContent).not.toContain(secret);
      expect(open).not.toHaveBeenCalled();
      expect(readThread).not.toHaveBeenCalled();
      expect(getLoans).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
}
it("S2-16: an item's latest log summary projects only public terms and its participant slot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = {
    lines: [
      {
        giver: "high" as const,
        edition_id: "private-edition",
        from_qty: 1,
        to_qty: 2,
      },
    ],
    location_id: "private-location",
    deck_name: "Secret Deck",
    reason: "closed_blocked",
  };
  const row: ThreadItem = {
    id: "item",
    kind: "loan",
    other: {
      trader_id: "public-trader",
      display_name: "Misty",
      friend: false,
      available: false,
    },
    you_are: "low",
    summary: {
      you_give: "0",
      you_get: "2",
      cards: [
        {
          edition_id: "private-edition",
          name: "Iono",
          image_url: null,
          copies: "2",
          side: "you_get",
        },
      ],
    },
    section: "done",
    state: "closed",
    waiting: null,
    needs_you: false,
    unread: 0,
    last_activity_at: "2026-11-04T12:00:00Z",
    latest: {
      kind: "event",
      at: "2026-11-04T12:00:00Z",
      cursor: "cursor",
      event: {
        id: "event",
        round_id: "round",
        actor: "high",
        kind: "edited",
        at: "2026-11-04T12:00:00Z",
        data,
      },
    },
  };
  vi.mocked(getLoans).mockResolvedValue([row]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadList, { kind: "loan", active: true, onOpen: vi.fn() })
      )
    );
    const link = host.querySelector('a[data-thread="item"]')!;
    expect(link.textContent).toContain(
      "Misty: Changed the Loan terms · They give Iono: 1 → 2"
    );
    for (const secret of [
      "private-edition",
      "private-location",
      "Secret Deck",
      "closed_blocked",
    ])
      expect(link.textContent).not.toContain(secret);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
