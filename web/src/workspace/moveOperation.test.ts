import {
  applyUndo,
  dismissUndo,
  listUndo,
  type UndoEntry,
} from "../inventoryUndo";
import { expect, test, vi } from "vitest";
import { BorrowedMoveError } from "../collection_generated";
import { MoveError } from "../moves_generated";
import {
  advance,
  createOperation,
  createRemoval,
  operationFor,
  offerableUndo,
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
    dismissUndo: async () => {},
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
      if (stage === "owned")
        expect(offerableUndo([undoEntry("uncertain-half")], held)).toEqual([]);
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

function undoEntry(id: string): UndoEntry {
  return {
    id,
    action: "move",
    source_id: "box",
    destination_id: "dest",
    source_count: 1,
    expires_at: "2099-01-01",
  };
}
for (const loss of ["lost deletion response", "server refusal"] as const)
  test(`mixed Move retains and suppresses its Undo while recovering from ${loss}`, async () => {
    const held = createOperation("dest", owned, borrowed);
    const fake = server("borrowed", "network");
    fake.api.moveBorrowedCopies = async () => ({
      copy_count: "1",
      owner_revision: 2,
    });
    let present = true;
    let attempts = 0;
    fake.api.dismissUndo = async (id) => {
      expect(id).toBe("owned-undo");
      attempts++;
      if (attempts === 1) {
        if (loss === "lost deletion response") {
          present = false;
          throw new TypeError("lost");
        }
        throw new MoveError(403, "REFUSED");
      }
      if (!present) throw new MoveError(404, "UNDO_NOT_FOUND");
      present = false;
    };
    expect(await advance(held.op, held.state, fake.api)).toMatchObject({
      kind: "unknown",
      stage: "discard",
    });
    expect(held.state.owned).toBe("done");
    expect(held.state.discard).toBe("unknown");
    expect(
      offerableUndo(
        [undoEntry("newer"), undoEntry("owned-undo"), undoEntry("older")],
        held
      ).map((entry) => entry.id)
    ).toEqual(["newer"]);
    expect(operationFor(held, "different", [], [])).toBe(held);
    expect(await advance(held.op, held.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(present).toBe(false);
    expect(attempts).toBe(2);
    expect(fake.copies()).toBe(2);
    expect(held.state.discard).toBe("done");
    expect(
      offerableUndo([undoEntry("owned-undo")], null, new Set(["owned-undo"]))
    ).toEqual([]);
  });

test("mixed Move is absent after a newer owned Move's incompatible Undo is dismissed", async () => {
  const records: UndoEntry[] = [];
  const deletes: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), "https://test.invalid").pathname;
    if (path === "/api/moves/undo") return Response.json(records);
    const id = path.split("/").at(-1)!;
    if (init?.method === "DELETE") {
      deletes.push(id);
      const at = records.findIndex((entry) => entry.id === id);
      if (at < 0)
        return Response.json(
          { detail: { code: "UNDO_NOT_FOUND" } },
          { status: 404 }
        );
      records.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { detail: { code: "UNDO_INCOMPATIBLE" } },
      { status: 409 }
    );
  });
  try {
    const fake = server("borrowed", "network");
    fake.api.moveBorrowedCopies = async () => ({
      copy_count: "1",
      owner_revision: 2,
    });
    fake.api.dismissUndo = dismissUndo;
    fake.api.commitMove = async (_id, _dest, key) => {
      records.unshift(undoEntry(key));
      return {
        undo_id: key,
        copy_count: "2",
        edition_count: 1,
        source_count: 1,
        already_at_destination_count: "0",
        owner_revision: 3,
      };
    };
    const mixed = createOperation("dest", owned, borrowed);
    expect(await advance(mixed.op, mixed.state, fake.api)).toEqual({
      kind: "done",
    });
    expect(deletes).toEqual([mixed.op.ownedKey]);
    const newer = createOperation("dest", owned, []);
    expect(await advance(newer.op, newer.state, fake.api)).toEqual({
      kind: "done",
    });
    expect((await listUndo()).map((entry) => entry.id)).toEqual([
      newer.op.ownedKey,
    ]);
    await expect(
      applyUndo(newer.op.ownedKey, "undo-attempt")
    ).rejects.toMatchObject({ code: "UNDO_INCOMPATIBLE" });
    await dismissUndo(newer.op.ownedKey);
    expect(await listUndo()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
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
  fake.api.dismissUndo = async () => {
    throw new Error("Owned-only Undo must remain");
  };
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
