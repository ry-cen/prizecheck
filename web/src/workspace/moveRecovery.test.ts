import { afterEach, expect, test, vi } from "vitest";
import {
  advance,
  createOperation,
  PENDING_MOVE_MAX_AGE_MS,
  RecoveryBlocked,
  type moveApi,
} from "./moveOperation";
import {
  mergePending,
  pendingMoves,
  pendingMovePrefix,
  TERMINAL_RETENTION_MS,
} from "./pendingMove";
import {
  MoveInAnotherTab,
  MoveLocksUnavailable,
  MoveServerClock,
  withMoveWriter,
  moveWriterBusy,
  type MoveLocks,
} from "./moveRecovery";
import { MoveError } from "../moves_generated";
const SERVER = Date.parse("2026-10-31T20:00:00Z");
const owned = [
  {
    source_id: "box",
    edition_id: "edition",
    quantity: "2",
    expected_version: 1,
  },
];
const borrowed = [
  {
    loan_id: "loan",
    edition_id: "edition",
    from_location_id: "box",
    quantity: "1",
  },
];
function disk(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
function locks() {
  const held = new Set<string>();
  const manager = {
    async request(
      name: string,
      _options: LockOptions,
      work: (lock: Lock | null) => Promise<unknown>
    ) {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return {
        held: [...held].map((name) => ({ name, mode: "exclusive" })),
        pending: [],
      };
    },
  } as unknown as MoveLocks;
  return { manager, closeOwner: () => held.clear() };
}
const responseAt = (value: number) =>
  new Response(null, { headers: { date: new Date(value).toUTCString() } });
function backend() {
  const receipts = new Map<string, object>();
  let applications = 0,
    lose = true;
  const api: typeof moveApi = {
    moveBorrowedCopies: vi.fn(async () => ({
      copy_count: "1",
      owner_revision: 2,
    })),
    startMove: vi.fn(async () => ({
      id: "original",
      source_id: null,
      item_count: 0,
      expires_at: "later",
    })),
    stageMove: vi.fn(async () => ({
      id: "original",
      source_id: null,
      item_count: 1,
      expires_at: "later",
    })),
    commitMoveWithoutUndo: vi.fn(async (_manifest, _destination, key) => {
      if (!receipts.has(key)) {
        applications++;
        receipts.set(key, {});
      }
      if (lose) {
        lose = false;
        throw new TypeError("receipt lost after commit");
      }
      return {
        copy_count: "2",
        edition_count: 1,
        source_count: 1,
        already_at_destination_count: "0",
        owner_revision: 3,
        undo_id: null,
      };
    }),
    commitMove: vi.fn(),
    removeInventory: vi.fn(),
  };
  return { api, applications: () => applications };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("reviewer (a): an older tab adopts the consumed manifest and replays the same owned key", async () => {
  const shared = disk(),
    a = pendingMoves("A", shared, disk()),
    b = pendingMoves("A", shared, disk()),
    lock = locks(),
    fake = backend();
  const held = createOperation("dest", owned, borrowed, SERVER);
  a.save(held);
  const stale = b.load()!;
  await withMoveWriter(
    "A",
    async () => {
      expect(
        await advance(held.op, held.state, fake.api, () => a.save(held))
      ).toMatchObject({ kind: "unknown" });
    },
    lock.manager
  );
  expect(stale.state.manifestId).toBeNull();
  expect(stale.state.ownedAttempted).toBe(false);
  await withMoveWriter(
    "A",
    async () => {
      const latest = b.load()!;
      expect(latest.state.manifestId).toBe("original");
      expect(latest.state.ownedAttempted).toBe(true);
      expect(
        await advance(latest.op, latest.state, fake.api, () => b.save(latest))
      ).toEqual({ kind: "done" });
      b.remove(latest, "done", SERVER + 1000);
    },
    lock.manager
  );
  expect(fake.api.startMove).toHaveBeenCalledTimes(1);
  expect(fake.applications()).toBe(1);
  expect(vi.mocked(fake.api.commitMoveWithoutUndo).mock.calls).toEqual([
    ["original", "dest", held.op.ownedKey],
    ["original", "dest", held.op.ownedKey],
  ]);
  expect(a.load()).toBeNull();
  expect(b.load()).toBeNull();
});

test("reviewer (b): a stale snapshot cannot erase an attempt or turn rollback 404 into terminal refusal", async () => {
  const shared = disk(),
    a = pendingMoves("A", shared, disk()),
    b = pendingMoves("A", shared, disk()),
    lock = locks(),
    fake = backend();
  const held = createOperation("dest", owned, borrowed, SERVER);
  a.save(held);
  const stale = b.load()!;
  await withMoveWriter(
    "A",
    () => advance(held.op, held.state, fake.api, () => a.save(held)),
    lock.manager
  );
  b.save(stale); // Even a stale write cannot downgrade flags, preparation or manifest identity.
  expect(stale.state.ownedAttempted).toBe(true);
  expect(stale.state.manifestId).toBe("original");
  fake.api.commitMoveWithoutUndo = vi.fn(async () => {
    throw new MoveError(404, "MOVE_REQUEST_FAILED");
  });
  await withMoveWriter(
    "A",
    async () => {
      const latest = b.load()!;
      expect(
        await advance(latest.op, latest.state, fake.api, () => b.save(latest))
      ).toMatchObject({ kind: "unknown" });
      expect(latest.state.refusal).toBeUndefined();
      expect(() => b.remove(latest, "done", SERVER)).toThrow(RecoveryBlocked);
    },
    lock.manager
  );
  expect(a.load()?.state.ownedAttempted).toBe(true);
  expect(a.load()?.state.owned).toBe("unknown");
});

test("a stale replacement manifest or changed command is rejected before it can overwrite recovery", () => {
  const shared = disk(),
    store = pendingMoves("A", shared, disk()),
    held = createOperation("dest", owned, borrowed, SERVER);
  store.save(held);
  const stale = structuredClone(held);
  held.state.manifestId = "original";
  held.state.manifestAttempted = true;
  store.save(held);
  stale.state.manifestId = "replacement";
  expect(() => store.save(stale)).toThrow(RecoveryBlocked);
  expect(store.load()?.state.manifestId).toBe("original");
  expect(() =>
    mergePending(held, { ...held, op: { ...held.op, ownedKey: "new-key" } })
  ).toThrow(RecoveryBlocked);
});

test("receipts and known outcomes survive a stale unknown snapshot", () => {
  const held = createOperation("dest", owned, borrowed, SERVER),
    stale = structuredClone(held);
  held.state.borrowedAttempted = true;
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  const merged = mergePending(held, stale);
  expect(merged.state.borrowed).toBe("done");
  expect(merged.state.borrowedResult).toEqual(held.state.borrowedResult);
  expect(merged.state.borrowedAttempted).toBe(true);
});

test("a different HTTP attempt cannot forge a first-attempt refusal", () => {
  const held = createOperation("dest", owned, borrowed, SERVER);
  held.state.manifestId = "original";
  held.state.ownedAttempted = true;
  held.state.owned = "unknown";
  held.state.ownedFirstAttempt = "first";
  held.state.ownedAttempt = "retry";
  const stale = structuredClone(held);
  stale.state.ownedAttempted = false;
  stale.state.owned = "refused";
  stale.state.refusal = {
    stage: "owned",
    status: 404,
    code: "MOVE_REQUEST_FAILED",
    attemptId: "first",
  };
  expect(() => mergePending(held, stale)).toThrow(RecoveryBlocked);
});

test("concurrent Check Move gets one writer, and the next reader acknowledges the completed receipt", async () => {
  const lock = locks(),
    shared = disk(),
    a = pendingMoves("A", shared, disk()),
    b = pendingMoves("A", shared, disk());
  const held = createOperation("dest", [], borrowed, SERVER);
  a.save(held);
  b.load();
  let release!: () => void,
    entered!: () => void,
    posts = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withMoveWriter(
    "A",
    async () => {
      const latest = a.load()!;
      posts++;
      entered();
      await wait;
      latest.state.borrowedAttempted = true;
      latest.state.borrowed = "done";
      latest.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
      a.save(latest);
      a.remove(latest, "done", SERVER);
    },
    lock.manager
  );
  await ready;
  await expect(
    withMoveWriter(
      "A",
      async () => {
        posts++;
      },
      lock.manager
    )
  ).rejects.toBeInstanceOf(MoveInAnotherTab);
  release();
  await first;
  await withMoveWriter(
    "A",
    async () => {
      expect(b.load()).toBeNull();
    },
    lock.manager
  );
  expect(posts).toBe(1);
});

test("closing the owner releases the Web Lock and another tab adopts the persisted operation", async () => {
  const lock = locks(),
    shared = disk(),
    a = pendingMoves("A", shared, disk()),
    b = pendingMoves("A", shared, disk());
  const held = createOperation("dest", owned, borrowed, SERVER);
  a.save(held);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  void withMoveWriter(
    "A",
    async () => {
      entered();
      await new Promise<void>(() => {});
    },
    lock.manager
  );
  await ready;
  expect(await moveWriterBusy("A", lock.manager)).toBe(true);
  lock.closeOwner();
  await withMoveWriter(
    "A",
    async () => {
      expect(b.load()?.op).toEqual(held.op);
    },
    lock.manager
  );
  expect(await moveWriterBusy("A", lock.manager)).toBe(false);
});

test("Web Locks unavailable fails closed", async () => {
  vi.stubGlobal("navigator", {});
  const work = vi.fn();
  await expect(withMoveWriter("A", work)).rejects.toBeInstanceOf(
    MoveLocksUnavailable
  );
  expect(work).not.toHaveBeenCalled();
});

test("shared terminal markers clear other tabs' witnesses, while unexplained disappearance blocks", () => {
  const shared = disk(),
    witnessA = disk(),
    witnessB = disk();
  const a = pendingMoves("A", shared, witnessA),
    b = pendingMoves("A", shared, witnessB),
    held = createOperation("dest", [], borrowed, SERVER);
  a.save(held);
  b.load();
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  a.save(held);
  a.remove(held, "done", SERVER);
  expect(b.load()).toBeNull();
  expect(
    JSON.parse(witnessB.getItem(pendingMovePrefix("A") + "witness")!)
  ).toEqual([]);
  const another = createOperation("dest", owned, borrowed, SERVER);
  a.save(another);
  b.load();
  shared.removeItem(pendingMovePrefix("A") + another.op.id);
  expect(() => b.load()).toThrow(RecoveryBlocked);
});

test("terminal markers prune only after seven days of trusted time", () => {
  const shared = disk(),
    store = pendingMoves("A", shared, disk()),
    held = createOperation("dest", [], [], SERVER);
  // noUndo is normally set by selection; this fixture represents a completed persisted mixed operation.
  const complete = { ...held, op: { ...held.op, noUndo: true } };
  store.save(complete);
  store.remove(complete, "done", SERVER);
  store.prune(SERVER + TERMINAL_RETENTION_MS - 1);
  expect(shared.length).toBe(1);
  store.prune(SERVER + TERMINAL_RETENTION_MS);
  expect(shared.length).toBe(0);
});

test("26 hours of server age cannot be hidden by a 24-hour client clock rollback", () => {
  const held = createOperation("dest", owned, borrowed, SERVER),
    clock = new MoveServerClock(() => 0);
  vi.spyOn(Date, "now").mockReturnValue(held.op.createdAt + 2 * 60 * 60 * 1000);
  expect(() =>
    clock.check(held, responseAt(SERVER + 26 * 60 * 60 * 1000))
  ).toThrow(RecoveryBlocked);
});

test("active-tab age uses monotonic elapsed time even if subsequent Date samples go backwards", () => {
  let elapsed = 0;
  const clock = new MoveServerClock(() => elapsed),
    held = createOperation("dest", owned, borrowed, SERVER);
  clock.check(held, responseAt(SERVER));
  elapsed += 26 * 60 * 60 * 1000;
  expect(() => clock.check(held, responseAt(SERVER))).toThrow(RecoveryBlocked);
});

test("fresh trusted responses establish time independently of Date.now", () => {
  let mono = 0;
  const clock = new MoveServerClock(() => mono),
    held = createOperation("dest", owned, borrowed, SERVER);
  vi.spyOn(Date, "now").mockReturnValue(-100000);
  clock.check(held, responseAt(SERVER));
  mono += 10000;
  expect(clock.check(held, responseAt(SERVER + 10000))).toBe(SERVER + 10000);
});

for (const header of [null, "bad-date"])
  test(`unreadable server Date (${header}) blocks rather than trusting the browser clock`, () => {
    const clock = new MoveServerClock(() => 0),
      held = createOperation("dest", owned, borrowed, SERVER);
    expect(() =>
      clock.check(
        held,
        new Response(null, { headers: header ? { date: header } : {} })
      )
    ).toThrow(RecoveryBlocked);
  });

test("request elapsed time counts toward the conservative age upper bound", () => {
  const held = createOperation("dest", owned, borrowed, SERVER),
    clock = new MoveServerClock(() => 10000);
  expect(() =>
    clock.check(held, responseAt(SERVER + PENDING_MOVE_MAX_AGE_MS - 5000), 0)
  ).toThrow(RecoveryBlocked);
});

test("old recovery without trusted creation time is retained for manual review", () => {
  const shared = disk(),
    store = pendingMoves("A", shared, disk()),
    held = createOperation("dest", owned, borrowed);
  store.save(held);
  expect(store.load()?.state.blocked).toBe(true);
  expect(shared.length).toBe(1);
});

test("long response latency yields a conservative age without rejecting a later forward server sample", () => {
  let mono = 10000;
  const clock = new MoveServerClock(() => mono),
    held = createOperation("dest", owned, borrowed, SERVER);
  expect(clock.check(held, responseAt(SERVER), 0)).toBe(SERVER + 10000);
  mono += 1000;
  expect(clock.check(held, responseAt(SERVER + 1000))).toBe(SERVER + 11000);
});

test("a server sample before trusted creation cannot authorize a retry", () => {
  const held = createOperation("dest", owned, borrowed, SERVER),
    clock = new MoveServerClock(() => 0);
  expect(() =>
    clock.check(held, responseAt(SERVER - 24 * 60 * 60 * 1000))
  ).toThrow(RecoveryBlocked);
});

test("a witness returning after terminal retention expires still requires manual review", () => {
  const shared = disk(),
    a = pendingMoves("A", shared, disk()),
    b = pendingMoves("A", shared, disk());
  const held = createOperation("dest", [], borrowed, SERVER);
  a.save(held);
  b.load();
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  a.save(held);
  a.remove(held, "done", SERVER);
  a.prune(SERVER + TERMINAL_RETENTION_MS);
  expect(() => b.load()).toThrow(RecoveryBlocked);
});

test("reviewing unreadable data preserves other readable operations and their receipts", () => {
  const shared = disk(),
    store = pendingMoves("A", shared, disk()),
    held = createOperation("dest", owned, borrowed, SERVER);
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  store.save(held);
  shared.setItem(pendingMovePrefix("A") + "broken", "{");
  store.dismissUnreadable(SERVER);
  expect(store.load()?.state.borrowedResult).toEqual(held.state.borrowedResult);
  expect(store.load()?.op.ownedKey).toBe(held.op.ownedKey);
});
