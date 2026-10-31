import { expect, test, vi } from "vitest";
import { BorrowedMoveError } from "../collection_generated";
import { MoveError, commitMove } from "../moves_generated";
import {
  advance,
  createOperation,
  createRemoval,
  operationFor,
  undoProtectionUnconfirmed,
  type moveApi,
} from "./moveOperation";
const owned = [
  {
    source_id: "box",
    edition_id: "edition",
    quantity: "2",
    expected_version: 3,
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
function server(
  stage: "owned" | "borrowed",
  loss: "network" | "500" | "before" | "refused"
) {
  let failed = false;
  const applied = new Set<string>();
  const calls: string[] = [];
  let copies = 0;
  function commit(at: string, key: string, n: number) {
    calls.push(`${at}:${key}`);
    if (at === stage && !failed && (loss === "refused" || loss === "before")) {
      failed = true;
      if (loss === "refused")
        throw at === "owned"
          ? new MoveError(409, "STALE_HOLDING")
          : new BorrowedMoveError(409, "NOT_ENOUGH_BORROWED");
      throw new MoveError(500, "UNAVAILABLE");
    }
    if (!applied.has(key)) {
      applied.add(key);
      copies += n;
    }
    if (at === stage && !failed) {
      failed = true;
      if (loss === "network") throw new TypeError("lost response");
      throw at === "owned"
        ? new MoveError(500, "UNAVAILABLE")
        : new BorrowedMoveError(500, "UNAVAILABLE");
    }
  }
  const api: typeof moveApi = {
    startMove: async () => ({
      id: "manifest",
      source_id: null,
      expires_at: "later",
      item_count: 0,
    }),
    stageMove: async (id, items) => {
      expect(id).toBe("manifest");
      expect(items).toEqual(owned);
      return {
        id,
        source_id: null,
        expires_at: "later",
        item_count: items.length,
      };
    },
    moveBorrowedCopies: async (body) => {
      commit("borrowed", body.idempotency_key, 1);
      return { copy_count: "1", owner_revision: 2 };
    },
    removeInventory: async () => ({
      copy_count: "2",
      edition_count: 1,
      source_count: 1,
      already_at_destination_count: "0",
      owner_revision: 3,
    }),
    commitMove: async (
      id,
      _destination,
      key,
      _putAway = false,
      undo = true
    ) => {
      expect(id).toBe("manifest");
      commit("owned", key, 2);
      return {
        undo_id: undo ? "owned-undo" : null,
        copy_count: "2",
        edition_count: 1,
        source_count: 1,
        already_at_destination_count: "0",
        owner_revision: 3,
      };
    },
  };
  return { api, calls, applied, copies: () => copies };
}
for (const stage of ["borrowed", "owned"] as const)
  for (const loss of ["network", "500", "before"] as const)
    test(`${stage} ${loss} retries the frozen operation once even after selection changes`, async () => {
      const held = createOperation("dest", owned, borrowed);
      const fake = server(stage, loss);
      expect(await advance(held.op, held.state, fake.api)).toMatchObject({
        kind: "unknown",
        stage,
      });
      const resumed = operationFor(held, "elsewhere", [], []);
      expect(resumed).toBe(held);
      expect(await advance(resumed.op, resumed.state, fake.api)).toEqual({
        kind: "done",
      });
      expect(fake.copies()).toBe(3);
      expect(fake.applied.size).toBe(2);
      expect(fake.calls.filter((call) => call.startsWith(stage + ":"))).toEqual(
        [
          `${stage}:${stage === "owned" ? held.op.ownedKey : held.op.borrowedKey}`,
          `${stage}:${stage === "owned" ? held.op.ownedKey : held.op.borrowedKey}`,
        ]
      );
    });
for (const stage of ["borrowed", "owned"] as const)
  test(`definite ${stage} refusal stops at that stage`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server(stage, "refused");
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "refused",
      stage,
    });
    expect(fake.copies()).toBe(stage === "borrowed" ? 0 : 1);
  });
for (const only of ["borrowed", "owned"] as const)
  test(`${only}-only Move`, async () => {
    const held = createOperation(
      "dest",
      only === "owned" ? owned : [],
      only === "borrowed" ? borrowed : []
    );
    const fake = server(only === "owned" ? "borrowed" : "owned", "network");
    expect(await advance(held.op, held.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(fake.applied.size).toBe(1);
  });

test("Removal keeps its owned record after a lost response and resumes before a new Move", async () => {
  const held = createRemoval(owned);
  const fake = server("borrowed", "network");
  const applied = new Set<string>();
  let lost = false;
  fake.api.removeInventory = async (_manifest, key) => {
    applied.add(key);
    if (!lost) {
      lost = true;
      throw new TypeError("lost response");
    }
    return {
      copy_count: "2",
      edition_count: 1,
      source_count: 1,
      already_at_destination_count: "0",
      owner_revision: 3,
    };
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  const resumed = operationFor(held, "new-destination", [], borrowed);
  expect(resumed).toBe(held);
  expect(await advance(resumed.op, resumed.state, fake.api)).toEqual({
    kind: "done",
  });
  expect([...applied]).toEqual([held.op.ownedKey]);
});

for (const stage of ["borrowed", "owned"] as const)
  for (const code of ["MOVE_MANIFEST_NOT_FOUND", "REPLAY_OUTCOME_UNAVAILABLE"])
    test(`${stage} receipt ${code} remains unknown after a lost commit response`, async () => {
      const held = createOperation("dest", owned, borrowed);
      const fake = server(stage, "network");
      expect(await advance(held.op, held.state, fake.api)).toMatchObject({
        kind: "unknown",
        stage,
      });
      const keys = [held.op.borrowedKey, held.op.ownedKey];
      if (stage === "owned")
        fake.api.commitMove = async () => {
          throw new MoveError(
            code === "MOVE_MANIFEST_NOT_FOUND" ? 404 : 409,
            code
          );
        };
      else
        fake.api.moveBorrowedCopies = async () => {
          throw new BorrowedMoveError(
            code === "MOVE_MANIFEST_NOT_FOUND" ? 404 : 409,
            code
          );
        };
      for (let retry = 0; retry < 2; retry++) {
        expect(await advance(held.op, held.state, fake.api)).toMatchObject({
          kind: "unknown",
          stage,
        });
        expect(held.state[stage]).toBe("unknown");
        expect(operationFor(held, "another", [], [])).toBe(held);
        expect([held.op.borrowedKey, held.op.ownedKey]).toEqual(keys);
      }
      expect(fake.copies()).toBe(stage === "owned" ? 3 : 1);
    });

test("a manifest refusal before any commit attempt remains definite", async () => {
  const held = createOperation("dest", owned, []);
  const fake = server("borrowed", "network");
  fake.api.stageMove = async () => {
    throw new MoveError(404, "MOVE_MANIFEST_NOT_FOUND");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "refused",
    stage: "owned",
  });
  expect(held.state.ownedAttempted).toBe(false);
});

test("owned copies already at the target stay while borrowed copies move without an owned manifest", async () => {
  const held = createOperation("box", owned, [
    { ...borrowed[0], from_location_id: "unsorted" },
  ]);
  const fake = server("owned", "network");
  fake.api.startMove = async () => {
    throw new Error("No owned manifest should be created");
  };
  expect(held.op.owned).toEqual([]);
  expect(held.op.stayed).toBe(2);
  expect(await advance(held.op, held.state, fake.api)).toEqual({
    kind: "done",
  });
  expect(held.state.owned).toBe("done");
  expect(held.state.ownedAttempted).toBe(false);
  expect(held.state.borrowedResult?.copy_count).toBe("1");
  expect(fake.calls).toEqual([`borrowed:${held.op.borrowedKey}`]);
});

test("owned-only Moves retain Undo even when some owned copies stay", async () => {
  const held = createOperation(
    "other",
    [...owned, { ...owned[0], source_id: "other", quantity: "3" }],
    []
  );
  const fake = server("borrowed", "network");
  expect(held.op.stayed).toBe(3);
  expect(held.op.noUndo).toBe(false);
  expect(await advance(held.op, held.state, fake.api)).toEqual({
    kind: "done",
  });
});

test("an unavailable outcome is unknown even on the first received reply", async () => {
  const held = createOperation("dest", owned, borrowed);
  const fake = server("borrowed", "network");
  fake.api.moveBorrowedCopies = async () => ({
    copy_count: "1",
    owner_revision: 2,
  });
  fake.api.commitMove = async () => {
    throw new MoveError(409, "REPLAY_OUTCOME_UNAVAILABLE");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  expect(held.state.owned).toBe("unknown");
});

test("supported mixed Move sends undo:false and creates no cleanup work", async () => {
  const held = createOperation("dest", owned, borrowed);
  const fake = server("owned", "network");
  const commit = vi.fn(fake.api.commitMove);
  const dismissUndo = vi.fn();
  const api = { ...fake.api, commitMove: commit, dismissUndo };
  expect(await advance(held.op, held.state, api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  expect(await advance(held.op, held.state, api)).toEqual({ kind: "done" });
  expect(commit.mock.calls).toEqual([
    ["manifest", "dest", held.op.ownedKey, false, false],
    ["manifest", "dest", held.op.ownedKey, false, false],
  ]);
  expect(held.state.ownedResult?.undo_id).toBeNull();
  expect(dismissUndo).not.toHaveBeenCalled();
});

test("owned-only Move uses the default request and keeps its Undo", async () => {
  const held = createOperation("dest", owned, []);
  const fake = server("borrowed", "network");
  const commit = vi.fn(fake.api.commitMove);
  expect(
    await advance(held.op, held.state, { ...fake.api, commitMove: commit })
  ).toEqual({ kind: "done" });
  expect(commit).toHaveBeenCalledExactlyOnceWith(
    "manifest",
    "dest",
    held.op.ownedKey
  );
  expect(held.state.ownedResult?.undo_id).toBe("owned-undo");
});

test("an unexpected old-server Undo receipt never completes the operation or triggers a cleanup guarantee", async () => {
  const held = createOperation("dest", owned, borrowed);
  const fake = server("owned", "network");
  const commit = vi.fn(async () => ({
    undo_id: "old-server-record",
    copy_count: "2",
    edition_count: 1,
    source_count: 1,
    already_at_destination_count: "0",
    owner_revision: 3,
  }));
  const dismissUndo = vi.fn();
  const api = { ...fake.api, commitMove: commit, dismissUndo };
  for (let retry = 0; retry < 2; retry++) {
    expect(await advance(held.op, held.state, api)).toMatchObject({
      kind: "unknown",
      stage: "owned",
    });
    expect(operationFor(held, "other", [], [])).toBe(held);
  }
  expect(commit).toHaveBeenCalledTimes(1);
  expect(dismissUndo).not.toHaveBeenCalled();
  expect(undoProtectionUnconfirmed(held)).toBe(true);
});

test("generated Move requests keep legacy bodies and send undo only when false", async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return Response.json({
      copy_count: "1",
      edition_count: 1,
      source_count: 1,
      already_at_destination_count: "0",
      owner_revision: 2,
      undo_id: null,
    });
  });
  try {
    await commitMove("manifest", "dest", "key");
    await commitMove("manifest", "dest", "key", false, true);
    await commitMove("manifest", "dest", "key", true);
    await commitMove("manifest", "dest", "key", false, false);
    expect(bodies).toEqual([
      '{"destination_id":"dest","idempotency_key":"key"}',
      '{"destination_id":"dest","idempotency_key":"key"}',
      '{"destination_id":"dest","idempotency_key":"key","put_away":true}',
      '{"destination_id":"dest","idempotency_key":"key","undo":false}',
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("confirmed new-server null receipt and owned-only records do not block normal Undo offers", async () => {
  const mixed = createOperation("dest", owned, borrowed);
  const normal = createOperation("dest", owned, []);
  const fake = server("borrowed", "network");
  fake.api.moveBorrowedCopies = async () => ({
    copy_count: "1",
    owner_revision: 2,
  });
  expect(await advance(mixed.op, mixed.state, fake.api)).toEqual({
    kind: "done",
  });
  expect(await advance(normal.op, normal.state, fake.api)).toEqual({
    kind: "done",
  });
  expect(undoProtectionUnconfirmed(mixed)).toBe(false);
  expect(undoProtectionUnconfirmed(normal)).toBe(false);
});
