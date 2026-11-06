import { expect, test, vi } from "vitest";
import { SocialError, type LoanView } from "../social_generated";
import {
  checkEdit,
  classifyTermsRead,
  decideEdit,
  sendCheckedEdit,
  type GateNow,
  type GateToken,
} from "./editGate";
import { createLoanIntentStore } from "./loanIntents";
import { fixture } from "./testing/loanFakes";
const opened: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "thread",
  revision: 2,
  kind: "borrow_request",
  state: "requested",
  closed_reason: null,
  closed_by: null,
  role: "borrower",
  other: { collector_id: "B", display_name: "Friend" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [],
  needs_you: false,
  section: "pending",
  actions: ["edit_and_resend"],
};
function deps() {
  const captured: GateToken = {
    opened,
    binding: { accountId: "A", generation: 0, boundEpoch: 0 },
  };
  let now: GateNow = {
    live: true,
    active: true,
    aborted: false,
    binding: captured.binding,
  };
  return {
    captured,
    signal: new AbortController().signal,
    now: () => now,
    change: (value: GateNow) => {
      now = value;
    },
    read: vi.fn(async (): Promise<unknown> => opened),
    apply: vi.fn(),
    send: vi.fn(async () => "sent"),
  };
}
test("classifyTermsRead accepts only the version the editor opened", () => {
  expect(classifyTermsRead({ loan: opened }, opened)).toBe("ok");
  for (const changed of [
    { revision: 3 },
    { loan_id: "next" },
    { state: "closed" },
    { actions: [] },
    { role: "lender" },
    { other: { collector_id: "C" } },
  ])
    expect(classifyTermsRead({ loan: { ...opened, ...changed } }, opened)).toBe(
      "changed"
    );
});
test.each([404, 401, 403, 500])("classifyTermsRead maps HTTP %s", (status) =>
  expect(
    classifyTermsRead({ error: new SocialError(status, "REFUSED") }, opened)
  ).toBe(status === 404 ? "changed" : "error")
);
test.each([
  new TypeError(),
  new SyntaxError(),
  new DOMException("cancelled", "AbortError"),
])("classifyTermsRead maps %s", (error) =>
  expect(classifyTermsRead({ error }, opened)).toBe(
    error.name === "AbortError" ? "aborted" : "error"
  )
);
test.each([null, "text", {}, { ...opened, other: null }, undefined])(
  "classifyTermsRead is total for malformed %j",
  (loan) => expect(classifyTermsRead({ loan }, opened)).toBe("error")
);
test("classifyTermsRead is total for throwing properties", () =>
  expect(
    classifyTermsRead(
      {
        loan: {
          get other() {
            throw new Error("bad reply");
          },
        },
      },
      opened
    )
  ).toBe("error"));
for (const mode of [
  "account",
  "generation",
  "epoch",
  "abort",
  "unmount",
  "route",
  "superseded",
  "unreadable",
] as const) {
  test(`continuation gaps never send: ${mode}`, async () => {
    const d = deps();
    let resolve!: (value: unknown) => void;
    const waiting = new Promise<unknown>((done) => {
      resolve = done;
    });
    d.read.mockReturnValue(waiting);
    const pending = sendCheckedEdit(d);
    if (mode === "unmount" || mode === "route") d.change({ live: false });
    else
      d.change({
        live: true,
        active: mode !== "superseded",
        aborted: mode === "abort",
        binding:
          mode === "unreadable"
            ? null
            : {
                ...d.captured.binding,
                ...(mode === "account"
                  ? { accountId: "B" }
                  : mode === "generation"
                    ? { generation: 1 }
                    : mode === "epoch"
                      ? { boundEpoch: 1 }
                      : {}),
              },
      });
    resolve(opened);
    const result = await pending;
    expect(d.send).not.toHaveBeenCalled();
    expect(result).toEqual(
      ["unmount", "route", "superseded"].includes(mode)
        ? { ignore: true }
        : { gate: "error" }
    );
  });
}
test("decideEdit orders each state row before classification", () => {
  const d = deps();
  expect(
    decideEdit(
      d.captured,
      { live: false },
      { error: new DOMException("", "AbortError") }
    )
  ).toBe("ignore");
  expect(
    decideEdit(
      d.captured,
      { live: true, active: false, aborted: true, binding: null },
      { loan: null }
    )
  ).toBe("ignore");
  for (const now of [
    { live: true, active: true, aborted: true, binding: d.captured.binding },
    { live: true, active: true, aborted: false, binding: null },
  ] satisfies GateNow[])
    expect(decideEdit(d.captured, now, { loan: opened })).toBe("error");
  expect(
    decideEdit(d.captured, d.now(), {
      error: new DOMException("", "AbortError"),
    })
  ).toBe("error");
  expect(decideEdit(d.captured, d.now(), { loan: opened })).toBe("ok");
});
test("the decision and send happen in one turn", async () => {
  const d = deps();
  const events: string[] = [];
  d.now = () => {
    events.push("now");
    queueMicrotask(() => events.push("gap"));
    return {
      live: true,
      active: true,
      aborted: false,
      binding: d.captured.binding,
    };
  };
  d.send.mockImplementation(async () => {
    events.push("send");
    return "sent";
  });
  d.apply.mockImplementation(() => events.push("apply"));
  expect(await sendCheckedEdit(d)).toEqual({ outcome: "sent" });
  expect(events.slice(0, 3)).toEqual(["now", "send", "apply"]);
});
test.each([401, 403])("%s fails closed", async (status) => {
  const d = deps();
  d.read.mockRejectedValue(new SocialError(status, "REFUSED"));
  expect(await sendCheckedEdit(d)).toEqual({ gate: "error" });
  expect(d.send).not.toHaveBeenCalled();
});
test("malformed 2xx fails closed and does not throw", async () => {
  const d = deps();
  d.read.mockResolvedValue({ other: null });
  expect(await checkEdit(d)).toBe("error");
  expect(d.apply).toHaveBeenCalledWith("error");
});
test("retry after an error reaches ok", async () => {
  const d = deps();
  d.read.mockRejectedValueOnce(new TypeError());
  expect(await checkEdit(d)).toBe("error");
  expect(await checkEdit(d)).toBe("ok");
});
test("an active abort fails closed", async () => {
  const d = deps();
  d.read.mockRejectedValue(new DOMException("", "AbortError"));
  expect(await checkEdit(d)).toBe("error");
});
test("a superseded check is ignored", async () => {
  const d = deps();
  d.change({ live: true, active: false, aborted: true, binding: null });
  expect(await checkEdit(d)).toBe("ignore");
  expect(d.apply).not.toHaveBeenCalled();
});
test("an unreadable binding fails closed", async () => {
  const d = deps();
  d.change({ live: true, active: true, aborted: false, binding: null });
  expect(await checkEdit(d)).toBe("error");
});
test("a throwing send never applies ok", async () => {
  const d = deps();
  d.send.mockImplementation(() => {
    throw new Error("failed");
  });
  await expect(sendCheckedEdit(d)).rejects.toThrow("failed");
  expect(d.apply).not.toHaveBeenCalled();
});
test("a changed read creates no intent and writes nothing", async () => {
  const f = fixture();
  const store = createLoanIntentStore("A", f.ports);
  const d = deps();
  d.read.mockResolvedValue({ ...opened, revision: 3 });
  const before = [...f.shared.data.entries()];
  expect(await sendCheckedEdit(d)).toEqual({ gate: "changed" });
  expect(d.send).not.toHaveBeenCalled();
  expect([...f.shared.data.entries()]).toEqual(before);
  expect(store.list()).toEqual([]);
  expect(f.server.fetchImpl).not.toHaveBeenCalled();
  store.dispose();
});
