// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  getLoans,
  getThreadDetail,
  readThread,
  type ThreadItem,
} from "../social_generated";
import { ThreadList } from "./ThreadList";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLoans: vi.fn(),
  getThreadDetail: vi.fn(),
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
    expect(link.textContent).toContain("2 cards");
    expect(link.textContent).toContain("2 Iono");
    expect(link.textContent).not.toContain("Changed the Loan terms");
    expect(link.textContent).not.toContain("→");
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

it("S2-09: Done keeps a full tap target and native folded history without marking it read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getLoans).mockResolvedValue([
    {
      id: "done-item",
      kind: "loan",
      other: {
        trader_id: null,
        display_name: "Misty",
        friend: false,
        available: false,
      },
      you_are: "low",
      summary: { cards: [], you_give: "0", you_get: "1" },
      section: "done",
      state: "closed",
      waiting: null,
      unread: 0,
      needs_you: false,
      last_activity_at: "2026-11-04T12:00:00Z",
    },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ThreadList, { kind: "loan", active: true, onOpen: vi.fn() })
      )
    );
    const summary = host.querySelector("summary")!,
      disclosure = host.querySelector("details")!;
    expect(summary.textContent).toBe("Done");
    expect(summary.classList.contains("min-h-tap")).toBe(true);
    expect(disclosure.open).toBe(false);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    await act(async () => summary.click());
    expect(disclosure.open).toBe(true);
    expect(
      disclosure.querySelector('a[data-thread="done-item"]')
    ).not.toBeNull();
    await act(async () => summary.click());
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(readThread).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps return focus through an in-flight list move into Done without another read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const row: ThreadItem = {
    id: "moving-item",
    kind: "loan",
    you_are: "low",
    other: {
      trader_id: null,
      display_name: "Ash",
      friend: true,
      available: true,
    },
    summary: { you_give: "3", you_get: "0", cards: [] },
    section: "needs_you",
    state: "requested",
    waiting: "answer",
    unread: 0,
    needs_you: true,
    last_activity_at: "2026-11-05T00:00:00Z",
  };
  let release!: (rows: ThreadItem[]) => void;
  vi.mocked(getLoans)
    .mockResolvedValueOnce([row])
    .mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    kind: "loan" as const,
    active: true,
    onOpen: vi.fn(),
    selected: row.id,
    revision: 0,
  };
  try {
    await act(async () => root.render(h(ThreadList, props)));
    await act(async () =>
      root.render(h(ThreadList, { ...props, revision: 1 }))
    );
    await act(async () =>
      root.render(h(ThreadList, { ...props, selected: null, revision: 1 }))
    );
    expect(document.activeElement).toBe(host.querySelector("a"));
    await act(async () =>
      release([
        {
          ...row,
          state: "closed",
          section: "done",
          waiting: null,
          needs_you: false,
        },
      ])
    );
    const done = host.querySelector("details")!;
    expect(done.open).toBe(true);
    expect(document.activeElement).toBe(done.querySelector("a"));
    expect(getLoans).toHaveBeenCalledTimes(2);
    expect(readThread).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }
});

const deferredFocusRow: ThreadItem = {
  id: "A",
  kind: "loan",
  you_are: "low",
  other: {
    trader_id: null,
    display_name: "Ash",
    friend: true,
    available: true,
  },
  summary: { you_give: "3", you_get: "0", cards: [] },
  section: "needs_you",
  state: "requested",
  waiting: "answer",
  unread: 0,
  needs_you: true,
  last_activity_at: "2026-11-05T00:00:00Z",
};
async function deferredFocusFixture() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: (rows: ThreadItem[]) => void;
  vi.mocked(getLoans)
    .mockResolvedValueOnce([deferredFocusRow])
    .mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const other = document.createElement("button");
  other.textContent = "Other navigation";
  document.body.append(other);
  let props = {
    kind: "loan" as const,
    active: true,
    onOpen: vi.fn(),
    selected: "A" as string | null,
    revision: 0,
  };
  const render = async (changes: Partial<typeof props>) => {
    props = { ...props, ...changes };
    await act(async () => root.render(h(ThreadList, props)));
  };
  await render({});
  await render({ revision: 1 });
  await render({ selected: null });
  expect(document.activeElement).toBe(host.querySelector("a"));
  return {
    host,
    other,
    render,
    release: () =>
      act(async () =>
        release([
          {
            ...deferredFocusRow,
            section: "done",
            state: "closed",
            waiting: null,
            needs_you: false,
          },
        ])
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      other.remove();
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    },
  };
}
it("review: authoritative refresh does not steal focus after collector moves to another control", async () => {
  const f = await deferredFocusFixture();
  try {
    f.other.focus();
    expect(document.activeElement).toBe(f.other);
    await f.release();
    expect(getLoans).toHaveBeenCalledTimes(2);
    expect(readThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.other);
    expect(f.host.querySelector("details")!.open).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it("review: return token does not survive leaving the page and open Done on a later visit", async () => {
  const f = await deferredFocusFixture();
  try {
    await f.render({ active: false });
    f.other.focus();
    await f.release();
    expect(getLoans).toHaveBeenCalledTimes(2);
    expect(readThread).not.toHaveBeenCalled();
    expect(f.host.querySelector("details")!.open).toBe(false);
    // Keep the newly requested quiet read unresolved: the old token must not act at all.
    vi.mocked(getLoans).mockImplementation(() => new Promise(() => {}));
    await f.render({ active: true });
    expect(f.host.querySelector("details")!.open).toBe(false);
    expect(document.activeElement).toBe(f.other);
  } finally {
    await f.cleanup();
  }
});

for (const leave of [
  "window blur",
  "hidden document",
  "outside pointer",
] as const)
  it(`deferred Done focus is cancelled by ${leave} without a read`, async () => {
    const f = await deferredFocusFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      if (leave === "window blur") window.dispatchEvent(new Event("blur"));
      else if (leave === "hidden document") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else
        f.other.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await f.release();
      expect(f.host.querySelector("details")!.open).toBe(false);
      expect(document.activeElement).not.toBe(
        f.host.querySelector("details a")
      );
      expect(getLoans).toHaveBeenCalledTimes(2);
      expect(readThread).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
      await f.cleanup();
    }
  });

for (const reason of ["returned", "written_off"] as const) {
  for (const side of ["you_give", "you_get"] as const) {
    it(`shows ${reason} from ${side} even after a later chat message`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const row: ThreadItem = {
        id: "closed",
        kind: "loan",
        other: { trader_id: "friend", display_name: "Misty" },
        you_are: "low",
        summary: {
          you_give: side === "you_give" ? "2" : "0",
          you_get: side === "you_get" ? "2" : "0",
          cards: [],
        },
        section: "done",
        state: "closed",
        closed_reason: reason,
        last_activity_at: "2026-11-08",
        latest: {
          kind: "message",
          at: "2026-11-08",
          cursor: "cursor",
          message: {
            id: "message",
            from: "them",
            body: "Thanks!",
            at: "2026-11-08",
          },
        },
      };
      vi.mocked(getLoans).mockResolvedValue([row]);
      const host = document.createElement("div");
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            h(ThreadList, { kind: "loan", active: true, onOpen: vi.fn() })
          )
        );
        expect(host.textContent).toContain(
          reason === "returned" ? "Returned" : "Written off"
        );
        expect(host.textContent).toContain("Misty: Thanks!");
        expect(host.textContent).toContain("2 cards");
        expect(host.textContent).not.toContain("written_off");
        expect(getThreadDetail).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        vi.clearAllMocks();
        vi.unstubAllGlobals();
      }
    });
  }
}
