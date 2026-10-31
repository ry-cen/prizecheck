import { expect, test } from "vitest";
import { BorrowedMoveError } from "../collection_generated";
import { MoveError } from "../moves_generated";
import {
  advance,
  createOperation,
  createRemoval,
  operationFor,
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
    commitMove: async (id, _destination, key) => {
      expect(id).toBe("manifest");
      commit("owned", key, 2);
      return {
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
