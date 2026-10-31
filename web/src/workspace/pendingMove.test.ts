import { afterEach, expect, test, vi } from "vitest";
import {
  advance,
  createOperation,
  PENDING_MOVE_MAX_AGE_MS,
  RecoveryBlocked,
  type HeldOperation,
  type moveApi,
} from "./moveOperation";
import { pendingMoves, pendingMovePrefix, recoveryText } from "./pendingMove";
import { MoveServerClock } from "./moveRecovery";
const SERVER_TIME = Date.parse("2026-10-31T20:00:00Z");
import { MoveError } from "../moves_generated";

export function memoryStorage(): Storage {
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
const owned = [
  {
    source_id: "source",
    edition_id: "edition",
    quantity: "2",
    expected_version: 1,
  },
];
const borrowed = [
  {
    loan_id: "loan",
    edition_id: "edition",
    from_location_id: "source",
    quantity: "1",
  },
];
function backend() {
  const receipts = new Map<string, unknown>();
  let applied = 0;
  const manifest = {
    id: "manifest",
    source_id: null,
    expires_at: "later",
    item_count: 1,
  };
  const api: typeof moveApi = {
    startMove: vi.fn(async () => manifest),
    stageMove: vi.fn(async () => manifest),
    moveBorrowedCopies: vi.fn(async (body) => {
      if (!receipts.has(body.idempotency_key)) {
        applied++;
        receipts.set(body.idempotency_key, true);
      }
      return { copy_count: "1", owner_revision: 2 };
    }),
    commitMoveWithoutUndo: vi.fn(async (_id, _to, key) => {
      if (!receipts.has(key)) {
        applied++;
        receipts.set(key, true);
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
  return { api, applied: () => applied };
}
afterEach(() => vi.useRealTimers());

for (const boundary of [
  "borrowed sent",
  "borrowed confirmed",
  "manifest",
  "staged",
  "owned sent",
  "owned confirmed",
])
  test(`reload at ${boundary} restores the operation without minting keys`, async () => {
    const disk = memoryStorage(),
      witness = memoryStorage();
    const store = pendingMoves("A", disk, witness),
      held = createOperation("dest", owned, borrowed, SERVER_TIME),
      fake = backend();
    store.save(held);
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let paused = false;
    const matches = () =>
      boundary === "borrowed sent"
        ? held.state.borrowedAttempted && held.state.borrowed !== "done"
        : boundary === "borrowed confirmed"
          ? held.state.borrowed === "done" && !held.state.manifestId
          : boundary === "manifest"
            ? !!held.state.manifestId && !held.state.staged
            : boundary === "staged"
              ? held.state.staged && !held.state.ownedAttempted
              : boundary === "owned sent"
                ? held.state.ownedAttempted && held.state.owned !== "done"
                : held.state.owned === "done";
    void advance(held.op, held.state, fake.api, () => {
      store.save(held);
      if (!paused && matches()) {
        paused = true;
        reached();
        return new Promise<void>(() => {});
      }
    });
    await ready;
    const restoredStore = pendingMoves("A", disk, witness);
    const restored = restoredStore.load()!;
    restoredStore.adopt();
    expect(restored.op).toEqual(held.op);
    expect(
      await advance(restored.op, restored.state, fake.api, () =>
        restoredStore.save(restored)
      )
    ).toEqual({ kind: "done" });
    expect(fake.applied()).toBe(2);
    expect(restored.state.ownedResult?.undo_id).toBeNull();
  });

for (const stage of ["borrowed", "owned"] as const)
  test(`${stage} response lost after commit replays the original key after reload exactly once`, async () => {
    const disk = memoryStorage(),
      witness = memoryStorage(),
      held = createOperation("dest", owned, borrowed, SERVER_TIME),
      fake = backend();
    const store = pendingMoves("A", disk, witness);
    store.save(held);
    const originalBorrowed = fake.api.moveBorrowedCopies,
      originalOwned = fake.api.commitMoveWithoutUndo;
    if (stage === "borrowed")
      fake.api.moveBorrowedCopies = async (body) => {
        await originalBorrowed(body);
        throw new TypeError("lost");
      };
    else
      fake.api.commitMoveWithoutUndo = async (...args) => {
        await originalOwned(...args);
        throw new TypeError("lost");
      };
    expect(
      await advance(held.op, held.state, fake.api, () => store.save(held))
    ).toMatchObject({ kind: "unknown", stage });
    const restored = pendingMoves("A", disk, witness).load()!;
    expect(restored.op.borrowedKey).toBe(held.op.borrowedKey);
    expect(restored.op.ownedKey).toBe(held.op.ownedKey);
    if (stage === "owned")
      expect(recoveryText(restored, "Box", false)).toContain(
        "Moved 1 borrowed copy to Box"
      );
    fake.api.moveBorrowedCopies = originalBorrowed;
    fake.api.commitMoveWithoutUndo = originalOwned;
    expect(await advance(restored.op, restored.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(fake.applied()).toBe(2);
  });

test("accounts cannot read or dismiss each other's records; signing back in restores A", () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME);
  const a = pendingMoves("A", disk, witness);
  a.save(held);
  const b = pendingMoves("B", disk, witness);
  expect(b.load()).toBeNull();
  b.dismissUnreadable(SERVER_TIME);
  expect(pendingMoves("A", disk, witness).load()?.op).toEqual(held.op);
});

test("storage deletion blocks the live operation and reload without recreating its record", () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME);
  const store = pendingMoves("A", disk, witness);
  store.save(held);
  disk.clear();
  expect(() => store.save(held)).toThrow(RecoveryBlocked);
  expect(() => pendingMoves("A", disk, witness).load()).toThrow(
    RecoveryBlocked
  );
  expect(disk.length).toBe(0);
});

test("unreadable data is retained and blocks fresh writes until reviewed", () => {
  const disk = memoryStorage(),
    witness = memoryStorage();
  disk.setItem(pendingMovePrefix("A") + "broken", "{");
  const store = pendingMoves("A", disk, witness);
  expect(() => store.load()).toThrow();
  expect(disk.length).toBe(1);
  store.dismissUnreadable(SERVER_TIME);
  expect(store.load()).toBeNull();
});

test("quota failure persists nothing and prevents any inventory POST", async () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  disk.setItem = () => {
    throw new Error("quota");
  };
  const store = pendingMoves("A", disk, witness);
  expect(
    await advance(held.op, held.state, fake.api, () => {
      try {
        store.save(held);
      } catch {
        throw new RecoveryBlocked();
      }
    })
  ).toMatchObject({ kind: "unknown" });
  expect(held.state.blocked).toBe(true);
  expect(fake.applied()).toBe(0);
});

test("past the conservative receipt cutoff fresh server time blocks without any new POST or key", async () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  const store = pendingMoves("A", disk, witness);
  store.save(held);
  const restored = store.load()!,
    clock = new MoveServerClock(() => 0);
  const response = new Response(null, {
    headers: {
      date: new Date(SERVER_TIME + PENDING_MOVE_MAX_AGE_MS).toUTCString(),
    },
  });
  expect(
    await advance(restored.op, restored.state, fake.api, () => {
      clock.check(restored, response);
      store.save(restored);
    })
  ).toMatchObject({ kind: "unknown" });
  expect(restored.state.blocked).toBe(true);
  expect(fake.applied()).toBe(0);
  expect(fake.api.startMove).not.toHaveBeenCalled();
  expect(restored.op.ownedKey).toBe(held.op.ownedKey);
  expect(recoveryText(restored, "Box", true)).toContain(
    "Check the source and destination Location contents"
  );
});

test("an unrecorded owned outcome after a prior attempt blocks instead of rebuilding its manifest", async () => {
  const held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  held.state.manifestId = "original";
  held.state.staged = true;
  held.state.ownedAttempted = true;
  fake.api.commitMoveWithoutUndo = async () => {
    throw new MoveError(404, "MOVE_MANIFEST_NOT_FOUND");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
  });
  expect(held.state.blocked).toBe(true);
  expect(fake.api.startMove).not.toHaveBeenCalled();
});

test("a preparation refusal before any owned commit is known and preserves borrowed progress", async () => {
  const held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  fake.api.stageMove = async () => {
    throw new MoveError(404, "MOVE_MANIFEST_NOT_FOUND");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "refused",
    stage: "owned",
  });
  expect(held.state.ownedAttempted).toBe(false);
  expect(held.state.borrowedResult?.copy_count).toBe("1");
  expect(fake.api.commitMoveWithoutUndo).not.toHaveBeenCalled();
});

test("a lost manifest-start response never causes a replacement manifest on recovery", async () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  const store = pendingMoves("A", disk, witness);
  store.save(held);
  fake.api.startMove = vi.fn(async () => {
    throw new TypeError("lost manifest response");
  });
  expect(
    await advance(held.op, held.state, fake.api, () => store.save(held))
  ).toMatchObject({ kind: "unknown" });
  const restored = store.load()!;
  expect(restored.state.blocked).toBe(true);
  expect(restored.state.ownedAttempted).toBe(false);
  expect(await advance(restored.op, restored.state, fake.api)).toMatchObject({
    kind: "unknown",
  });
  expect(fake.api.startMove).toHaveBeenCalledTimes(1);
  expect(fake.api.commitMoveWithoutUndo).not.toHaveBeenCalled();
});

test("a disabled session witness also fails closed before any inventory write", async () => {
  const disk = memoryStorage(),
    witness = memoryStorage(),
    held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  witness.setItem = () => {
    throw new Error("disabled");
  };
  const store = pendingMoves("A", disk, witness);
  expect(
    await advance(held.op, held.state, fake.api, () => {
      try {
        store.save(held);
      } catch {
        throw new RecoveryBlocked();
      }
    })
  ).toMatchObject({ kind: "unknown" });
  expect(fake.applied()).toBe(0);
  expect(disk.length).toBe(0);
});

test("a first request-validation 422 is a known non-mutating refusal", async () => {
  const held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  fake.api.commitMoveWithoutUndo = async () => {
    throw new MoveError(422, "MOVE_REQUEST_FAILED");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "refused",
    stage: "owned",
  });
  expect(held.state.owned).toBe("refused");
  expect(held.state.borrowedResult?.copy_count).toBe("1");
});

test("a documented refusal after an uncertain commit cannot erase uncertainty", async () => {
  const held = createOperation("dest", owned, borrowed, SERVER_TIME),
    fake = backend();
  fake.api.commitMoveWithoutUndo = async () => {
    throw new TypeError("lost");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
  });
  fake.api.commitMoveWithoutUndo = async () => {
    throw new MoveError(409, "STALE_HOLDING");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  expect(held.state.refusal).toBeUndefined();
  expect(fake.api.startMove).toHaveBeenCalledTimes(1);
});
