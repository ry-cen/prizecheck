import { expect, test, vi } from "vitest";
import { BorrowedMoveError } from "../collection_generated";
import {
  MoveError,
  commitMove,
  commitMoveWithoutUndo,
} from "../moves_generated";
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
  loss: "network" | "timeout" | "500" | "before" | "refused"
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
      if (loss === "timeout")
        throw new DOMException("timed out", "TimeoutError");
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
    commitMoveWithoutUndo: async () => {
      throw new Error("not initialized");
    },
    commitMove: async (id, _destination, key) => {
      expect(id).toBe("manifest");
      commit("owned", key, 2);
      return {
        undo_id: "owned-undo",
        copy_count: "2",
        edition_count: 1,
        source_count: 1,
        already_at_destination_count: "0",
        owner_revision: 3,
      };
    },
  };
  api.commitMoveWithoutUndo = async (id, destination, key) => ({
    ...(await api.commitMove(id, destination, key)),
    undo_id: null,
  });
  return { api, calls, applied, copies: () => copies };
}
for (const stage of ["borrowed", "owned"] as const)
  for (const loss of ["network", "timeout", "500", "before"] as const)
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
  test(`${stage} documented first-attempt refusal stops before further writes`, async () => {
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
        fake.api.commitMoveWithoutUndo = async () => {
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
  fake.api.commitMoveWithoutUndo = async () => {
    throw new MoveError(409, "REPLAY_OUTCOME_UNAVAILABLE");
  };
  expect(await advance(held.op, held.state, fake.api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  expect(held.state.owned).toBe("unknown");
});

test("supported mixed Move uses the dedicated route on first attempt and replay", async () => {
  const held = createOperation("dest", owned, borrowed);
  const fake = server("owned", "network");
  const commit = vi.fn(fake.api.commitMoveWithoutUndo);
  const dismissUndo = vi.fn();
  const api = { ...fake.api, commitMoveWithoutUndo: commit, dismissUndo };
  expect(await advance(held.op, held.state, api)).toMatchObject({
    kind: "unknown",
    stage: "owned",
  });
  expect(await advance(held.op, held.state, api)).toEqual({ kind: "done" });
  expect(commit.mock.calls).toEqual([
    ["manifest", "dest", held.op.ownedKey],
    ["manifest", "dest", held.op.ownedKey],
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

test("an unexpected non-null Undo receipt never completes the operation or triggers a cleanup guarantee", async () => {
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
  const api = { ...fake.api, commitMoveWithoutUndo: commit, dismissUndo };
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

test("generated Move requests preserve normal bodies and isolate the strict route", async () => {
  const bodies: string[] = [];
  const urls: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    urls.push(_input);
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
    await commitMove("manifest", "dest", "key", true);
    await commitMoveWithoutUndo("manifest", "dest", "key");
    expect(urls).toEqual([
      "/api/moves/manifests/manifest/commit",
      "/api/moves/manifests/manifest/commit",
      "/api/moves/manifests/manifest/commit-without-undo",
    ]);
    expect(bodies).toEqual([
      '{"destination_id":"dest","idempotency_key":"key"}',
      '{"destination_id":"dest","idempotency_key":"key","put_away":true}',
      '{"destination_id":"dest","idempotency_key":"key"}',
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

for (const status of [404, 405])
  test(`an old or rolled-back API ${status} refuses the owned write while preserving borrowed progress`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("owned", "network");
    const normal = vi.spyOn(fake.api, "commitMove");
    fake.api.commitMoveWithoutUndo = vi.fn(async () => {
      throw new MoveError(status, "MOVE_REQUEST_FAILED");
    });
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "refused",
      stage: "owned",
    });
    expect(fake.copies()).toBe(1);
    expect(held.state.borrowedResult?.copy_count).toBe("1");
    expect(held.state.ownedResult).toBeUndefined();
    expect(normal).not.toHaveBeenCalled();
    expect(fake.api.commitMoveWithoutUndo).toHaveBeenCalledExactlyOnceWith(
      "manifest",
      "dest",
      held.op.ownedKey
    );
  });

for (const status of [404, 405])
  test(`a timeout followed by rollback ${status} stays UNKNOWN with the original key`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("owned", "timeout");
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
    });
    const original = fake.api.commitMoveWithoutUndo;
    const missing = vi.fn(async () => {
      throw new MoveError(status, "MOVE_REQUEST_FAILED");
    });
    fake.api.commitMoveWithoutUndo = missing;
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
      stage: "owned",
    });
    expect(held.state.owned).toBe("unknown");
    expect(operationFor(held, "elsewhere", [], [])).toBe(held);
    expect(missing).toHaveBeenCalledExactlyOnceWith(
      "manifest",
      "dest",
      held.op.ownedKey
    );
    fake.api.commitMoveWithoutUndo = original;
    expect(await advance(held.op, held.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(fake.copies()).toBe(3);
    expect(fake.applied.size).toBe(2);
  });

for (const status of [400, 401, 409, 500, 503])
  test(`strict failure ${status} cannot establish that the owned part did not move`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("owned", "network");
    fake.api.commitMoveWithoutUndo = async () => {
      throw new MoveError(status, "MOVE_REQUEST_FAILED");
    };
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
      stage: "owned",
    });
    expect(held.state.borrowedResult?.copy_count).toBe("1");
    expect(operationFor(held, "elsewhere", [], [])).toBe(held);
  });

for (const code of ["MOVE_MANIFEST_NOT_FOUND", "LOCATION_NOT_FOUND"])
  test(`a domain 404 ${code} is a documented first-attempt non-mutating refusal`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("owned", "network");
    fake.api.commitMoveWithoutUndo = async () => {
      throw new MoveError(404, code);
    };
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "refused",
      stage: "owned",
    });
    expect(operationFor(held, "elsewhere", [], [])).toBe(held);
  });

for (const status of [404, 405])
  test(`an old backend ${status} makes no inventory mutation when borrowed copies already stayed`, async () => {
    const held = createOperation("dest", owned, [
      { ...borrowed[0], from_location_id: "dest" },
    ]);
    const fake = server("owned", "network");
    fake.api.commitMoveWithoutUndo = async () => {
      throw new MoveError(status, "MOVE_REQUEST_FAILED");
    };
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "refused",
      stage: "owned",
    });
    expect(fake.calls).toEqual([]);
    expect(fake.copies()).toBe(0);
    expect(held.op.noUndo).toBe(true);
    expect(held.op.stayed).toBe(1);
  });

for (const status of [404, 405])
  test(`a borrowed receipt lost before rollback ${status} also stays UNKNOWN`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("borrowed", "network");
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
      stage: "borrowed",
    });
    const original = fake.api.moveBorrowedCopies;
    fake.api.moveBorrowedCopies = async () => {
      throw new BorrowedMoveError(status, "MOVE_UNAVAILABLE");
    };
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
      stage: "borrowed",
    });
    expect(operationFor(held, "elsewhere", [], [])).toBe(held);
    expect(fake.calls).toEqual([`borrowed:${held.op.borrowedKey}`]);
    fake.api.moveBorrowedCopies = original;
    expect(await advance(held.op, held.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(fake.copies()).toBe(3);
  });
