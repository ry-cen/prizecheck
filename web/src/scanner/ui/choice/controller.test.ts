import { describe, expect, it, vi } from "vitest";
import type { ScannerPrinting } from "../../../scanner_generated";
import type { LockResult } from "../../tray/store";
import {
  MAX_VERSIONS,
  createChoices,
  versionIdsFor,
  versionsFrom,
  type ChoiceHost,
  type ChoiceLock,
} from "./controller";

/** A printing with the given active finishes (descriptor `{ variant }` is what `variantLabel` reads). */
const printing = (
  id: string,
  editions: (string | [string, boolean])[] = ["normal"]
) =>
  ({
    id,
    name: `Card ${id}`,
    set_name: "Set",
    collector_number: id.toUpperCase(),
    art_url: `/api/art/${id}/small?v=0a1b2c3d`,
    default_edition_id: editions.length ? `${id}-${editions[0]}` : null,
    editions: editions.map((e) => {
      const [name, active] = Array.isArray(e) ? e : [e, true];
      return { id: `${id}-${name}`, active, descriptor: { variant: name } };
    }),
  }) as unknown as ScannerPrinting;

function setup(
  found: ScannerPrinting[] | null,
  addResult: LockResult | Error = { added: true }
) {
  const calls: string[] = [];
  const host: ChoiceHost = {
    resolve: vi.fn(async () => found),
    add: vi.fn(async (p, e) => {
      calls.push(`add ${p} ${e}`);
      if (addResult instanceof Error) throw addResult;
      return addResult;
    }),
    answer: vi.fn((id, added, reason) =>
      calls.push(`answer ${id} ${added} ${reason ?? ""}`.trim())
    ),
    settle: vi.fn((id, r) =>
      calls.push(`settle ${id} ${r.added} ${r.reason ?? ""}`.trim())
    ),
    openSearch: vi.fn(() => calls.push("search")),
  };
  return { s: createChoices(), host, calls };
}
const lock = (over: Partial<ChoiceLock> = {}): ChoiceLock => ({
  lockId: 7,
  printingIds: ["a", "b", "c"],
  lookalikes: [],
  via: "auto",
  ...over,
});
/** A host whose lookup is released by hand. */
function held() {
  let release!: (p: ScannerPrinting[] | null) => void;
  const calls: string[] = [];
  const host: ChoiceHost = {
    resolve: () => new Promise((r) => (release = r)),
    add: async (p, e) => {
      calls.push(`add ${p} ${e}`);
      return { added: true };
    },
    answer: (id, _a, reason) => calls.push(`answer ${id} ${reason}`),
    settle: (id, r) => calls.push(`settle ${id} ${r.added}`),
    openSearch: () => calls.push("search"),
  };
  return {
    s: createChoices(),
    host,
    calls,
    release: (p: ScannerPrinting[] | null) => release(p),
  };
}

describe("versionIdsFor", () => {
  it("a suggestion lists p0, look-alikes, then the other candidates, capped at 8", () => {
    const ids = versionIdsFor(
      lock({
        via: "suggest",
        printingIds: ["a", "b", "c"],
        lookalikes: ["x1", "x2", "x3", "x4", "x5", "x6", "a"],
      })
    );
    expect(ids).toEqual(["a", "x1", "x2", "x3", "x4", "x5", "x6", "b"]);
    expect(ids).toHaveLength(MAX_VERSIONS);
  });

  it("an automatic lock lists only p0 and its look-alikes", () => {
    expect(
      versionIdsFor(lock({ lookalikes: ["x", "a", "y"], via: "shutter" }))
    ).toEqual(["a", "x", "y"]);
  });
});

describe("versionsFrom", () => {
  it("keeps the order, drops versions with no active Edition, and labels finishes with variantLabel", () => {
    const out = versionsFrom(
      ["a", "b", "c"],
      [
        printing("c", ["holo"]),
        printing("a", ["normal", ["holo", false], "reverse"]),
        printing("b", [["normal", false]]),
      ]
    );
    expect(out.map((v) => v.printingId)).toEqual(["a", "c"]);
    expect(out[0]).toEqual({
      printingId: "a",
      name: "Card a",
      setLine: "Set A",
      image: "/api/art/a/small?v=0a1b2c3d",
      editions: [
        { id: "a-normal", label: expect.any(String) },
        { id: "a-reverse", label: expect.any(String) },
      ],
    });
    expect(out[0].editions[0].label).not.toBe(out[0].editions[1].label);
  });
});

describe("the Scan Choice", () => {
  it("an auto lock with one version and one active Edition adds directly, shows nothing, settles once", async () => {
    const { s, host, calls } = setup([printing("a"), printing("b")]);
    await s.onLock(lock(), host);
    expect(s.getView()).toBeNull();
    expect(host.add).toHaveBeenCalledWith("a", "a-normal", ["b", "c"]);
    expect(calls).toEqual(["add a a-normal", "settle 7 true"]);
  });

  it("an auto lock of a two-finish card shows a finish prompt", async () => {
    const { s, host, calls } = setup([printing("a", ["normal", "reverse"])]);
    await s.onLock(lock(), host);
    expect(s.getView()).toMatchObject({ lockId: 7, kind: "finish" });
    expect(s.getView()?.versions).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("look-alikes that resolve make a version prompt in the order p0, then look-alikes", async () => {
    const { s, host } = setup([
      printing("a"),
      printing("x"),
      printing("y", []),
      printing("z"),
    ]);
    await s.onLock(lock({ lookalikes: ["x", "y", "z"] }), host);
    expect(s.getView()?.kind).toBe("version");
    expect(s.getView()?.versions.map((v) => v.printingId)).toEqual([
      "a",
      "x",
      "z",
    ]);
    expect(host.resolve).toHaveBeenCalledWith(["a", "b", "c", "x", "y", "z"]);
  });

  it("suggest always prompts, ordered p0, look-alikes, other candidates, capped at 8", async () => {
    const ids = ["a", "b", "c", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
    const { s, host } = setup(ids.map((i) => printing(i)));
    await s.onLock(
      lock({
        via: "suggest",
        lookalikes: ["x1", "x2", "x3", "x4", "x5", "x6", "x7"],
      }),
      host
    );
    expect(s.getView()?.kind).toBe("suggest");
    expect(s.getView()?.versions.map((v) => v.printingId)).toEqual([
      "a",
      "x1",
      "x2",
      "x3",
      "x4",
      "x5",
      "x6",
      "x7",
    ]);
  });

  it("a suggestion of one single-finish card still prompts", async () => {
    const { s, host } = setup([printing("a")]);
    await s.onLock(lock({ via: "suggest", printingIds: ["a"] }), host);
    expect(s.getView()?.kind).toBe("suggest");
  });

  it("an unresolvable p0 on a shutter falls back to the next resolvable candidate, with no look-alikes", async () => {
    const { s, host, calls } = setup([
      printing("a", []),
      printing("b"),
      printing("x"),
    ]);
    await s.onLock(lock({ via: "shutter", lookalikes: ["x"] }), host);
    expect(s.getView()).toBeNull();
    expect(calls).toEqual(["add b b-normal", "settle 7 true"]);
  });

  it("a pick adds that Printing and Edition, then settles", async () => {
    const { s, host, calls } = setup([
      printing("a", ["normal", "reverse"]),
      printing("x"),
    ]);
    await s.onLock(lock({ lookalikes: ["x"] }), host);
    await s.pick(7, "a", "a-reverse");
    expect(host.add).toHaveBeenCalledWith("a", "a-reverse", ["b", "c", "x"]);
    expect(calls).toEqual(["add a a-reverse", "settle 7 true"]);
    expect(s.getView()).toBeNull();
    await s.pick(7, "a", "a-normal");
    s.none(7);
    s.absent(7);
    expect(calls).toHaveLength(2);
  });

  it("settles a refused pick with its result", async () => {
    const { s, host, calls } = setup([printing("a")], {
      added: false,
      reason: "full",
      verdict: "full",
    });
    await s.onLock(lock({ via: "suggest", printingIds: ["a"] }), host);
    await s.pick(7, "a", "a-normal");
    expect(calls).toEqual(["add a a-normal", "settle 7 false full"]);
  });

  it("None of these sends dismissed and opens search, once", async () => {
    const { s, host, calls } = setup([printing("a", ["normal", "reverse"])]);
    await s.onLock(lock(), host);
    s.none(7);
    s.none(7);
    s.absent(7);
    expect(calls).toEqual(["answer 7 false dismissed", "search"]);
    expect(s.getView()).toBeNull();
  });

  it("absent while shown answers dismissed once", async () => {
    const { s, host, calls } = setup([printing("a", ["normal", "reverse"])]);
    await s.onLock(lock(), host);
    s.absent(8);
    expect(s.getView()).not.toBeNull();
    s.absent(7);
    s.absent(7);
    expect(calls).toEqual(["answer 7 false dismissed"]);
    expect(s.getView()).toBeNull();
  });

  it("absent before an auto lock resolves: a direct add still adds", async () => {
    const { s, host, calls, release } = held();
    const done = s.onLock(lock(), host);
    s.absent(7);
    release([printing("a")]);
    await done;
    expect(calls).toEqual(["add a a-normal", "settle 7 true"]);
  });

  it("absent before a lock resolves into a prompt: skipped as dismissed and never shown", async () => {
    const { s, host, calls, release } = held();
    const done = s.onLock(lock({ via: "shutter" }), host);
    s.absent(7);
    release([printing("a", ["normal", "reverse"])]);
    await done;
    expect(calls).toEqual(["answer 7 dismissed"]);
    expect(s.getView()).toBeNull();
  });

  it("an absence while a suggestion is loading is answered once and nothing shows", async () => {
    const { s, host, calls, release } = held();
    const done = s.onLock(lock({ via: "suggest" }), host);
    s.absent(7);
    release([printing("a")]);
    await done;
    expect(calls).toEqual(["answer 7 dismissed"]);
    expect(s.getView()).toBeNull();
  });

  it("absent during the add of a pick or a direct add changes nothing (settled once, added)", async () => {
    const direct = setup([printing("a")]);
    let finish!: (r: LockResult) => void;
    direct.host.add = vi.fn(() => new Promise<LockResult>((r) => (finish = r)));
    const done = direct.s.onLock(lock(), direct.host);
    await vi.waitFor(() => expect(direct.host.add).toHaveBeenCalled());
    direct.s.absent(7);
    direct.s.none(7);
    finish({ added: true });
    await done;
    expect(direct.calls).toEqual(["settle 7 true"]);

    const picked = setup([printing("a", ["normal", "reverse"])]);
    await picked.s.onLock(lock(), picked.host);
    const pick = picked.s.pick(7, "a", "a-normal");
    picked.s.absent(7);
    await pick;
    expect(picked.calls).toEqual(["add a a-normal", "settle 7 true"]);
  });

  it("a second lock arriving while the first is still resolving dismisses the first once, and the first's late lookup shows nothing", async () => {
    const first = held();
    const calls = first.calls;
    const one = first.s.onLock(lock({ lockId: 1 }), first.host);
    const second: ChoiceHost = {
      ...first.host,
      resolve: async () => [printing("a", ["normal", "reverse"])],
    };
    await first.s.onLock(lock({ lockId: 2 }), second);
    first.release([printing("a", ["normal", "reverse"])]);
    await one;
    expect(calls).toEqual(["answer 1 dismissed"]);
    expect(first.s.getView()).toMatchObject({ lockId: 2 });
  });

  it("reset dismisses the pending lock once; its late lookup shows nothing", async () => {
    const { s, host, calls, release } = held();
    const done = s.onLock(lock({ via: "suggest" }), host);
    s.reset();
    s.reset();
    release([printing("a", ["normal", "reverse"])]);
    await done;
    expect(calls).toEqual(["answer 7 dismissed"]);
    expect(s.getView()).toBeNull();
  });

  it("reset with an open prompt closes it, answers once, and ignores a later pick or none", async () => {
    const { s, host, calls } = setup([printing("a", ["normal", "reverse"])]);
    await s.onLock(lock(), host);
    expect(s.getView()).not.toBeNull();
    s.reset();
    await s.pick(7, "a", "a-normal");
    s.none(7);
    expect(s.getView()).toBeNull();
    expect(calls).toEqual(["answer 7 false dismissed"]);
  });

  it("reset does not throw when the session it answers is gone", async () => {
    const { s, host } = setup([printing("a", ["normal", "reverse"])]);
    host.answer = vi.fn(() => {
      throw new Error("disposed");
    });
    await s.onLock(lock(), host);
    expect(() => s.reset()).not.toThrow();
    expect(s.getView()).toBeNull();
  });

  it("a pick or none for a lock that is no longer pending is ignored", async () => {
    const { s, host, calls } = setup([printing("a", ["normal", "reverse"])]);
    await s.onLock(lock(), host);
    await s.pick(6, "a", "a-normal");
    s.none(6);
    expect(s.getView()).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it("a single-finish version is shown with its finish label for the button", async () => {
    const { s, host } = setup([
      printing("a"),
      printing("b", ["normal", "reverse"]),
    ]);
    await s.onLock(lock({ lookalikes: ["b"] }), host);
    const view = s.getView();
    expect(view?.versions[0].editions).toEqual([
      { id: "a-normal", label: expect.any(String) },
    ]);
    expect(view?.versions[0].editions[0].label).not.toBe("");
  });

  it("a throwing add settles offline once", async () => {
    const { s, host, calls } = setup([printing("a")], new Error("boom"));
    await s.onLock(lock(), host);
    expect(calls).toEqual(["add a a-normal", "settle 7 false offline"]);
  });

  it("offline and unresolved settle as before", async () => {
    const offline = setup(null);
    await offline.s.onLock(lock(), offline.host);
    expect(offline.calls).toEqual(["settle 7 false offline"]);
    const none = setup([printing("a", [])]);
    await none.s.onLock(lock({ via: "suggest" }), none.host);
    expect(none.calls).toEqual(["settle 7 false unresolved"]);
    expect(none.s.getView()).toBeNull();
  });
});
