import { expect, test, vi } from "vitest";
import {
  createLoanIntentStore,
  createTabContext,
  VOID_PATH,
  type AttemptDraft,
} from "./loanIntents";
import { deferred, fixture, reply, sharedStorage } from "./testing/loanFakes";
import { resultText } from "./loanText";
const draft: AttemptDraft = {
  kind: "lend_offer",
  scope: "lend_offer",
  path: "/api/loans/offers",
  fields: { copies: [] },
};
function setup() {
  const f = fixture();
  const store = createLoanIntentStore("A", f.ports, createTabContext());
  return { ...f, store };
}
test.each(["network", "503", "malformed"])(
  "a replay session failure (%s) keeps a committed lost-answer attempt unknown",
  async (failure) => {
    const f = setup();
    f.server.loseNextAnswer = true;
    await f.store.send(f.store.bind()!, draft);
    expect(f.server.effects.get("A")).toBe(1);
    const view = f.store.list()[0];
    const before = [...f.shared.data.entries()];
    const calls = f.server.fetchImpl.mock.calls.length;
    f.ports.fetchImpl = async (path, init) => {
      if (String(path) !== "/auth/session")
        return f.server.fetchImpl(path, init);
      if (failure === "network") throw new Error("offline");
      return failure === "503"
        ? reply(503, {})
        : new Response("unreadable", { status: 200 });
    };
    const outcome = await f.store.replay(f.store.bind()!, view.operationId);
    expect(outcome).toMatchObject({
      kind: "pending",
      view: { state: "unknown", replayable: true },
    });
    expect(resultText(outcome)).toBeNull();
    expect([...f.shared.data.entries()]).toEqual(before);
    expect(f.server.fetchImpl).toHaveBeenCalledTimes(calls);
    f.ports.fetchImpl = f.server.fetchImpl;
    expect((await f.store.replay(f.store.bind()!, view.operationId)).kind).toBe(
      "done"
    );
    expect(f.server.effects.get("A")).toBe(1);
  }
);
test("a failed session before a new attempt still returns not_sent", async () => {
  const f = setup();
  f.ports.fetchImpl = async () => reply(503, {});
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "not_sent",
  });
  expect(f.shared.data.size).toBe(0);
  expect(f.server.effects.size).toBe(0);
});
test("a lost answer leaves unknown and Send it again replays the identical body, then confirms", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("pending");
  const view = f.store.list()[0];
  expect(view).toMatchObject({ state: "unknown", replayable: true });
  expect((await f.store.replay(f.store.bind()!, view.operationId)).kind).toBe(
    "done"
  );
  const sends = f.server.fetchImpl.mock.calls.filter(([p]) => p === draft.path);
  expect(sends).toHaveLength(2);
  expect(sends[0][1]?.body).toBe(sends[1][1]?.body);
  expect(f.server.effects.get("A")).toBe(1);
  expect(f.store.list()).toEqual([]);
});
test("Don't send it ends voided and the scope takes a new key", async () => {
  const f = setup();
  f.ports.fetchImpl = vi.fn(async (p, i) =>
    String(p) === draft.path
      ? Promise.reject(new Error("offline"))
      : f.server.fetchImpl(p, i)
  );
  await f.store.send(f.store.bind()!, draft);
  const id = f.store.list()[0].operationId;
  expect((await f.store.cancel(f.store.bind()!, id)).kind).toBe("voided");
  f.ports.fetchImpl = f.server.fetchImpl;
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("done");
  expect(f.server.effects.get("A")).toBe(1);
});
test.each([false, true])(
  "a refusal is shown and fenced; applied=%s",
  async (applied) => {
    const f = setup();
    f.ports.fetchImpl = async (p, i) => {
      if (String(p) === draft.path) {
        if (applied) await f.server.fetchImpl(p, i);
        return reply(409, { detail: { code: "NOT_LENDABLE" } });
      }
      return f.server.fetchImpl(p, i);
    };
    const result = await f.store.send(f.store.bind()!, draft);
    expect(result.kind).toBe(applied ? "done" : "voided");
    if (result.kind === "voided")
      expect(result.refusal?.code).toBe("NOT_LENDABLE");
    expect(f.store.list()).toEqual([]);
  }
);
test.each([
  "invalid",
  { outcome: "other", account_id: "A" },
  { outcome: "void" },
  { outcome: "void", account_id: "B" },
  429,
])("an invalid void answer keeps fencing: %j", async (invalid) => {
  const f = setup();
  f.ports.fetchImpl = async (p, i) =>
    String(p) === draft.path
      ? reply(422, {})
      : String(p) === VOID_PATH
        ? invalid === 429
          ? reply(429, {})
          : invalid === "invalid"
            ? new Response("bad", { status: 200 })
            : reply(200, invalid)
        : f.server.fetchImpl(p, i);
  const o = await f.store.send(f.store.bind()!, draft);
  expect(o.kind).toBe("pending");
  expect(f.store.list()[0].state).toBe("fencing");
  f.ports.fetchImpl = f.server.fetchImpl;
  expect(
    (await f.store.check(f.store.bind()!, f.store.list()[0].operationId)).kind
  ).toBe("voided");
});
test("two tabs sending in one scope make one fetch", async () => {
  const f = setup(),
    gate = deferred(),
    entered = deferred();
  f.server.gate = (p) => (p === draft.path ? gate.promise : undefined);
  f.server.beforeAnswer = (p) => {
    if (p === draft.path) entered.resolve();
  };
  const other = createLoanIntentStore(
    "A",
    { ...f.ports, ...f.shared.tab() },
    createTabContext()
  );
  const first = f.store.send(f.store.bind()!, draft);
  await entered.promise;
  expect((await other.send(other.bind()!, draft)).kind).toBe("busy");
  gate.resolve();
  await first;
  expect(f.server.effects.get("A")).toBe(1);
});
test("an unparsable send 2xx goes to confirming without reading fields", async () => {
  const f = setup();
  f.ports.fetchImpl = async (p, i) => {
    if (String(p) === draft.path) {
      await f.server.fetchImpl(p, i);
      return new Response("bad", { status: 201 });
    }
    return f.server.fetchImpl(p, i);
  };
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "done",
    response: undefined,
  });
});
test("no stub ends by age, listing or sweeping", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const before = [...f.shared.data.entries()];
  const listed = f.store.list();
  f.ports.now = () => Number.MAX_SAFE_INTEGER;
  expect(f.store.list()).toEqual(listed);
  expect([...f.shared.data.entries()]).toEqual(before);
});
test("409 IDEMPOTENCY_KEY_VOID ends voided", async () => {
  const f = setup();
  f.ports.fetchImpl = async (p, i) =>
    String(p) === draft.path
      ? reply(409, { detail: { code: "IDEMPOTENCY_KEY_VOID" } })
      : f.server.fetchImpl(p, i);
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "voided",
    refusal: null,
    otherAccount: false,
  });
});
test("a confirm whose void answers void ends voided as another account", async () => {
  const f = setup();
  f.ports.fetchImpl = async (p, i) =>
    String(p) === draft.path ? reply(201, {}) : f.server.fetchImpl(p, i);
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "voided",
    refusal: null,
    otherAccount: true,
  });
});
test.each([401, 409])(
  "%s waits for the account and sends nothing until it matches",
  async (status) => {
    const f = setup();
    let refuse = true;
    f.ports.fetchImpl = async (p, i) =>
      String(p) === draft.path && refuse
        ? reply(status, { detail: { code: "ACCOUNT_CHANGED" } })
        : f.server.fetchImpl(p, i);
    await f.store.send(f.store.bind()!, draft);
    expect(f.store.list()[0].waitingAccount).toBe(true);
    f.server.cookie = "B";
    expect(
      (await f.store.check(f.store.bind()!, f.store.list()[0].operationId)).kind
    ).toBe("pending");
    refuse = false;
    f.server.cookie = "A";
    expect(
      (await f.store.check(f.store.bind()!, f.store.list()[0].operationId)).kind
    ).toBe("done");
  }
);
test("a session for another user before the first send writes nothing", async () => {
  const f = setup();
  f.server.cookie = "B";
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe(
    "wrong_account"
  );
  expect(f.shared.data.size).toBe(0);
});
test("a write that does not read back is not_saved and makes no fetch", async () => {
  const f = setup();
  f.ports.storage!.setItem = () => {};
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("not_saved");
  expect(f.server.effects.size).toBe(0);
});
test("no locks gives no_locks with no write and no fetch", async () => {
  const f = setup();
  f.ports.locks = null;
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("no_locks");
  expect(f.server.fetchImpl).not.toHaveBeenCalled();
  expect(f.shared.data.size).toBe(0);
});
test.each(["missing-body", "contract", "corrupt", "sending"])(
  "a %s stub blocks and is retained",
  async (mode) => {
    const f = setup();
    f.server.loseNextAnswer = true;
    await f.store.send(f.store.bind()!, draft);
    const key = [...f.shared.data.keys()].find((k) =>
        k.includes("loan-intent")
      )!,
      s = JSON.parse(f.shared.data.get(key)!);
    if (mode === "missing-body")
      for (const k of f.shared.data.keys())
        if (k.includes("loan-body")) f.shared.data.delete(k);
    if (mode === "contract") s.contract = "other";
    if (mode === "corrupt") s.v = 3;
    if (mode === "sending") s.state = "sending";
    f.shared.data.set(key, JSON.stringify(s));
    expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("pending");
    const v = f.store.list()[0];
    expect(v.state).toBe("unknown");
    if (mode !== "sending") expect(v.replayable).toBe(false);
    if (mode === "corrupt") expect(v.scope).toBe("*");
    expect((await f.store.cancel(f.store.bind()!, s.operationId)).kind).toBe(
      "done"
    );
  }
);
test("another account's stubs are not listed", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const other = createLoanIntentStore("B", f.ports, createTabContext());
  expect(other.list()).toEqual([]);
});
test("a corrupt stub without a key is ignored", () => {
  const f = setup();
  f.shared.data.set(
    "prizecheck:loan-intent:v2:A:bad",
    JSON.stringify({ accountId: "A" })
  );
  expect(f.store.list()).toEqual([]);
  expect(f.shared.data.size).toBe(1);
});
test("a failed stub removal keeps the record", async () => {
  const f = setup();
  const remove = f.ports.storage!.removeItem.bind(f.ports.storage);
  f.ports.storage!.removeItem = (k) => {
    if (k.includes("loan-intent")) throw new Error("refused");
    remove(k);
  };
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("pending");
  expect(f.store.list()).toHaveLength(1);
});
test("Check again in another tab after settlement answers settled_elsewhere", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const id = f.store.list()[0].operationId;
  await f.store.cancel(f.store.bind()!, id);
  expect((await f.store.check(f.store.bind()!, id)).kind).toBe(
    "settled_elsewhere"
  );
});

test("without locks replay, cancel and check make no request or storage change", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const id = f.store.list()[0].operationId;
  const before = [...f.shared.data.entries()];
  const calls = f.server.fetchImpl.mock.calls.length;
  f.ports.locks = null;
  for (const action of ["replay", "cancel", "check"] as const)
    expect((await f.store[action](f.store.bind()!, id)).kind).toBe("no_locks");
  expect([...f.shared.data.entries()]).toEqual(before);
  expect(f.server.fetchImpl).toHaveBeenCalledTimes(calls);
});

test("a wildcard stub blocks a different durable scope without a request", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const key = [...f.shared.data.keys()].find((key) =>
    key.includes("loan-intent")
  )!;
  const stub = JSON.parse(f.shared.data.get(key)!);
  stub.v = 3;
  f.shared.data.set(key, JSON.stringify(stub));
  const calls = f.server.fetchImpl.mock.calls.length;
  const result = await f.store.send(f.store.bind()!, {
    kind: "borrow_request",
    scope: "borrow_request:B",
    path: "/api/loans",
    fields: {},
  });
  expect(result.kind).toBe("pending");
  if (result.kind === "pending") expect(result.view.scope).toBe("*");
  expect(f.server.fetchImpl).toHaveBeenCalledTimes(calls);
});

test("an unparsable send 2xx stays confirming while its void is unavailable", async () => {
  const f = setup();
  f.ports.fetchImpl = async (path, init) =>
    String(path) === draft.path
      ? new Response("unreadable", { status: 201 })
      : String(path) === VOID_PATH
        ? reply(404, {})
        : f.server.fetchImpl(path, init);
  expect((await f.store.send(f.store.bind()!, draft)).kind).toBe("pending");
  expect(f.store.list()[0].state).toBe("confirming");
});

test.each([
  ["lend_offer", "loans-d1", true],
  ["borrow_request", "loans-d1", true],
  ["move_borrowed", "loans-d1", true],
  ["start_return", "loans-d1", false],
  ["write_off", "loans-d1", false],
  ["borrow_request", "loans-d1-replaces", false],
] as const)(
  "remount %s contract %s replayable=%s",
  async (kind, contract, replayable) => {
    const f = setup();
    const paths = {
      lend_offer: "/api/loans/offers",
      borrow_request: "/api/loans",
      move_borrowed: "/api/loans/borrowed/move",
      start_return: "/api/loans/00000000-0000-4000-8000-000000000001/returns",
      write_off: "/api/loans/00000000-0000-4000-8000-000000000001/write-off",
    };
    f.server.loseNextAnswer = true;
    await f.store.send(f.store.bind()!, {
      kind,
      scope: kind,
      path: paths[kind],
      fields:
        kind === "start_return" || kind === "write_off"
          ? { loan_id: "round", revision: 1, lines: [] }
          : {},
    });
    for (const [key, text] of f.shared.data)
      if (key.includes("loan-intent"))
        f.ports.storage!.setItem(
          key,
          JSON.stringify({ ...JSON.parse(text), contract })
        );
    f.store.dispose();
    const next = createLoanIntentStore("A", f.ports, createTabContext());
    const view = next.list()[0];
    expect(view.replayable).toBe(replayable);
    const before = f.server.fetchImpl.mock.calls.length;
    if (!replayable) {
      expect((await next.replay(next.bind()!, view.operationId)).kind).toBe(
        "pending"
      );
      expect(f.server.fetchImpl).toHaveBeenCalledTimes(before);
      expect(
        [...f.shared.data.keys()].some((key) => key.includes("loan-body"))
      ).toBe(false);
    }
    next.dispose();
  }
);
test("ALREADY_APPLIED ends done with no response when the void answers applied", async () => {
  const f = setup();
  f.ports.fetchImpl = async (path, init) => {
    const result = await f.server.fetchImpl(path, init);
    return String(path) === draft.path
      ? reply(409, { detail: { code: "ALREADY_APPLIED" } })
      : result;
  };
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "done",
    response: undefined,
  });
  expect(f.store.list()).toEqual([]);
});
test("a rejecting lock manager never rejects send", async () => {
  const f = setup();
  f.ports.locks = {
    request: async () => {
      throw new Error("denied");
    },
  };
  expect(await f.store.send(f.store.bind()!, draft)).toEqual({
    kind: "not_saved",
  });
  expect(f.server.fetchImpl).not.toHaveBeenCalled();
});
test("a rejecting lock manager retains its blocker", async () => {
  const f = setup();
  f.server.loseNextAnswer = true;
  await f.store.send(f.store.bind()!, draft);
  const view = f.store.list()[0];
  f.ports.locks = {
    request: async () => {
      throw new Error("denied");
    },
  };
  expect(await f.store.send(f.store.bind()!, draft)).toMatchObject({
    kind: "pending",
    view,
  });
});

test.each(["check", "cancel"] as const)(
  "NOT_LENDABLE survives a void 503 and a later %s fence",
  async (action) => {
    for (const applied of [false, true]) {
      const f = setup();
      const edit: AttemptDraft = {
        kind: "borrow_request",
        scope: "borrow_request:B",
        path: "/api/loans",
        fields: { lender_id: "B", lines: [] },
      };
      let voids = 0;
      f.ports.fetchImpl = async (path, init) => {
        if (String(path) === edit.path) {
          if (applied) await f.server.fetchImpl(path, init);
          return reply(409, { detail: { code: "NOT_LENDABLE" } });
        }
        if (String(path) === VOID_PATH && ++voids === 1) return reply(503, {});
        return f.server.fetchImpl(path, init);
      };
      const first = await f.store.send(f.store.bind()!, edit);
      expect(first).toMatchObject({
        kind: "pending",
        view: { state: "fencing" },
        refusal: { code: "NOT_LENDABLE" },
      });
      for (const value of f.shared.data.values())
        expect(value).not.toContain("NOT_LENDABLE");
      const id = f.store.list()[0].operationId;
      const end = await f.store[action](f.store.bind()!, id);
      expect(end.kind).toBe(applied ? "done" : "voided");
      if (!applied)
        expect(end).toMatchObject({ refusal: { code: "NOT_LENDABLE" } });
      expect(voids).toBe(2);
      expect(f.store.list()).toEqual([]);
    }
  }
);

test.each(["start_return", "write_off"] as const)(
  "%s scopes use the round even though the path uses the thread",
  async (kind) => {
    const f = setup();
    f.server.loseNextAnswer = true;
    const thread = "00000000-0000-4000-8000-000000000001";
    const round = "00000000-0000-4000-8000-000000000002";
    const path = `/api/loans/${thread}/${kind === "start_return" ? "returns" : "write-off"}`;
    await f.store.send(f.store.bind()!, {
      kind,
      scope: `${kind}:${round}`,
      path,
      fields: { loan_id: round, revision: 2, lines: [] },
    });
    expect(f.store.blockerFor(`${kind}:${round}`)?.scope).toBe(
      `${kind}:${round}`
    );
    expect(f.store.blockerFor(`${kind}:${thread}`)).toBeUndefined();
    const packet = [...f.shared.data.entries()].find(([key]) =>
      key.includes("loan-body")
    )![1];
    expect(JSON.parse(packet).path).toBe(path);
    expect(JSON.parse(JSON.parse(packet).body).loan_id).toBe(round);
  }
);
