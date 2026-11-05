import { expect, test } from "vitest";
import { DURABLE_KINDS, type DurableKind } from "./loanAttempt";
import {
  createLoanIntentStore,
  createTabContext,
  type AttemptDraft,
} from "./loanIntents";
import { fixture, type Profile } from "./testing/loanFakes";
const path = (kind: DurableKind) =>
  ({
    lend_offer: "/api/loans/offers",
    borrow_request: "/api/loans",
    move_borrowed: "/api/loans/borrowed/move",
    start_return: "/api/loans/00000000-0000-4000-8000-000000000001/returns",
    write_off: "/api/loans/00000000-0000-4000-8000-000000000001/write-off",
  })[kind];
for (const profile of ["s1", "dev-pre-d3", "stack-pre-d3"] satisfies Profile[])
  test.each(DURABLE_KINDS)(
    `a switch to B before %s never settles A as done (${profile})`,
    async (kind) => {
      const f = fixture();
      f.server.setProfile(profile);
      f.server.beforeAnswer = (p) => {
        if (p === "/auth/session") f.server.cookie = "B";
      };
      const store = createLoanIntentStore("A", f.ports, createTabContext());
      const draft: AttemptDraft = {
        kind,
        scope: kind,
        path: path(kind),
        fields:
          kind === "start_return" || kind === "write_off"
            ? { loan_id: "round", revision: 1, lines: [] }
            : {},
      };
      expect((await store.send(store.bind()!, draft)).kind).toBe("pending");
      expect(store.list()).toHaveLength(1);
    }
  );
test.each(DURABLE_KINDS)(
  "%s from stack-pre-d3 stays confirming or fencing then resolves after upgrade",
  async (kind) => {
    const f = fixture();
    f.server.setProfile("stack-pre-d3");
    const store = createLoanIntentStore("A", f.ports, createTabContext());
    const draft: AttemptDraft = {
      kind,
      scope: kind,
      path: path(kind),
      fields:
        kind === "start_return" || kind === "write_off"
          ? { loan_id: "round", revision: 1, lines: [] }
          : {},
    };
    await store.send(store.bind()!, draft);
    expect(store.list()[0].state).toBe(
      kind === "lend_offer" || kind === "move_borrowed"
        ? "confirming"
        : "fencing"
    );
    f.server.setProfile("s1");
    expect(["done", "voided"]).toContain(
      (await store.check(store.bind()!, store.list()[0].operationId)).kind
    );
    expect(store.list()).toEqual([]);
  }
);
test("records survive an s1 → pre-D3 → s1 flip and resolve after it", async () => {
  const f = fixture(),
    store = createLoanIntentStore("A", f.ports, createTabContext());
  f.server.loseNextAnswer = true;
  await store.send(store.bind()!, {
    kind: "lend_offer",
    scope: "lend_offer",
    path: path("lend_offer"),
    fields: {},
  });
  f.server.setProfile("dev-pre-d3");
  const id = store.list()[0].operationId;
  expect((await store.replay(store.bind()!, id)).kind).toBe("pending");
  f.server.setProfile("s1");
  expect((await store.check(store.bind()!, id)).kind).toBe("done");
  expect(f.server.effects.get("A")).toBe(1);
});
