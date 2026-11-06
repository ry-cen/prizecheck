import { expect, test } from "vitest";
import {
  accountToScrub,
  createLoanIntentStore,
  createTabContext,
  scrubLoanBodies,
  type AttemptDraft,
} from "./loanIntents";
import { deferred, fixture, sharedStorage } from "./testing/loanFakes";
const draft: AttemptDraft = {
  kind: "lend_offer",
  scope: "lend_offer",
  path: "/api/loans/offers",
  fields: {},
};
const epochKey = "prizecheck:loan-epoch:v2:A";
function setup() {
  const f = fixture(),
    tab = createTabContext(),
    store = createLoanIntentStore("A", f.ports, tab);
  return { ...f, tab, store };
}
async function lost() {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  return f;
}
test("scrub removes bodies and keeps stubs", async () => {
  const f = await lost();
  scrubLoanBodies("A", f.ports, f.tab);
  expect([...f.shared.data.keys()].some((k) => k.includes("loan-body"))).toBe(
    false
  );
  expect(f.store.list()).toHaveLength(1);
  expect(f.store.list()[0].replayable).toBe(false);
});
test.each([true, false])(
  "a replay whose epoch moved keeps its stub, event=%s",
  async (events) => {
    const f = await lost(),
      entered = deferred(),
      gate = deferred();
    const second = { ...f.ports, ...f.shared.tab() };
    const store = events
      ? f.store
      : createLoanIntentStore(
          "A",
          { ...f.ports, onStorage: () => () => {} },
          createTabContext()
        );
    const id = store.list()[0].operationId;
    const before = [...f.shared.data.entries()].find(([k]) =>
      k.includes("loan-intent")
    )!;
    f.server.beforeAnswer = (p) => {
      if (p === "/auth/session") entered.resolve();
    };
    f.server.gate = (p) => (p === "/auth/session" ? gate.promise : undefined);
    const replay = store.replay(store.bind()!, id);
    await entered.promise;
    if (events) scrubLoanBodies("A", second, createTabContext());
    else second.storage!.setItem(epochKey, "1");
    gate.resolve();
    expect((await replay).kind).toBe(events ? "stale" : "pending");
    expect(f.shared.data.get(before[0])).toBe(before[1]);
    expect(store.list()[0].replayable).toBe(false);
    f.server.gate = () => undefined;
    expect((await store.cancel(store.bind()!, id)).kind).toBe("done");
    expect(store.list()).toEqual([]);
  }
);
test("a flow bound before a scrub never writes a body with the new epoch", async () => {
  const f = setup(),
    binding = f.store.bind()!;
  scrubLoanBodies("A", f.ports, f.tab);
  expect((await f.store.send(binding, draft)).kind).toBe("stale");
  expect(f.server.fetchImpl).not.toHaveBeenCalled();
  expect([...f.shared.data.keys()]).toEqual([epochKey]);
});
test("a late callback after a scrub never restores a body", async () => {
  const f = setup(),
    entered = deferred(),
    gate = deferred();
  f.server.gate = (p) => (p === draft.path ? gate.promise : undefined);
  f.server.beforeAnswer = (p) => {
    if (p === draft.path) entered.resolve();
  };
  const send = f.store.send(f.store.bind()!, draft);
  await entered.promise;
  scrubLoanBodies("A", f.ports, f.tab);
  gate.resolve();
  expect((await send).kind).toBe("stale");
  expect(f.store.list()[0]).toMatchObject({
    state: "unknown",
    replayable: false,
  });
});
test("another tab's storage event aborts its in-flight send and leaves the stub unknown", async () => {
  const f = setup(),
    entered = deferred(),
    gate = deferred();
  f.server.gate = (p) => (p === draft.path ? gate.promise : undefined);
  f.server.beforeAnswer = (p) => {
    if (p === draft.path) entered.resolve();
  };
  const send = f.store.send(f.store.bind()!, draft);
  await entered.promise;
  scrubLoanBodies("A", { ...f.ports, ...f.shared.tab() }, createTabContext());
  expect((await send).kind).toBe("stale");
  expect(f.store.list()[0].state).toBe("unknown");
  gate.resolve();
});
test("scrub does not wait for a hung send", async () => {
  const f = setup(),
    entered = deferred(),
    gate = deferred();
  f.server.gate = (p) => (p === draft.path ? gate.promise : undefined);
  f.server.beforeAnswer = (p) => {
    if (p === draft.path) entered.resolve();
  };
  const send = f.store.send(f.store.bind()!, draft);
  await entered.promise;
  expect(scrubLoanBodies("A", f.ports, f.tab)).toBeUndefined();
  await send;
  gate.resolve();
});
test("a body with a stale epoch is ignored and swept", async () => {
  const f = await lost();
  f.shared.data.set(epochKey, "1");
  expect(f.store.list()[0].replayable).toBe(false);
  expect([...f.shared.data.keys()].some((k) => k.includes("loan-body"))).toBe(
    false
  );
});
test.each([
  [null, "A", null],
  ["A", "A", null],
  ["A", "B", "A"],
  ["A", null, "A"],
] as const)("refresh seeing %s → %s scrubs %s", (previous, next, expected) =>
  expect(accountToScrub(previous, next)).toBe(expected)
);
test("signing back in in the same tab re-invalidates and allows new sends", async () => {
  const f = setup(),
    old = f.store.bind()!;
  scrubLoanBodies("A", f.ports, f.tab);
  const next = createLoanIntentStore("A", f.ports, f.tab);
  expect((await next.send(old, draft)).kind).toBe("not_saved");
  expect((await next.send(next.bind()!, draft)).kind).toBe("done");
  expect(f.shared.data.get(epochKey)).toBe("2");
});
test.each(["read", "write", "read-back"])(
  "if re-invalidation fails at %s the mark stays",
  async (failure) => {
    const f = setup();
    scrubLoanBodies("A", f.ports, f.tab);
    const storage = f.ports.storage!,
      get = storage.getItem.bind(storage),
      set = storage.setItem.bind(storage);
    let reads = 0;
    storage.getItem = (k) => {
      if (
        k === epochKey &&
        (failure === "read" || (failure === "read-back" && ++reads > 1))
      )
        throw new Error("refused");
      return get(k);
    };
    storage.setItem = (k, v) => {
      if (k === epochKey && failure === "write") throw new Error("refused");
      set(k, v);
    };
    const next = createLoanIntentStore("A", f.ports, f.tab);
    expect(f.tab.scrubbed.has("A")).toBe(true);
    const b = next.bind();
    if (b) expect((await next.send(b, draft)).kind).toBe("not_saved");
    else expect(b).toBeNull();
  }
);
test("an unreadable epoch is never reset by the scrub", () => {
  const f = setup();
  f.shared.data.set(epochKey, "1");
  const get = f.ports.storage!.getItem.bind(f.ports.storage);
  f.ports.storage!.getItem = (k) => {
    if (k === epochKey) throw new Error("refused");
    return get(k);
  };
  scrubLoanBodies("A", f.ports, f.tab);
  expect(f.shared.data.get(epochKey)).toBe("1");
  expect(f.tab.scrubbed.has("A")).toBe(true);
  expect(f.store.bind()).toBeNull();
});
test("an unreadable epoch at re-sign-in is not reset and the mark stays", () => {
  const f = setup();
  f.tab.scrubbed.add("A");
  f.shared.data.set(epochKey, "bad");
  const next = createLoanIntentStore("A", f.ports, f.tab);
  expect(f.shared.data.get(epochKey)).toBe("bad");
  expect(f.tab.scrubbed.has("A")).toBe(true);
  expect(next.bind()).toBeNull();
});
test.each([
  [true, false],
  [false, true],
  [true, true],
])(
  "failed persistence survives remount: invalidate=%s delete=%s",
  async (invalidate, remove) => {
    const f = fixture();
    let failing = false;
    const shared = sharedStorage({
      throwOn: (op, k) =>
        failing &&
        ((invalidate && op === "set" && k === epochKey) ||
          (remove && op === "remove" && k.includes("loan-body"))),
    });
    const ports = { ...f.ports, ...shared.tab() },
      tab = createTabContext(),
      store = createLoanIntentStore("A", ports, tab);
    f.server.loseNextAnswer = true;
    await store.send(store.bind()!, draft);
    failing = true;
    scrubLoanBodies("A", ports, tab);
    expect(store.list()[0].replayable).toBe(false);
    failing = false;
    const next = createLoanIntentStore(
      "A",
      { ...ports, ...shared.tab() },
      createTabContext()
    );
    expect(next.list()[0].replayable).toBe(invalidate && remove);
  }
);
test("a body written during the race is removed by its writer", async () => {
  const f = setup();
  const set = f.ports.storage!.setItem.bind(f.ports.storage);
  let once = true;
  f.ports.storage!.setItem = (k, v) => {
    if (once && k.includes("loan-body")) {
      once = false;
      scrubLoanBodies(
        "A",
        { ...f.ports, ...f.shared.tab() },
        createTabContext()
      );
    }
    set(k, v);
  };
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("not_saved");
  expect(f.store.list()).toEqual([]);
  expect(f.server.effects.size).toBe(0);
});
test("a body left by a writer that died is removed by another tab and ignored", () => {
  const f = setup(),
    other = f.shared.tab();
  f.shared.data.set(epochKey, "1");
  other.storage.setItem(
    "prizecheck:loan-body:v2:A:orphan",
    JSON.stringify({ epoch: 0 })
  );
  expect([...f.shared.data.keys()].some((k) => k.includes("loan-body"))).toBe(
    false
  );
});

test("invalidate fails and a stale flow in another tab writes a body: after remount only the same account can use it (R7)", async () => {
  const f = fixture();
  const shared = sharedStorage({
    throwOn: (op, key) => op === "set" && key === epochKey,
  });
  const ports = { ...f.ports, ...shared.tab() };
  const writer = createLoanIntentStore("A", ports, createTabContext());
  const binding = writer.bind()!;
  scrubLoanBodies("A", { ...ports, ...shared.tab() }, createTabContext());
  f.server.loseNextAnswer = true;
  expect((await writer.send(binding, draft)).kind).toBe("pending");
  const remount = createLoanIntentStore(
    "A",
    { ...ports, ...shared.tab() },
    createTabContext()
  );
  const view = remount.list()[0];
  expect(view.replayable).toBe(true);
  f.server.cookie = "B";
  expect((await remount.replay(remount.bind()!, view.operationId)).kind).toBe(
    "pending"
  );
  expect(f.server.effects.get("B")).toBeUndefined();
  f.server.cookie = "A";
  expect((await remount.check(remount.bind()!, view.operationId)).kind).toBe(
    "done"
  );
  expect(f.server.effects.get("A")).toBe(1);
});

test("an unreadable epoch does not stop independent body deletion", async () => {
  const f = await lost();
  f.shared.data.set(epochKey, "1");
  const get = f.ports.storage!.getItem.bind(f.ports.storage);
  f.ports.storage!.getItem = (key) => {
    if (key === epochKey) throw new Error("unreadable");
    return get(key);
  };
  scrubLoanBodies("A", f.ports, f.tab);
  expect(f.shared.data.get(epochKey)).toBe("1");
  expect(
    [...f.shared.data.keys()].some((key) => key.includes("loan-body"))
  ).toBe(false);
  expect(
    [...f.shared.data.keys()].some((key) => key.includes("loan-intent"))
  ).toBe(true);
  expect(f.tab.scrubbed.has("A")).toBe(true);
});
