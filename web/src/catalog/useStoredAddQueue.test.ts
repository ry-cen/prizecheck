// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import { AddQueueAccount, useStoredAddQueue } from "./useStoredAddQueue";
import { bump } from "./addQueue";
import type { BrowseEdition } from "../catalog_browse_generated";
import { browseEditions } from "../catalog_browse_generated";
import { outcomeKind, type AddOutcome, type AddItem } from "./cardActions";
import { getLocationTree } from "../location_generated";
vi.mock("../catalog_browse_generated", () => ({ browseEditions: vi.fn() }));
vi.mock("../holdings_generated", async (original) => ({
  ...(await original<typeof import("../holdings_generated")>()),
  batchAddHoldings: vi.fn(),
}));
vi.mock("../location_generated", () => ({ getLocationTree: vi.fn() }));
const edition = {
  edition_id: "one",
  printing_id: "printing",
  name: "One",
} as BrowseEdition;
const second = { ...edition, edition_id: "two", name: "Two" };
const A2 = [{ editionId: "one", quantity: 2 }];
const AB = [...A2, { editionId: "two", quantity: 1 }];
function ok(items: readonly AddItem[], settledEarlier = false): AddOutcome {
  return {
    ok: true,
    items,
    settledEarlier,
    locationId: "box",
    path: "Box",
    copies: items.reduce((n, i) => n + i.quantity, 0),
    editions: items.length,
    ownerRevision: 1,
    undoId: "undo",
  };
}
function no(code: string, editionId: string | null = null): AddOutcome {
  const o = { ok: false as const, code, editionId, retry: false };
  o.retry = outcomeKind(o) === "unknown";
  return o;
}
let rerenderAccount: (account: string) => Promise<void>;
let queue: ReturnType<typeof useStoredAddQueue>;
async function mount(account = "a") {
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    queue = useStoredAddQueue("page");
    return null;
  }
  rerenderAccount = async (value) => {
    await act(async () =>
      root.render(h(AddQueueAccount.Provider, { value }, h(Probe)))
    );
  };
  await rerenderAccount(account);
  return async () => {
    await act(async () => root.unmount());
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  vi.mocked(browseEditions).mockResolvedValue({
    available: true,
    editions: [edition, second],
    next_cursor: null,
  } as Awaited<ReturnType<typeof browseEditions>>);
  vi.mocked(getLocationTree).mockResolvedValue({
    locations: [{ id: "box", kind: "storage_leaf" }],
  } as Awaited<ReturnType<typeof getLocationTree>>);
});
test("T01 restores unsubmitted counts and target after remount; discard clears storage", async () => {
  let close = await mount();
  await act(async () => {
    queue.setQueue((q) => bump(q, edition, 1));
    queue.setChosen("box");
  });
  await close();
  close = await mount();
  expect(queue.queue.get("one")?.count).toBe(1);
  expect(queue.chosen).toBe("box");
  await act(async () => queue.clear());
  expect(sessionStorage.length).toBe(0);
  await close();
  close = await mount();
  expect(queue.queue.size).toBe(0);
  await close();
});
test("T02 in-flight submission restores only a notice, with later unsubmitted copies retained", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await act(async () => queue.submitting([{ editionId: "one", quantity: 1 }]));
  expect(sessionStorage.getItem("prizecheck:add-queue:a:page")).not.toContain(
    '"one"'
  );
  await close();
  close = await mount();
  expect(queue.queue.size).toBe(0);
  expect(queue.uncertain).toBe(true);
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await close();
  close = await mount();
  expect(queue.queue.size).toBe(1);
  await act(async () => queue.dismiss());
  expect(queue.uncertain).toBe(false);
  await close();
});
test("T03 successful add clears stored submission", async () => {
  const close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await act(async () => queue.submitting([{ editionId: "one", quantity: 1 }]));
  await act(async () => queue.settle(ok([{ editionId: "one", quantity: 1 }])));
  expect(sessionStorage.length).toBe(0);
  await close();
});
test("T37 another account's data is dropped", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await close();
  close = await mount("b");
  expect(queue.queue.size).toBe(0);
  expect(sessionStorage.length).toBe(0);
  await close();
});
test("T37 corrupt data is dropped", async () => {
  sessionStorage.setItem("prizecheck:add-queue:a:page", "broken");
  const close = await mount();
  expect(queue.queue.size).toBe(0);
  expect(sessionStorage.length).toBe(0);
  await close();
});
test("T36 stale Editions and targets are dropped", async () => {
  let close = await mount();
  await act(async () => {
    queue.setQueue((q) => bump(q, edition, 1));
    queue.setChosen("box");
  });
  await close();
  vi.mocked(browseEditions).mockResolvedValue({
    available: true,
    editions: [],
    next_cursor: null,
    catalog_revision: 1,
    owner_revision: 1,
    last_success: null,
    search: {
      mode: "all",
      text: "",
      set_id: null,
      set_name: null,
      set_code: null,
      number: null,
    },
    printings: 0,
    matches: 0,
  } as Awaited<ReturnType<typeof browseEditions>>);
  vi.mocked(getLocationTree).mockResolvedValue({
    locations: [],
    owner_revision: 1,
    lent_copies: "0",
    borrowed_copies: "0",
  });
  close = await mount();
  expect(queue.queue.size).toBe(0);
  expect(queue.chosen).toBe(null);
  await close();
});
test("storage disabled still allows edits", async () => {
  const spy = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), "setItem")
    .mockImplementation(() => {
      throw Error("off");
    });
  const close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  expect(queue.queue.size).toBe(1);
  await close();
  spy.mockRestore();
});
test("unsubmitted increments after an uncertain submission survive in the same page", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await act(async () => queue.submitting([{ editionId: "one", quantity: 1 }]));
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await close();
  close = await mount();
  expect(queue.queue.get("one")?.count).toBe(1);
  expect(queue.uncertain).toBe(true);
  await close();
});
test("a late success after unmount cannot rewrite a restored queue", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await act(async () => queue.submitting([{ editionId: "one", quantity: 1 }]));
  const old = queue;
  await close();
  close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await act(async () => old.settle(ok([{ editionId: "one", quantity: 1 }])));
  await close();
  close = await mount();
  expect(queue.queue.get("one")?.count).toBe(1);
  await close();
});

test("discard after a failed restore removes the draft, clears the notice and re-enables editing", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await close();
  vi.mocked(browseEditions).mockRejectedValueOnce(Error("offline"));
  close = await mount();
  expect(queue.ready).toBe(false);
  expect(queue.notice).toContain("Couldn't restore");
  await act(async () => queue.clear());
  expect(queue.notice).toBe("");
  expect(queue.ready).toBe(true);
  expect(sessionStorage.length).toBe(0);
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  expect(queue.queue.size).toBe(1);
  await close();
});
test("discard cancels an unfinished restore so a late answer cannot bring cards back", async () => {
  let close = await mount();
  await act(async () => queue.setQueue((q) => bump(q, edition, 1)));
  await close();
  let finish!: (page: Awaited<ReturnType<typeof browseEditions>>) => void;
  const page = await browseEditions({});
  vi.mocked(browseEditions).mockReturnValueOnce(
    new Promise((resolve) => (finish = resolve))
  );
  close = await mount();
  await act(async () => queue.clear());
  await act(async () => finish(page));
  expect(queue.queue.size).toBe(0);
  expect(queue.ready).toBe(true);
  expect(sessionStorage.length).toBe(0);
  await close();
});

const K = "prizecheck:add-queue:a:page";
const rec = () => JSON.parse(sessionStorage.getItem(K) ?? "null");
const counts = () => Array.from(queue.queue, ([id, item]) => [id, item.count]);
const storedCounts = () =>
  rec()?.items.map((i: { editionId: string; quantity: number }) => [
    i.editionId,
    i.quantity,
  ]) ?? [];
const a = (n: number) => (n ? [["one", n]] : []);
const ab = (n = 2) => [...a(n), ["two", 1]];
async function edit(card = edition, by: 1 | -1 = 1) {
  await act(async () => queue.setQueue((q) => bump(q, card, by)));
}
async function submit(items: readonly AddItem[] = A2) {
  await act(async () => queue.submitting(items));
}
async function settle(o: AddOutcome) {
  await act(async () => queue.settle(o));
}
async function base(level: number) {
  await edit();
  await edit();
  if (level >= 1) await submit();
  if (level >= 2) await settle(no(""));
}
type Row = {
  id: string;
  level: number;
  when?: () => Promise<void>;
  q: (string | number)[][];
  saved: (string | number)[][];
  marker?: boolean;
  absent?: boolean;
};
const rows: Row[] = [
  {
    id: "T01 target restoration",
    level: 0,
    when: async () => {
      await act(async () => queue.setChosen("box"));
    },
    q: a(2),
    saved: a(2),
  },
  { id: "T02 unload in flight", level: 1, q: a(2), saved: [], marker: true },
  ...[
    "LOCATION_NOT_FOUND",
    "DUPLICATE_ADD_ITEM",
    "INVALID_QUANTITY",
    "QUANTITY_OVERFLOW",
  ].map((code) => ({
    id: `T04 definitive refusal ${code}`,
    level: 1,
    when: () => settle(no(code, code === "QUANTITY_OVERFLOW" ? "one" : null)),
    q: a(2),
    saved: a(2),
  })),
  {
    id: "T05 unavailable edition",
    level: 0,
    when: async () => {
      await edit(second);
      await submit(AB);
      await settle(no("EDITION_UNAVAILABLE", "one"));
    },
    q: [["two", 1]],
    saved: [["two", 1]],
  },
  ...[
    "",
    "HOLDING_REQUEST_FAILED",
    "INVENTORY_TEMPORARILY_UNAVAILABLE",
    "IDEMPOTENCY_KEY_REUSED",
  ].map((code) => ({
    id: `T06 uncertain failure ${code || "network"}`,
    level: 1,
    when: () => settle(no(code)),
    q: a(2),
    saved: [],
    marker: true,
  })),
  {
    id: "T07 new same-edition copy",
    level: 2,
    when: () => edit(),
    q: a(3),
    saved: a(1),
    marker: true,
  },
  {
    id: "T08 new edition",
    level: 2,
    when: () => edit(second),
    q: ab(),
    saved: [["two", 1]],
    marker: true,
  },
  {
    id: "T09 decrement then increment releases held copy",
    level: 2,
    when: async () => {
      await edit(edition, -1);
      expect(counts()).toEqual(a(1));
      expect(storedCounts()).toEqual([]);
      await edit();
    },
    q: a(2),
    saved: a(1),
    marker: true,
  },
  {
    id: "T10 successful replay",
    level: 2,
    when: async () => {
      await submit();
      await settle(ok(A2));
    },
    q: [],
    saved: [],
    absent: true,
  },
  {
    id: "T11 replay refused",
    level: 2,
    when: async () => {
      await submit();
      await settle(no("QUANTITY_OVERFLOW"));
    },
    q: a(2),
    saved: a(2),
  },
  {
    id: "T12 settled earlier preserves new edition",
    level: 2,
    when: async () => {
      await edit(second);
      await submit();
      await settle(ok(A2, true));
    },
    q: [["two", 1]],
    saved: [["two", 1]],
  },
  ...["added", "refused", "unknown"].map((kind, i) => ({
    id: `T${13 + i} replaced submission ${kind}`,
    level: 2,
    when: async () => {
      await edit(second);
      await submit();
      await submit(AB);
      await settle(
        kind === "added"
          ? ok(AB)
          : no(kind === "refused" ? "QUANTITY_OVERFLOW" : "", "two")
      );
    },
    q: kind === "added" ? [] : ab(),
    saved: kind === "refused" ? ab() : [],
    marker: kind === "unknown",
    absent: kind === "added",
  })),
  {
    id: "T16 earlier replay still unknown",
    level: 2,
    when: async () => {
      await edit(second);
      await submit();
      await settle(no(""));
    },
    q: ab(),
    saved: [["two", 1]],
    marker: true,
  },
  {
    id: "T17 outcome lost",
    level: 1,
    when: () => settle(no("REPLAY_OUTCOME_UNAVAILABLE")),
    q: a(2),
    saved: [],
    marker: true,
  },
  {
    id: "T18 lost then new edition",
    level: 1,
    when: async () => {
      await settle(no("REPLAY_OUTCOME_UNAVAILABLE"));
      await edit(second);
    },
    q: ab(),
    saved: [["two", 1]],
    marker: true,
  },
  {
    id: "T19 lost copies stay excluded after later refusal F5",
    level: 1,
    when: async () => {
      await settle(no("REPLAY_OUTCOME_UNAVAILABLE"));
      await edit(second);
      await submit(AB);
      await settle(no("QUANTITY_OVERFLOW", "two"));
    },
    q: ab(),
    saved: [["two", 1]],
    marker: true,
  },
  {
    id: "T20 lost marker survives success",
    level: 1,
    when: async () => {
      await settle(no("REPLAY_OUTCOME_UNAVAILABLE"));
      await submit();
      await settle(ok(A2));
    },
    q: [],
    saved: [],
    marker: true,
  },
  {
    id: "T21 earlier replay lost",
    level: 2,
    when: async () => {
      await edit(second);
      await submit();
      await settle(no("REPLAY_OUTCOME_UNAVAILABLE"));
    },
    q: ab(),
    saved: [["two", 1]],
    marker: true,
  },
  {
    id: "T22 clear lost then new copy",
    level: 1,
    when: async () => {
      await settle(no("REPLAY_OUTCOME_UNAVAILABLE"));
      await act(async () => queue.clear());
      await edit();
    },
    q: a(1),
    saved: a(1),
    marker: true,
  },
  {
    id: "T23 clear unsubmitted",
    level: 0,
    when: async () => {
      await act(async () => queue.clear());
    },
    q: [],
    saved: [],
    absent: true,
  },
  {
    id: "T24 clear unknown then new copy",
    level: 2,
    when: async () => {
      await act(async () => queue.clear());
      expect(counts()).toEqual([]);
      expect(storedCounts()).toEqual([]);
      expect(rec().uncertain).toBe(true);
      await edit();
    },
    q: a(1),
    saved: a(1),
    marker: true,
  },
  ...[
    ok(A2),
    no("QUANTITY_OVERFLOW"),
    no(""),
    no("REPLAY_OUTCOME_UNAVAILABLE"),
  ].map((o, i) => ({
    id: `T25 clear during send ${i}`,
    level: 1,
    when: async () => {
      await act(async () => queue.clear());
      await settle(o);
    },
    q: [],
    saved: [],
    marker: i >= 2,
    absent: i < 2,
  })),
  {
    id: "T38 settledEarlier still subtracts requeued copies",
    level: 2,
    when: async () => {
      await act(async () => queue.clear());
      await edit();
      await submit();
      await settle(ok(A2, true));
    },
    q: [],
    saved: [],
    absent: true,
  },
];
test.each(rows.map((row) => [row.id, row] as const))(
  "%s",
  async (_name, row) => {
    let close = await mount();
    try {
      await base(row.level);
      await row.when?.();
      expect(counts()).toEqual(row.q);
      expect(storedCounts()).toEqual(row.saved);
      if (row.absent) expect(rec()).toBe(null);
      else expect(rec().uncertain).toBe(row.marker ?? false);
      if (row.id.startsWith("T01")) expect(rec().target).toBe("box");
      await close();
      close = await mount();
      expect(counts()).toEqual(row.saved);
      expect(queue.uncertain).toBe(row.marker ?? false);
      if (row.id.startsWith("T01")) expect(queue.chosen).toBe("box");
    } finally {
      await close();
    }
  }
);
function preset(marker = true) {
  sessionStorage.setItem(
    K,
    JSON.stringify({
      items: [{ editionId: "one", printingId: "printing", quantity: 1 }],
      target: null,
      uncertain: marker,
    })
  );
}
function deferredPage() {
  let resolve!: (page: Awaited<ReturnType<typeof browseEditions>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof browseEditions>>>(
    (r) => (resolve = r)
  );
  return { promise, resolve };
}
const restoredPage = () =>
  ({
    available: true,
    editions: [edition, second],
    next_cursor: null,
  }) as Awaited<ReturnType<typeof browseEditions>>;
test("T26 dismiss restored marker retains cards", async () => {
  preset();
  let close = await mount();
  expect(queue.uncertain).toBe(true);
  expect(storedCounts()).toEqual(a(1));
  await act(async () => queue.dismiss());
  expect(storedCounts()).toEqual(a(1));
  expect(rec().uncertain).toBe(false);
  await close();
  close = await mount();
  expect(counts()).toEqual(a(1));
  expect(queue.uncertain).toBe(false);
  await close();
});
test("T27 dismiss does not remove an open submission marker", async () => {
  preset();
  let close = await mount();
  await submit([{ editionId: "one", quantity: 1 }]);
  await act(async () => queue.dismiss());
  expect(queue.uncertain).toBe(false);
  expect(storedCounts()).toEqual([]);
  expect(rec().uncertain).toBe(true);
  await settle(ok([{ editionId: "one", quantity: 1 }]));
  expect(rec()).toBe(null);
  expect(counts()).toEqual([]);
  await close();
  close = await mount();
  expect(queue.uncertain).toBe(false);
  expect(counts()).toEqual([]);
  await close();
});
test("T28 dismiss during pending restore preserves stored cards F4", async () => {
  preset();
  const d = deferredPage();
  vi.mocked(browseEditions).mockReturnValueOnce(d.promise);
  let close = await mount();
  await act(async () => queue.dismiss());
  expect(storedCounts()).toEqual(a(1));
  expect(rec().uncertain).toBe(false);
  await act(async () => d.resolve(restoredPage()));
  expect(counts()).toEqual(a(1));
  await close();
  close = await mount();
  expect(counts()).toEqual(a(1));
  expect(queue.uncertain).toBe(false);
  await close();
});
test("T29 dismiss after failed restore preserves draft and ignores edits", async () => {
  preset();
  vi.mocked(browseEditions).mockRejectedValueOnce(Error("offline"));
  let close = await mount();
  await act(async () => queue.dismiss());
  await edit(second);
  expect(queue.restoreFailed).toBe(true);
  expect(counts()).toEqual([]);
  expect(storedCounts()).toEqual(a(1));
  expect(rec().uncertain).toBe(false);
  await close();
  close = await mount();
  expect(counts()).toEqual(a(1));
  expect(queue.uncertain).toBe(false);
  await close();
});
test("T30 clear after failed restore keeps marker", async () => {
  preset();
  vi.mocked(browseEditions).mockRejectedValueOnce(Error("offline"));
  let close = await mount();
  await act(async () => queue.clear());
  expect(queue.ready).toBe(true);
  expect(queue.notice).toBe("");
  expect(queue.uncertain).toBe(true);
  expect(storedCounts()).toEqual([]);
  expect(rec().uncertain).toBe(true);
  await close();
  close = await mount();
  expect(counts()).toEqual([]);
  expect(queue.uncertain).toBe(true);
  await close();
});
test("T31 edits during pending restoration are ignored", async () => {
  preset(false);
  const d = deferredPage();
  vi.mocked(browseEditions).mockReturnValueOnce(d.promise);
  let close = await mount();
  await edit(second);
  await act(async () => queue.setChosen("box"));
  expect(storedCounts()).toEqual(a(1));
  expect(rec().target).toBe(null);
  await act(async () => d.resolve(restoredPage()));
  expect(counts()).toEqual(a(1));
  expect(queue.chosen).toBe(null);
  await close();
  close = await mount();
  expect(counts()).toEqual(a(1));
  expect(queue.uncertain).toBe(false);
  await close();
});
test.each([ok(A2), no("QUANTITY_OVERFLOW"), no("REPLAY_OUTCOME_UNAVAILABLE")])(
  "T32 late settle after unmount ignored %j",
  async (outcome) => {
    let close = await mount();
    await base(1);
    const old = queue;
    await close();
    close = await mount();
    await edit();
    const before = sessionStorage.getItem(K);
    await act(async () => old.settle(outcome));
    expect(counts()).toEqual(a(1));
    expect(sessionStorage.getItem(K)).toBe(before);
    await close();
    close = await mount();
    expect(counts()).toEqual(a(1));
    expect(queue.uncertain).toBe(true);
    await close();
  }
);
test("T33 late settle after account switch ignored", async () => {
  const close = await mount();
  await base(1);
  const old = queue;
  await rerenderAccount("b");
  await act(async () => old.settle(no("QUANTITY_OVERFLOW")));
  expect(counts()).toEqual([]);
  expect(
    Object.keys(sessionStorage).some((k) =>
      k.startsWith("prizecheck:add-queue:a:")
    )
  ).toBe(false);
  await close();
});
test("T33b a to b to a never revives old handles", async () => {
  let close = await mount();
  await base(1);
  const old = queue;
  await rerenderAccount("b");
  await rerenderAccount("a");
  await edit(second);
  const before = sessionStorage.getItem(K);
  await act(async () => {
    old.settle(no("QUANTITY_OVERFLOW"));
    old.setQueue((q) => bump(q, edition, 1));
    old.clear();
  });
  expect(counts()).toEqual([["two", 1]]);
  expect(sessionStorage.getItem(K)).toBe(before);
  await close();
  close = await mount();
  expect(counts()).toEqual([["two", 1]]);
  expect(queue.uncertain).toBe(false);
  await close();
});
test.each([34, 35])(
  "T%d failed storage overwrite removes stale draft",
  async (id) => {
    let close = await mount();
    await base(0);
    const spy = vi
      .spyOn(Object.getPrototypeOf(sessionStorage), "setItem")
      .mockImplementation(() => {
        throw Error("full");
      });
    try {
      if (id === 34) await edit();
      else await submit();
      expect(counts()).toEqual(a(id === 34 ? 3 : 2));
      expect(rec()).toBe(null);
    } finally {
      spy.mockRestore();
    }
    await close();
    close = await mount();
    expect(counts()).toEqual([]);
    expect(queue.uncertain).toBe(false);
    await close();
  }
);

test("pending immutable command and visible copies survive reload", async () => {
  const command = {
    locationId: "box",
    path: "Box",
    key: "original-key",
    items: A2,
  };
  let close = await mount();
  await edit();
  await edit();
  await act(async () => queue.submitting(A2, command));
  await settle(no(""));
  expect(rec().pending).toEqual(command);
  expect(storedCounts()).toEqual(a(2));
  await close();
  close = await mount();
  expect(counts()).toEqual(a(2));
  expect(queue.pending.current).toEqual(command);
  expect(queue.uncertain).toBe(false);
  await edit(second);
  await settle(ok(A2, true));
  expect(counts()).toEqual([["two", 1]]);
  await close();
});

test.each([false, true])(
  "reload replays original key exactly once (committed=%s)",
  async (committed) => {
    const { addCards } = await import("./cardActions");
    const { batchAddHoldings } = await import("../holdings_generated");
    const send = vi.mocked(batchAddHoldings);
    const keys = new Set<string>();
    let copies = 0;
    let loseResponse = true;
    send.mockImplementation(async (request) => {
      if (!loseResponse || committed) {
        if (!keys.has(request.idempotency_key)) {
          keys.add(request.idempotency_key);
          copies += Number(request.items[0].quantity);
        }
      }
      if (loseResponse) throw Error("response lost");
      return {
        copy_count: "2",
        edition_count: 1,
        owner_revision: 2,
        undo_id: "undo",
        location_id: "box",
      };
    });
    let close = await mount();
    await edit();
    await edit();
    await act(async () =>
      queue.settle(
        await addCards(
          "box",
          "Original Box",
          A2,
          queue.pending,
          queue.submitting
        )
      )
    );
    const key = rec().pending.key;
    await close();
    close = await mount();
    await edit(second);
    loseResponse = false;
    await act(async () =>
      queue.settle(
        await addCards(
          "different-box",
          "Different Box",
          AB,
          queue.pending,
          queue.submitting
        )
      )
    );
    expect(copies).toBe(2);
    expect(send.mock.lastCall?.[0]).toMatchObject({
      location_id: "box",
      idempotency_key: key,
    });
    expect(counts()).toEqual([["two", 1]]);
    expect(queue.pending.current).toBe(null);
    await close();
  }
);

test("a missing original Location never changes the replay command", async () => {
  const command = {
    locationId: "missing",
    path: "Old Box",
    key: "original",
    items: A2,
  };
  let close = await mount();
  await edit();
  await edit();
  await act(async () => {
    queue.setChosen("missing");
    queue.submitting(A2, command);
  });
  await close();
  vi.mocked(getLocationTree).mockResolvedValueOnce({
    locations: [],
    owner_revision: 1,
    lent_copies: "0",
    borrowed_copies: "0",
  });
  close = await mount();
  expect(queue.pending.current).toEqual(command);
  expect(queue.chosen).toBe("missing");
  expect(counts()).toEqual(a(2));
  await close();
});
test("storage read errors leave Add usable in memory", async () => {
  const spy = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), "getItem")
    .mockImplementation(() => {
      throw Error("disabled");
    });
  const close = await mount();
  await edit();
  expect(counts()).toEqual(a(1));
  await close();
  spy.mockRestore();
});

test("Discard abandons a persisted pending command after failed restoration and retains the warning", async () => {
  const { addCards } = await import("./cardActions");
  const { batchAddHoldings } = await import("../holdings_generated");
  const send = vi.mocked(batchAddHoldings);
  send.mockReset().mockRejectedValueOnce(Error("never committed"));
  let close = await mount();
  await edit();
  await edit();
  await act(async () =>
    queue.settle(
      await addCards("box", "Box", A2, queue.pending, queue.submitting)
    )
  );
  const abandonedKey = rec().pending.key;
  await close();
  vi.mocked(browseEditions).mockRejectedValueOnce(Error("restore offline"));
  close = await mount();
  expect(queue.restoreFailed).toBe(true);
  expect(queue.pending.current?.key).toBe(abandonedKey);
  await act(async () => queue.clear());
  expect(queue.pending.current).toBe(null);
  expect(rec().pending).toBe(null);
  expect(queue.uncertain).toBe(true);
  await close();
  close = await mount();
  expect(queue.uncertain).toBe(true);
  expect(queue.pending.current).toBe(null);
  await edit(second);
  await act(async () => queue.setChosen("different-box"));
  send.mockClear().mockResolvedValueOnce({
    copy_count: "1",
    edition_count: 1,
    owner_revision: 2,
    undo_id: "undo",
    location_id: "different-box",
  });
  await act(async () =>
    queue.settle(
      await addCards(
        "different-box",
        "Different Box",
        [{ editionId: "two", quantity: 1 }],
        queue.pending,
        queue.submitting
      )
    )
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.lastCall?.[0]).toMatchObject({
    location_id: "different-box",
    items: [{ edition_id: "two", quantity: "1" }],
  });
  expect(send.mock.lastCall?.[0].idempotency_key).not.toBe(abandonedKey);
  expect(counts()).toEqual([]);
  expect(queue.uncertain).toBe(true);
  await close();
});

test.each([false, 0, "", [], { key: "partial" }])(
  "malformed pending %j is dropped and Add remains usable",
  async (pending) => {
    preset(false);
    sessionStorage.setItem(K, JSON.stringify({ ...rec(), pending }));
    const close = await mount();
    expect(queue.pending.current).toBe(null);
    expect(rec()).toBe(null);
    const { addCards } = await import("./cardActions");
    const { batchAddHoldings } = await import("../holdings_generated");
    const send = vi.mocked(batchAddHoldings);
    send.mockReset().mockResolvedValueOnce({
      copy_count: "1",
      edition_count: 1,
      owner_revision: 2,
      undo_id: "undo",
      location_id: "box",
    });
    await edit(second);
    await act(async () =>
      queue.settle(
        await addCards(
          "box",
          "Box",
          [{ editionId: "two", quantity: 1 }],
          queue.pending,
          queue.submitting
        )
      )
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual([]);
    await close();
  }
);
