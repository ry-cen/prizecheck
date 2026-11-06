import { expect, test } from "vitest";
import {
  newAttempt,
  LOAN_CONTRACT,
  DURABLE_KINDS,
  threadIdOf,
  scopeFor,
  sendAnswer,
  transmit,
  voidAnswer,
  type Answer,
} from "./loanAttempt";
const answer = (
  status: number | null,
  code: string | null = null,
  json?: unknown
): Answer => ({ status, code, json, detail: {}, parsed: json !== undefined });
test("builds one frozen body with the key and account_id", () => {
  const a = newAttempt(
    {
      accountId: "A",
      kind: "lend_offer",
      scope: "lend_offer",
      path: "/api/loans/offers",
      fields: { copies: [] },
    },
    { uuid: () => "key", now: () => 10 }
  );
  expect(Object.isFrozen(a)).toBe(true);
  expect(JSON.parse(a.body)).toEqual({
    copies: [],
    account_id: "A",
    idempotency_key: "key",
  });
});
test("rejects a path that does not match its kind", () =>
  expect(() =>
    newAttempt(
      {
        accountId: "A",
        kind: "lend_offer",
        scope: "lend_offer",
        path: "/api/loans",
        fields: {},
      },
      { uuid: () => "", now: () => 0 }
    )
  ).toThrow("path does not match kind"));
test.each([
  [null, null, "unknown"],
  [500, null, "unknown"],
  [201, null, "confirm"],
  [409, "IDEMPOTENCY_KEY_VOID", "void"],
  [409, "ALREADY_APPLIED", "confirm"],
  [401, null, "account"],
  [409, "ACCOUNT_CHANGED", "account"],
  [404, null, "refused"],
  [422, null, "refused"],
  [429, "TOO_MANY_CHANGES", "refused"],
  [409, "IDEMPOTENCY_KEY_REUSED", "refused"],
  [302, null, "unknown"],
] as const)("sendAnswer %s %s", (status, code, result) =>
  expect(sendAnswer(answer(status, code))).toBe(result)
);
test.each([
  [200, { outcome: "applied", account_id: "A" }, "applied"],
  [200, { outcome: "void", account_id: "A" }, "void"],
  [200, undefined, "retry"],
  [200, { outcome: "other", account_id: "A" }, "retry"],
  [200, { outcome: "void" }, "retry"],
  [200, { outcome: "void", account_id: "B" }, "retry"],
  [404, {}, "retry"],
  [405, {}, "retry"],
  [422, {}, "retry"],
  [429, {}, "retry"],
  [503, {}, "retry"],
  [null, {}, "retry"],
] as const)("voidAnswer %s %j", (status, json, result) =>
  expect(voidAnswer(answer(status, null, json), "A")).toBe(result)
);
test.each([401, 409])("void account refusal %s", (status) =>
  expect(
    voidAnswer(answer(status, status === 409 ? "ACCOUNT_CHANGED" : null), "A")
  ).toBe("account")
);
test("transmit sends the stored text byte for byte and reads no fields from an unparsable 2xx", async () => {
  const text = '{ "a": 1 }';
  const fetchImpl: typeof fetch = async (_url, init) => {
    expect(init?.body).toBe(text);
    return new Response("invalid", { status: 200 });
  };
  const a = await transmit(
    fetchImpl,
    "/api/loans",
    text,
    new AbortController().signal
  );
  expect(a).toMatchObject({ status: 200, parsed: false });
  expect(sendAnswer(a)).toBe("confirm");
});
test("scopeFor needs the correct ids", () => {
  expect(scopeFor("lend_offer", {})).toBe("lend_offer");
  expect(scopeFor("borrow_request", { lenderId: "B" })).toBe(
    "borrow_request:B"
  );
  expect(() => scopeFor("start_return", {})).toThrow();
});

test.each([null, "round"])(
  "a replaces field is refused when the attempt is built (%s)",
  (replaces) => {
    expect(() =>
      newAttempt(
        {
          accountId: "A",
          kind: "borrow_request",
          scope: "borrow_request:B",
          path: "/api/loans",
          fields: { replaces },
        },
        { uuid: () => "key", now: () => 0 }
      )
    ).toThrow("reserved attempt field");
  }
);
test.each(DURABLE_KINDS)("every new %s attempt is loans-t1", (kind) => {
  const path = {
    lend_offer: "/api/loans/offers",
    borrow_request: "/api/loans",
    move_borrowed: "/api/loans/borrowed/move",
    start_return: "/api/loans/00000000-0000-4000-8000-000000000001/returns",
    write_off: "/api/loans/00000000-0000-4000-8000-000000000001/write-off",
  }[kind];
  expect(
    newAttempt(
      { accountId: "A", kind, scope: kind, path, fields: {} },
      { uuid: () => "key", now: () => 0 }
    ).contract
  ).toBe(LOAN_CONTRACT);
});
test("a step path is the thread and its body names the round", () => {
  const a = newAttempt(
    {
      accountId: "A",
      kind: "start_return",
      scope: scopeFor("start_return", { loanId: "round" }),
      path: "/api/loans/00000000-0000-4000-8000-000000000001/returns",
      fields: { loan_id: "round", revision: 2, lines: [] },
    },
    { uuid: () => "key", now: () => 0 }
  );
  expect(JSON.parse(a.body).loan_id).toBe("round");
  expect(a.scope).toBe("start_return:round");
});
test("threadIdOf reads only a string thread_id", () => {
  expect(threadIdOf({ id: "round", thread_id: "thread" })).toBe("thread");
  for (const value of [null, [], { id: "round" }, { thread_id: 12 }])
    expect(threadIdOf(value)).toBeNull();
});

test("ALREADY_APPLIED confirms and never counts as a refusal", () => {
  expect(
    sendAnswer(
      answer(409, "ALREADY_APPLIED", { detail: { code: "ALREADY_APPLIED" } })
    )
  ).toBe("confirm");
});
