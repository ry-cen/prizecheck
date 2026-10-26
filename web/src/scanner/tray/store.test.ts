import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScannerError,
  type ScanSave,
  type ScannerPrinting,
  type ScannerPrintingsResponse,
} from "../../scanner_generated";
import {
  PENDING_SAVE_MAX_AGE_MS,
  emptyTray,
  mergeItems,
  openTray,
  parseTray,
  trayEditAllowed,
  trayKey,
  type TrayDeps,
  type TrayRow,
  type TrayV1,
} from "./store";

const DAY = 24 * 60 * 60 * 1000;

function memStorage() {
  const mem = new Map<string, string>();
  return {
    mem,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
}

/** A Web Locks stand-in that queues requests by name, like the real one. */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn(<T>(name: string, cb: () => Promise<T>): Promise<T> => {
    const run = (tails.get(name) ?? Promise.resolve()).then(
      cb,
      cb
    ) as Promise<T>;
    tails.set(
      name,
      run.catch(() => undefined)
    );
    return run;
  });
  return { request };
}

let seq = 0;
const uuid = () => `row-${++seq}`;

const printing = (
  id: string,
  edition: string | null,
  editions = [edition ?? "x"]
): ScannerPrinting =>
  ({
    id,
    default_edition_id: edition,
    editions: editions.map((e) => ({
      id: e,
      active: true,
      descriptor: {},
      source: "s",
    })),
  }) as unknown as ScannerPrinting;

const answer = (
  printings: ScannerPrinting[],
  missing: string[] = []
): ScannerPrintingsResponse => ({
  catalog_revision: 1,
  printings,
  missing,
});

function row(over: Partial<TrayRow> & { id: string }): TrayRow {
  return {
    printing_id: `p-${over.id}`,
    edition_id: `e-${over.id}`,
    count: 1,
    candidates: [`p-${over.id}`],
    needs_pick: false,
    ...over,
  };
}
const trayOf = (rows: TrayRow[], over: Partial<TrayV1> = {}): TrayV1 => ({
  ...emptyTray(),
  rows,
  ...over,
});
const manyRows = (n: number, count = 1) =>
  Array.from({ length: n }, (_, i) => row({ id: `r${i}`, count }));

function setup(extra: Partial<TrayDeps> = {}) {
  const storage = memStorage();
  const locks = fakeLocks();
  const resolvePrintings = vi.fn(async (ids: string[]) =>
    answer(ids.map((id) => printing(id, `ed-${id}`)))
  );
  const save = vi.fn(async (_body: ScanSave) => ({
    location_id: "L",
    edition_count: 1,
    copy_count: "1",
    owner_revision: 2,
  }));
  const deps: TrayDeps = {
    storage,
    locks: locks as unknown as TrayDeps["locks"],
    events: null,
    randomUUID: uuid,
    resolvePrintings,
    save,
    ...extra,
  };
  return {
    storage,
    locks,
    resolvePrintings,
    save,
    deps,
    open: (user = "u1") => openTray(user, deps),
  };
}

beforeEach(() => {
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("storage", () => {
  it("round-trips TrayV1 under the per-user key with v: 1", async () => {
    const t = setup();
    const store = await t.open();
    await store.applyLock(["a"]);
    const raw = JSON.parse(t.storage.mem.get(trayKey("u1"))!);
    expect(trayKey("u1")).toBe("prizecheck:scanner:tray:v1:u1");
    expect(raw.v).toBe(1);
    expect(raw.rows).toEqual([
      {
        id: "row-1",
        printing_id: "a",
        edition_id: "ed-a",
        count: 1,
        candidates: ["a"],
        needs_pick: false,
      },
    ]);
    const again = await t.open();
    expect(again.getState().tray.rows).toEqual(raw.rows);
    expect(parseTray(JSON.stringify(raw))).toEqual(again.getState().tray);
  });

  it("holds ids and counts only", async () => {
    const t = setup();
    const store = await t.open();
    await store.applyLock(["a"]);
    const raw = t.storage.mem.get(trayKey("u1"))!;
    expect(raw).not.toMatch(/name|image|price|score/);
  });

  it.each([
    "{nope",
    '{"v":2,"rows":[]}',
    "null",
    '{"v":1,"rows":"x"}',
    '{"v":1,"rows":[{"id":1}],"location_id":null,"pending_save":null}',
  ])(
    "treats %s as empty and leaves it in place until the tray changes",
    async (garbage) => {
      const t = setup();
      t.storage.mem.set(trayKey("u1"), garbage);
      const store = await t.open();
      expect(store.getState().tray.rows).toEqual([]);
      expect(t.storage.mem.get(trayKey("u1"))).toBe(garbage);
      await store.applyLock(["a"]);
      expect(JSON.parse(t.storage.mem.get(trayKey("u1"))!).v).toBe(1);
    }
  );

  it("keeps each account's tray separate and does not clear it when another opens", async () => {
    const t = setup();
    const a = await t.open("alice");
    await a.applyLock(["a"]);
    const b = await t.open("bob");
    expect(b.getState().tray.rows).toEqual([]);
    await b.applyLock(["b"]);
    expect(
      (await t.open("alice")).getState().tray.rows.map((r) => r.printing_id)
    ).toEqual(["a"]);
    expect(
      (await t.open("bob")).getState().tray.rows.map((r) => r.printing_id)
    ).toEqual(["b"]);
  });

  it("re-reads on the storage event from another tab", async () => {
    const target = new EventTarget();
    const t = setup({ events: target });
    const store = await t.open();
    const seen = vi.fn();
    store.subscribe(seen);
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "x" })]))
    );
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: trayKey("u1") })
    );
    expect(store.getState().tray.rows.map((r) => r.id)).toEqual(["x"]);
    expect(seen).toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event("storage"), { key: "other" }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("runs every read and write inside the named Web Lock, one request per write, and serialises two writers", async () => {
    const storage = memStorage();
    let held = 0;
    let maxHeld = 0;
    const outside: string[] = [];
    let tracking = false;
    const tail: { p: Promise<unknown> } = { p: Promise.resolve() };
    const request = vi.fn(
      async <T>(name: string, cb: () => Promise<T>): Promise<T> => {
        const run = tail.p.then(async () => {
          await Promise.resolve(); // the grant is deferred: nothing may read before it
          held++;
          maxHeld = Math.max(maxHeld, held);
          try {
            return await cb();
          } finally {
            held--;
          }
        });
        tail.p = run.catch(() => undefined);
        expect(name).toBe("prizecheck:scanner:tray:u1");
        return run;
      }
    );
    const guarded = {
      getItem: (k: string) => {
        if (tracking && held === 0) outside.push(`get ${k}`);
        return storage.getItem(k);
      },
      setItem: (k: string, v: string) => {
        if (tracking && held === 0) outside.push(`set ${k}`);
        storage.setItem(k, v);
      },
    };
    const t = setup({
      storage: guarded,
      locks: { request } as unknown as TrayDeps["locks"],
    });
    const a = await openTray("u1", t.deps);
    const b = await openTray("u1", t.deps); // a second tab: same storage, same lock
    tracking = true;
    request.mockClear();
    await Promise.all([
      a.applyLock(["a"]),
      b.applyLock(["b"]),
      a.applyLock(["c"]),
      b.applyLock(["d"]),
    ]);
    expect(outside).toEqual([]);
    expect(maxHeld).toBe(1);
    expect(request).toHaveBeenCalledTimes(4);
    const stored = JSON.parse(storage.mem.get(trayKey("u1"))!);
    expect(stored.rows.map((r: TrayRow) => r.printing_id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("signals the first row added once", async () => {
    const onFirstRowAdded = vi.fn();
    const t = setup({ onFirstRowAdded });
    const store = await t.open();
    await store.applyLock(["a"]);
    await store.applyLock(["b"]);
    expect(onFirstRowAdded).toHaveBeenCalledTimes(1);
  });
});

describe("trayEditAllowed", () => {
  it("rejects_201st_distinct_edition_on_lock", () => {
    const tray = trayOf(manyRows(200));
    expect(trayEditAllowed(tray, { type: "add_row", edition_id: "new" })).toBe(
      "full"
    );
    expect(trayEditAllowed(tray, { type: "add_row", edition_id: "e-r3" })).toBe(
      "ok"
    );
  });

  it("rejects_chip_change_that_adds_201st_edition", () => {
    // 200 distinct Editions over 201 rows: the extra row shares an Edition with r0.
    const tray = trayOf([
      ...manyRows(200),
      row({ id: "dup", edition_id: "e-r0" }),
    ]);
    expect(
      trayEditAllowed(tray, {
        type: "set_edition",
        row_id: "dup",
        edition_id: "brand-new",
      })
    ).toBe("full");
  });

  it("allows_chip_change_that_keeps_count", () => {
    const tray = trayOf(manyRows(200));
    expect(
      trayEditAllowed(tray, {
        type: "set_edition",
        row_id: "r1",
        edition_id: "other",
      })
    ).toBe("ok");
    expect(
      trayEditAllowed(tray, {
        type: "set_edition",
        row_id: "r1",
        edition_id: "e-r2",
      })
    ).toBe("ok");
  });

  it("rejects_search_pick_over_cap", async () => {
    const t = setup();
    t.storage.mem.set(trayKey("u1"), JSON.stringify(trayOf(manyRows(200))));
    const store = await t.open();
    expect(
      await store.applySearchPick({ printingId: "p", editionId: "new" })
    ).toBe("full");
    expect(store.getState().tray.rows).toHaveLength(200);
  });

  it("rejects_401st_row", () => {
    const rows = [
      ...manyRows(100),
      ...Array.from({ length: 300 }, (_, i) =>
        row({ id: `s${i}`, edition_id: "e-r0" })
      ),
    ];
    expect(rows).toHaveLength(400);
    expect(
      trayEditAllowed(trayOf(rows), { type: "add_row", edition_id: "e-r0" })
    ).toBe("row_limit");
  });

  it("rejects_count_over_999_and_edition_total_over_9999", () => {
    const tray = trayOf([row({ id: "a", count: 999 })]);
    expect(
      trayEditAllowed(tray, { type: "set_count", row_id: "a", count: 1000 })
    ).toBe("full"); // 999 a row: the full-tray message
    expect(
      trayEditAllowed(tray, { type: "set_count", row_id: "a", count: 998 })
    ).toBe("ok");
    const ten = Array.from({ length: 11 }, (_, i) =>
      row({ id: `s${i}`, edition_id: "same", count: 909 })
    );
    // 11 x 909 = 9999: one more copy anywhere in that Edition passes 9999.
    expect(
      trayEditAllowed(trayOf(ten), {
        type: "set_count",
        row_id: "s0",
        count: 910,
      })
    ).toBe("edition_limit");
    expect(
      trayEditAllowed(trayOf(ten), { type: "add_row", edition_id: "same" })
    ).toBe("edition_limit");
    expect(
      trayEditAllowed(trayOf(ten), { type: "add_row", edition_id: "other" })
    ).toBe("ok");
  });

  it("a rejected edit leaves the tray unchanged", async () => {
    const t = setup();
    const full = trayOf(manyRows(200));
    t.storage.mem.set(trayKey("u1"), JSON.stringify(full));
    const store = await t.open();
    const before = t.storage.mem.get(trayKey("u1"));
    const result = await store.applyLock(["fresh"]);
    expect(result).toMatchObject({
      added: false,
      reason: "full",
      verdict: "full",
    });
    expect(t.storage.mem.get(trayKey("u1"))).toBe(before);
  });

  it("checks capacity for a copy to an existing row before the network call", async () => {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "a", printing_id: "pa", count: 999 })]))
    );
    const store = await t.open();
    const result = await store.applyLock(["pa"]);
    expect(result).toMatchObject({
      added: false,
      reason: "full",
      verdict: "full",
    });
    expect(t.resolvePrintings).not.toHaveBeenCalled();
  });

  it("applies the caps to count changes and chip changes through the store", async () => {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "a", count: 999 })]))
    );
    const store = await t.open();
    expect(await store.setCount("a", 1000)).toBe("full");
    expect(await store.setCount("a", 5)).toBe("ok");
    expect(await store.setCount("a", 0)).toBe("invalid");
    expect(await store.setCount("zz", 2)).toBe("no_row");
    expect(store.getState().tray.rows[0]!.count).toBe(5);
  });
});

describe("locks and picks", () => {
  it("adds a repeat lock as one copy to the newest row of that Printing", async () => {
    const t = setup();
    const store = await t.open();
    const first = await store.applyLock(["a"]);
    await store.setEdition(first.row!.id, "ed-other"); // a Reverse Holo chip
    await store.applySearchPick({ printingId: "a", editionId: "ed-a" }); // the newer row, same Printing
    const newest = store.getState().tray.rows[0]!;
    expect(newest.edition_id).toBe("ed-a");
    const again = await store.applyLock(["a"]);
    expect(again.added).toBe(true);
    const rows = store.getState().tray.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: newest.id, count: 2 });
    expect(rows[1]!.count).toBe(1);
  });

  it("writes the row with the first candidate that has a default_edition_id, candidates in order", async () => {
    const t = setup();
    t.resolvePrintings.mockResolvedValue(
      answer(
        [printing("b", null), printing("c", "ed-c"), printing("d", "ed-d")],
        ["a"]
      )
    );
    const store = await t.open();
    const result = await store.applyLock(["a", "c", "d"]);
    expect(result.added).toBe(true);
    expect(result.row).toMatchObject({
      printing_id: "c",
      edition_id: "ed-c",
      candidates: ["c", "d"],
    });
    expect(t.resolvePrintings).toHaveBeenCalledWith(["a", "c", "d"]);
  });

  it("a row built from default_edition_id always has an Edition, and no row is written when none resolves", async () => {
    const t = setup();
    t.resolvePrintings.mockResolvedValue(
      answer([printing("a", null), printing("b", null)], ["c"])
    );
    const store = await t.open();
    const result = await store.applyLock(["a", "b", "c"]);
    expect(result).toEqual({ added: false, reason: "unresolved" });
    expect(store.getState().tray.rows).toEqual([]);
    expect(t.storage.mem.has(trayKey("u1"))).toBe(false); // nothing written
    await store.applyLock(["x"]);
    for (const r of store.getState().tray.rows)
      expect(r.edition_id).toBeTruthy();
  });

  it("a pick must resolve the picked Printing itself", async () => {
    const t = setup();
    t.resolvePrintings.mockResolvedValue(
      answer([printing("a", null), printing("b", "ed-b")])
    );
    const store = await t.open();
    expect(await store.applyPick("a", ["b"])).toEqual({
      added: false,
      reason: "unresolved",
    });
    t.resolvePrintings.mockResolvedValue(
      answer([printing("a", "ed-a"), printing("b", "ed-b")])
    );
    const ok = await store.applyPick("a", ["b"]);
    expect(ok.row).toMatchObject({ printing_id: "a", candidates: ["a", "b"] });
  });

  it("times out the printings call after 5 s and writes no row", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.resolvePrintings.mockImplementation(() => new Promise(() => {}));
    const store = await t.open();
    const pending = store.applyLock(["a"]);
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ added: false, reason: "offline" });
    expect(store.getState().tray.rows).toEqual([]);
    expect(store.getState().offline).toBe(true);
  });

  it("reports offline when the route fails", async () => {
    const t = setup();
    t.resolvePrintings.mockRejectedValue(new ScannerError(503, "X"));
    const store = await t.open();
    expect(await store.applyLock(["a"])).toEqual({
      added: false,
      reason: "offline",
    });
  });

  it("a search pick replaces a row's Printing and Edition, clears needs_pick and keeps the count", async () => {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "a", count: 3, needs_pick: true })]))
    );
    const store = await t.open();
    expect(
      await store.applySearchPick({
        printingId: "pn",
        editionId: "en",
        replaceRowId: "a",
      })
    ).toBe("ok");
    expect(store.getState().tray.rows[0]).toMatchObject({
      id: "a",
      printing_id: "pn",
      edition_id: "en",
      count: 3,
      needs_pick: false,
      candidates: ["pn"],
    });
  });

  it("removes rows and resolves needs_pick with a chip", async () => {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(
        trayOf([row({ id: "a", needs_pick: true }), row({ id: "b" })])
      )
    );
    const store = await t.open();
    await store.setEdition("a", "e-new");
    expect(store.getState().tray.rows[0]).toMatchObject({
      edition_id: "e-new",
      needs_pick: false,
    });
    await store.removeRow("b");
    expect(store.getState().tray.rows.map((r) => r.id)).toEqual(["a"]);
    await store.clear();
    expect(store.getState().tray.rows).toEqual([]);
  });
});

describe("parseTray caps and hygiene", () => {
  const over = (rows: TrayRow[]) => JSON.stringify(trayOf(rows));
  it.each([
    ["401 rows", () => over(manyRows(401))],
    ["201 Editions", () => over(manyRows(201))],
    [
      "10000 copies of one Edition",
      () =>
        over(
          Array.from({ length: 11 }, (_, i) =>
            row({ id: `s${i}`, edition_id: "same", count: 910 })
          )
        ),
    ],
    ["1000 copies a row", () => over([row({ id: "a", count: 1000 })])],
    [
      "4 candidates",
      () => over([row({ id: "a", candidates: ["a", "b", "c", "d"] })]),
    ],
  ])(
    "treats a tray with %s as unparseable and leaves it in place",
    async (_n, make) => {
      const t = setup();
      const raw = make();
      t.storage.mem.set(trayKey("u1"), raw);
      expect(parseTray(raw)).toBeNull();
      const store = await t.open();
      expect(store.getState().tray.rows).toEqual([]);
      expect(t.storage.mem.get(trayKey("u1"))).toBe(raw);
    }
  );

  it("treats a pending save whose started_at does not parse as expired", async () => {
    const t = setup();
    const tray = trayOf([row({ id: "a" })], {
      pending_save: {
        key: "k",
        location_id: "L",
        items: [["e-a", "1"]],
        started_at: "not a date",
      },
    });
    t.storage.mem.set(trayKey("u1"), JSON.stringify(tray));
    const store = await t.open();
    expect(store.getState().tray.pending_save).toBeNull();
    expect(store.getState().staleSaveNote).toBe(true);
  });

  it("swaps the printings map instead of mutating it", async () => {
    const t = setup();
    const store = await t.open();
    const before = store.getState().printings;
    await store.applyLock(["a"]);
    const after = store.getState().printings;
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
    expect(after.has("a")).toBe(true);
  });
});

describe("refreshStale", () => {
  function held() {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(
        trayOf([row({ id: "old", printing_id: "p-old", edition_id: "e-old" })])
      )
    );
    let release!: (r: ScannerPrintingsResponse) => void;
    t.resolvePrintings.mockImplementationOnce(
      () => new Promise<ScannerPrintingsResponse>((r) => (release = r))
    );
    return { t, release: (r: ScannerPrintingsResponse) => release(r) };
  }

  it("does not mark a row for a Printing it never queried (a lock during the check)", async () => {
    const { t, release } = held();
    const store = await t.open();
    const refresh = store.refreshStale();
    await store.applyLock(["fresh"]); // not in the held answer
    release(answer([printing("p-old", "e-old", ["e-old"])]));
    expect(await refresh).toBe("ok");
    const rows = store.getState().tray.rows;
    expect(rows.map((r) => [r.printing_id, r.needs_pick])).toEqual([
      ["fresh", false],
      ["p-old", false],
    ]);
  });

  it("leaves a search pick made during the check unmarked", async () => {
    const { t, release } = held();
    const store = await t.open();
    const refresh = store.refreshStale();
    await store.applySearchPick({
      printingId: "p-new",
      editionId: "e-new",
      replaceRowId: "old",
    });
    release(answer([], ["p-old"]));
    await refresh;
    expect(store.getState().tray.rows[0]).toMatchObject({
      id: "old",
      printing_id: "p-new",
      needs_pick: false,
    });
  });

  it("counts a timed-out chunk as an outage and marks nothing", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "a" })]))
    );
    t.resolvePrintings.mockImplementation(() => new Promise(() => {}));
    const store = await t.open();
    const refresh = store.refreshStale();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await refresh).toBe("offline");
    expect(store.getState().tray.rows[0]!.needs_pick).toBe(false);
    expect(store.getState().offline).toBe(true);
  });

  it("marks a row whose Printing is missing or whose Edition is no longer active, keeping its Edition", async () => {
    const t = setup();
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(
        trayOf([
          row({ id: "ok", printing_id: "p1", edition_id: "e1" }),
          row({ id: "gone", printing_id: "p2", edition_id: "e2" }),
          row({ id: "inactive", printing_id: "p3", edition_id: "e3" }),
        ])
      )
    );
    const p3 = printing("p3", "e9", ["e9"]);
    t.resolvePrintings.mockResolvedValue(
      answer([printing("p1", "e1", ["e1"]), p3], ["p2"])
    );
    const store = await t.open();
    expect(await store.refreshStale()).toBe("ok");
    const rows = store.getState().tray.rows;
    expect(rows.map((r) => [r.id, r.needs_pick, r.edition_id])).toEqual([
      ["ok", false, "e1"],
      ["gone", true, "e2"],
      ["inactive", true, "e3"],
    ]);
  });

  it("calls the route in chunks of 100 and marks nothing on an outage", async () => {
    const t = setup();
    // 250 rows over 200 Editions: the tray caps allow it.
    const rows = manyRows(250).map((r, i) =>
      i < 200 ? r : { ...r, edition_id: `e-r${i - 200}` }
    );
    const editions = manyRows(200).map((r) => r.edition_id);
    t.storage.mem.set(trayKey("u1"), JSON.stringify(trayOf(rows)));
    t.resolvePrintings
      .mockResolvedValueOnce(answer([]))
      .mockRejectedValueOnce(new TypeError("network"));
    const store = await t.open();
    expect(await store.refreshStale()).toBe("offline");
    expect(t.resolvePrintings.mock.calls.map((c) => c[0].length)).toEqual([
      100, 100,
    ]);
    expect(store.getState().tray.rows.every((r) => !r.needs_pick)).toBe(true);
    expect(store.getState().offline).toBe(true);

    t.resolvePrintings.mockReset();
    t.resolvePrintings.mockImplementation(async (ids: string[]) =>
      answer(ids.map((id) => printing(id, editions[0]!, editions)))
    );
    expect(await store.refreshStale()).toBe("ok");
    expect(t.resolvePrintings.mock.calls.map((c) => c[0].length)).toEqual([
      100, 100, 50,
    ]);
    expect(store.getState().tray.rows.every((r) => !r.needs_pick)).toBe(true);
    expect(store.getState().offline).toBe(false);
  });
});

describe("pending_save and confirm", () => {
  const twoRows = () =>
    trayOf([
      row({ id: "a", edition_id: "E1", count: 2 }),
      row({ id: "b", edition_id: "E1", count: 3 }),
      row({ id: "c", edition_id: "E2", count: 1 }),
    ]);

  async function confirming(deps: Partial<TrayDeps> = {}) {
    const t = setup(deps);
    t.storage.mem.set(trayKey("u1"), JSON.stringify(twoRows()));
    const store = await t.open();
    return { t, store };
  }

  const refusal = (
    status: number,
    code: string,
    detail: Record<string, unknown> = {}
  ) => new ScannerError(status, code, detail);

  it("merges rows of one Edition and sends the key with the destination", async () => {
    expect(mergeItems(twoRows().rows)).toEqual([
      ["E1", "5"],
      ["E2", "1"],
    ]);
    const { t, store } = await confirming();
    const result = await store.confirm("L1");
    expect(result.kind).toBe("saved");
    expect(t.save).toHaveBeenCalledWith({
      location_id: "L1",
      idempotency_key: "row-1",
      items: [
        { edition_id: "E1", quantity: "5" },
        { edition_id: "E2", quantity: "1" },
      ],
    });
    expect(store.getState().tray.rows).toEqual([]);
    expect(store.getState().tray.pending_save).toBeNull();
  });

  it("blocks an empty tray and one with a needs_pick row", async () => {
    const t = setup();
    const store = await t.open();
    expect(await store.confirm("L")).toEqual({
      kind: "blocked",
      reason: "empty",
    });
    t.storage.mem.set(
      trayKey("u1"),
      JSON.stringify(trayOf([row({ id: "a", needs_pick: true })]))
    );
    const again = await t.open();
    expect(await again.confirm("L")).toEqual({
      kind: "blocked",
      reason: "needs_pick",
    });
    expect(t.save).not.toHaveBeenCalled();
  });

  it("a network error or 5xx keeps the tray frozen and read-only; a retry reuses the key and items", async () => {
    const t = setup();
    t.storage.mem.set(trayKey("u1"), JSON.stringify(twoRows()));
    const store = await t.open();
    t.save.mockRejectedValueOnce(new TypeError("network"));
    expect(await store.confirm("L1")).toEqual({ kind: "pending", code: null });
    const sent = t.save.mock.calls[0]![0] as unknown;
    expect(store.getState().tray.pending_save).toMatchObject({
      key: "row-1",
      location_id: "L1",
    });

    // Read-only: every edit answers "frozen" and changes nothing.
    expect(await store.setCount("a", 9)).toBe("frozen");
    expect(await store.setEdition("a", "E9")).toBe("frozen");
    expect(await store.removeRow("a")).toBe("frozen");
    expect(await store.clear()).toBe("frozen");
    expect(await store.setLocation("L2")).toBe("frozen");
    expect(
      await store.applySearchPick({ printingId: "p", editionId: "E" })
    ).toBe("frozen");
    expect(await store.applyLock(["z"])).toMatchObject({
      added: false,
      reason: "full",
      verdict: "frozen",
    });
    expect(store.getState().tray.rows).toHaveLength(3);

    t.save.mockRejectedValueOnce(
      refusal(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
    );
    expect(await store.confirm("ignored")).toEqual({
      kind: "pending",
      code: "INVENTORY_TEMPORARILY_UNAVAILABLE",
    });
    expect(await store.confirm("ignored")).toMatchObject({ kind: "saved" });
    expect(t.save.mock.calls[1]![0]).toEqual(sent);
    expect(t.save.mock.calls[2]![0]).toEqual(sent);
    expect(store.getState().tray.rows).toEqual([]);
  });

  it("the freeze survives a reload", async () => {
    const t = setup();
    t.storage.mem.set(trayKey("u1"), JSON.stringify(twoRows()));
    const store = await t.open();
    t.save.mockRejectedValueOnce(new TypeError("network"));
    await store.confirm("L1");
    const reopened = await t.open();
    expect(reopened.getState().tray.pending_save?.key).toBe("row-1");
    expect(await reopened.setCount("a", 7)).toBe("frozen");
  });

  it("IDEMPOTENCY_KEY_REUSED drops the key and unfreezes; the next Confirm makes a new key", async () => {
    const { t, store } = await confirming();
    t.save.mockRejectedValueOnce(refusal(409, "IDEMPOTENCY_KEY_REUSED"));
    expect(await store.confirm("L")).toEqual({ kind: "key_reused" });
    expect(store.getState().tray.pending_save).toBeNull();
    expect(store.getState().tray.rows).toHaveLength(3);
    await store.confirm("L");
    expect(t.save.mock.calls[1]![0]).toMatchObject({
      idempotency_key: "row-2",
    });
  });

  it("REPLAY_OUTCOME_UNAVAILABLE unfreezes with the stale-save note", async () => {
    const { t, store } = await confirming();
    t.save.mockRejectedValueOnce(refusal(409, "REPLAY_OUTCOME_UNAVAILABLE"));
    expect(await store.confirm("L")).toEqual({ kind: "stale_save" });
    expect(store.getState().staleSaveNote).toBe(true);
    expect(store.getState().tray.pending_save).toBeNull();
    expect(store.getState().tray.rows).toHaveLength(3);
    store.dismissStaleSaveNote();
    expect(store.getState().staleSaveNote).toBe(false);
  });

  it("a 29-day-old pending_save is dropped on open, with the stale-save note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup({ now: () => Date.now() });
    t.storage.mem.set(trayKey("u1"), JSON.stringify(twoRows()));
    const store = await t.open();
    t.save.mockRejectedValueOnce(new TypeError("network"));
    await store.confirm("L1");

    vi.advanceTimersByTime(PENDING_SAVE_MAX_AGE_MS - DAY); // 28 days: still pending
    expect((await t.open()).getState().tray.pending_save).not.toBeNull();

    vi.advanceTimersByTime(DAY + 1000); // past 29 days
    const reopened = await t.open();
    expect(reopened.getState().tray.pending_save).toBeNull();
    expect(reopened.getState().staleSaveNote).toBe(true);
    expect(reopened.getState().tray.rows).toHaveLength(3);
    expect(
      JSON.parse(t.storage.mem.get(trayKey("u1"))!).pending_save
    ).toBeNull();
  });

  it("a retry of a 29-day-old save is not sent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup({ now: () => Date.now() });
    t.storage.mem.set(trayKey("u1"), JSON.stringify(twoRows()));
    const store = await t.open();
    t.save.mockRejectedValueOnce(new TypeError("network"));
    await store.confirm("L1");
    vi.advanceTimersByTime(PENDING_SAVE_MAX_AGE_MS + 1000);
    expect(await store.confirm("L1")).toEqual({ kind: "stale_save" });
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("DESTINATION_CHANGED keeps the rows, unfreezes and says the picker must reopen", async () => {
    const { t, store } = await confirming();
    await store.setLocation("L-old");
    t.save.mockRejectedValueOnce(
      refusal(409, "DESTINATION_CHANGED", { location_id: "L-old" })
    );
    expect(await store.confirm("L-old")).toEqual({
      kind: "destination_changed",
    });
    expect(store.getState().tray.rows).toHaveLength(3);
    expect(store.getState().tray.pending_save).toBeNull();
    expect(store.getState().tray.location_id).toBeNull();
  });

  it("EDITIONS_CHANGED marks exactly the listed rows needs_pick, including an Edition the catalog never had", async () => {
    const { t, store } = await confirming();
    t.save.mockRejectedValueOnce(
      refusal(409, "EDITIONS_CHANGED", {
        editions: [{ edition_id: "E2", printing_id: null }],
      })
    );
    expect(await store.confirm("L")).toEqual({
      kind: "editions_changed",
      rowIds: ["c"],
      searchRowIds: ["c"],
    });
    expect(store.getState().tray.rows.map((r) => [r.id, r.needs_pick])).toEqual(
      [
        ["a", false],
        ["b", false],
        ["c", true],
      ]
    );
    expect(store.getState().tray.pending_save).toBeNull();

    t.save.mockRejectedValueOnce(
      refusal(409, "EDITIONS_CHANGED", {
        editions: [{ edition_id: "E1", printing_id: "p-a" }],
      })
    );
    await store.setEdition("c", "E3"); // collector fixes the first one
    expect(await store.confirm("L")).toMatchObject({
      kind: "editions_changed",
      rowIds: ["a", "b"],
      searchRowIds: [],
    });
    expect(store.getState().tray.rows.map((r) => r.needs_pick)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("other definite refusals below 500 unfreeze with the code", async () => {
    const { t, store } = await confirming();
    t.save.mockRejectedValueOnce(refusal(422, "QUANTITY_OVERFLOW"));
    expect(await store.confirm("L")).toEqual({
      kind: "failed",
      code: "QUANTITY_OVERFLOW",
    });
    expect(store.getState().tray.pending_save).toBeNull();
  });

  it("an in-flight save that another tab already settled is left alone", async () => {
    const { t, store } = await confirming();
    t.save.mockImplementationOnce(async () => {
      t.storage.mem.set(
        trayKey("u1"),
        JSON.stringify(trayOf([row({ id: "n" })]))
      );
      throw refusal(409, "IDEMPOTENCY_KEY_REUSED");
    });
    await store.confirm("L");
    expect(
      JSON.parse(t.storage.mem.get(trayKey("u1"))!).rows.map(
        (r: TrayRow) => r.id
      )
    ).toEqual(["n"]);
  });
});
