import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { createNative, inApiNamespace } from "../src/native.js";
import {
  createNativeStore,
  NativeUnavailable,
  NATIVE_LIMITS,
  type NativeDb,
  type NativeLimits,
} from "../src/nativeStore.js";
import { createNativeRateLimits } from "../src/nativeRateLimits.js";
import { createRateLimits } from "../src/rateLimits.js";
import { createShutdown } from "../src/nativeShutdown.js";

// The native database operations' admission, deadline and slot accounting, with fake pools: no database is involved.
const TOKEN = "A".repeat(43);

/** A fake pool whose queries stay pending until the test settles them. */
function fakeDb() {
  const calls: string[] = [];
  const pending: {
    resolve: (rows: unknown[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  const db = {
    query: (text: string) => {
      calls.push(text);
      return new Promise((resolve, reject) =>
        pending.push({
          resolve: (rows) => resolve({ rows }),
          reject,
        })
      );
    },
    connect: async () => {
      throw new Error("no client in this fake");
    },
  } as unknown as NativeDb;
  return { db, calls, pending };
}

const limits = (held: number, running: number): NativeLimits => ({
  read: { held, running },
  revoke: { held, running },
  exchange: { held, running },
  approve: { held, running },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("admission", () => {
  it("refuses the excess before any SQL: one read runs, three wait, the fifth is refused", async () => {
    const { db, calls } = fakeDb();
    const store = createNativeStore(db, { deadlineMs: 1000 });
    const first = [1, 2, 3, 4].map(() => store.rows("read", "SELECT 1", []));
    first.forEach((promise) => promise.catch(() => {}));
    await tick();
    expect(NATIVE_LIMITS.read).toEqual({ held: 4, running: 1 });
    expect(calls).toHaveLength(1);
    // Refused at once (the deadline is a second away), not after waiting for it.
    const fifth = store.rows("read", "SELECT 2", []);
    const outcome = await Promise.race([
      fifth.then(
        () => "ran",
        (error) => (error instanceof NativeUnavailable ? "refused" : "failed")
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 150)),
    ]);
    expect(outcome).toBe("refused");
    expect(calls).toHaveLength(1);
  });

  it("keeps the slot until the query settles, not until the response deadline", async () => {
    const { db, calls, pending } = fakeDb();
    const store = createNativeStore(db, {
      limits: limits(1, 1),
      deadlineMs: 30,
    });
    // The first caller gives up at the deadline; its query is still running.
    await expect(store.rows("read", "Q1", [])).rejects.toBeInstanceOf(
      NativeUnavailable
    );
    expect(calls).toEqual(["Q1"]);
    // The cap still holds: the next one is refused with no SQL, although the first response was answered long ago.
    await expect(store.rows("read", "Q2", [])).rejects.toBeInstanceOf(
      NativeUnavailable
    );
    expect(calls).toEqual(["Q1"]);
    // The abandoned query settles: the slot comes back and the next one runs.
    pending[0].resolve([]);
    await tick();
    const next = store.rows("read", "Q3", []);
    next.catch(() => {});
    await tick();
    expect(calls).toEqual(["Q1", "Q3"]);
    pending[1].resolve([{ n: 1 }]);
    expect(await next).toEqual([{ n: 1 }]);
  });

  it("does not run a queued operation whose deadline passed, and gives its place back", async () => {
    const { db, calls, pending } = fakeDb();
    const store = createNativeStore(db, {
      limits: limits(2, 1),
      deadlineMs: 30,
    });
    const running = store.rows("read", "RUNNING", []);
    running.catch(() => {});
    await expect(store.rows("read", "QUEUED", [])).rejects.toBeInstanceOf(
      NativeUnavailable
    );
    pending[0].resolve([]);
    await tick();
    expect(calls).toEqual(["RUNNING"]);
    // Both places are free again.
    for (const text of ["A", "B"]) {
      const one = store.rows("read", text, []);
      one.catch(() => {});
      await tick();
      pending[pending.length - 1].resolve([]);
      await one;
    }
    expect(calls).toEqual(["RUNNING", "A", "B"]);
  });

  it("releases the slot after an error, and after work that throws", async () => {
    const { db, calls, pending } = fakeDb();
    const store = createNativeStore(db, {
      limits: limits(1, 1),
      deadlineMs: 1000,
    });
    for (let at = 0; at < 3; at++) {
      const failed = store.rows("revoke", "UPDATE", []);
      failed.catch(() => {});
      await tick();
      pending[at].reject(new Error("connection lost"));
      await expect(failed).rejects.toBeInstanceOf(NativeUnavailable);
    }
    for (let at = 0; at < 3; at++)
      await expect(
        store.run("exchange", async () => {
          throw new Error("boom");
        })
      ).rejects.toBeInstanceOf(NativeUnavailable);
    expect(calls).toHaveLength(3);
    const ok = store.run("exchange", async () => 7);
    expect(await ok).toBe(7);
  });

  it("keeps the classes apart: a stuck read never blocks a revoke, and reads run one at a time", async () => {
    const { db, calls, pending } = fakeDb();
    const store = createNativeStore(db, { deadlineMs: 1000 });
    const reads = [1, 2, 3].map((n) => store.rows("read", `READ${n}`, []));
    reads.forEach((promise) => promise.catch(() => {}));
    await tick();
    // Only one read holds a connection; the others wait in memory.
    expect(calls).toEqual(["READ1"]);
    const revoke = store.rows("revoke", "REVOKE", []);
    revoke.catch(() => {});
    await tick();
    expect(calls).toEqual(["READ1", "REVOKE"]);
    pending[1].resolve([]);
    await revoke;
    pending[0].resolve([]);
    await tick();
    expect(calls).toEqual(["READ1", "REVOKE", "READ2"]);
  });
});

describe("the commit point", () => {
  it("commits nothing once the deadline has answered", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let committed = false;
    const store = createNativeStore(fakeDb().db, {
      limits: limits(1, 1),
      deadlineMs: 30,
    });
    await expect(
      store.run("exchange", async (_db, commitPoint) => {
        await gate;
        commitPoint();
        committed = true;
        return 1;
      })
    ).rejects.toBeInstanceOf(NativeUnavailable);
    release();
    await tick();
    expect(committed).toBe(false);
    // The slot is free again.
    expect(await store.run("exchange", async () => 2)).toBe(2);
  });

  it("waits for the outcome, past the deadline, once the commit point has passed", async () => {
    const store = createNativeStore(fakeDb().db, { deadlineMs: 30 });
    const value = await store.run("exchange", async (_db, commitPoint) => {
      commitPoint();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 7;
    });
    expect(value).toBe(7);
  });

  it("answers unavailable when the commit itself fails", async () => {
    const store = createNativeStore(fakeDb().db, {
      limits: limits(1, 1),
      deadlineMs: 30,
    });
    await expect(
      store.run("exchange", async (_db, commitPoint) => {
        commitPoint();
        throw new Error("connection lost");
      })
    ).rejects.toBeInstanceOf(NativeUnavailable);
    expect(await store.run("exchange", async () => 3)).toBe(3);
  });
});

// A request with the raw header list a real one has.
function request(
  extra: string[] = [],
  method = "GET",
  url = "/api/collection"
): IncomingMessage {
  const raw = ["Authorization", `Bearer ${TOKEN}`, ...extra];
  const headers: Record<string, string> = {};
  for (let at = 0; at < raw.length; at += 2)
    headers[raw[at].toLowerCase()] ??= raw[at + 1];
  return { method, url, rawHeaders: raw, headers } as never;
}

function native() {
  const { db, calls } = fakeDb();
  return {
    calls,
    native: createNative({
      store: createNativeStore(db, { deadlineMs: 30 }),
      origin: "http://localhost",
      internalSecret: "s",
      providers: [],
      rateLimits: createNativeRateLimits(),
      getSession: async () => null,
      clientIp: () => "127.0.0.1",
    }),
  };
}

describe("the bearer lookup", () => {
  it("does no database work for a malformed, duplicated, cookie-bearing, wrong-method or off-path request", async () => {
    const { native: n, calls } = native();
    const bad = [
      request(["Authorization", `Bearer ${TOKEN}`]),
      request(["Cookie", "a=b"]),
      request([], "POST"),
      request([], "GET", "/api/collection/x"),
      request([], "GET", "/api/collection?"),
      { ...request(), rawHeaders: ["Authorization", "Bearer x"] },
    ];
    for (const one of bad) expect(await n.bearerUser(one as never)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("answers unavailable, not null, for a well-formed bearer when the database does not answer", async () => {
    const { native: n, calls } = native();
    await expect(n.bearerUser(request())).rejects.toBeInstanceOf(
      NativeUnavailable
    );
    expect(calls).toHaveLength(1);
  });
});

describe("the limiters' locks", () => {
  function recorder() {
    const queries: { text: string; values?: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (/FROM auth_rate_event|FROM native_rate_event/.test(text))
          return { rows: [{ from_ip: "0", total: "0", n: 0 }] };
        return { rows: [] };
      },
      release: () => {},
      on: () => {},
      removeListener: () => {},
    };
    const db = { connect: async () => client, query: client.query };
    return { db: db as never, queries };
  }
  const lockOf = (queries: { text: string; values?: unknown[] }[]) =>
    queries.find((q) => /pg_advisory_xact_lock/.test(q.text))?.values;

  it("takes the native lock key for the native limits and leaves the web limits' key alone", async () => {
    for (const run of [
      (db: never) => createNativeRateLimits().allowNativeApprove(db, "1.2.3.4"),
      (db: never) => createNativeRateLimits().allowNativeToken(db, "1.2.3.4"),
    ]) {
      const { db, queries } = recorder();
      expect(await run(db)).toBe(true);
      expect(lockOf(queries)).toEqual([914708]);
      // The native limits never name the web limiter's table.
      expect(queries.some((q) => /auth_rate_event/.test(q.text))).toBe(false);
      expect(queries.some((q) => /native_rate_event/.test(q.text))).toBe(true);
    }
    const web = recorder();
    expect(
      await createRateLimits(web.db as never, 100).allowStart("1.2.3.4")
    ).toBe(true);
    expect(lockOf(web.queries)).toEqual([914704]);
    expect(web.queries.some((q) => /native_rate_event/.test(q.text))).toBe(
      false
    );
    const signup = recorder();
    expect(
      await createRateLimits(signup.db as never, 100).allowSignup("1.2.3.4")
    ).toBe(true);
    expect(lockOf(signup.queries)).toEqual([914704]);
  });
});

describe("the API namespace, read on the raw target", () => {
  const origin = "http://localhost";
  it("treats a backslash after the host of an absolute-form target as the path boundary", () => {
    for (const target of [
      "http://h\\api\\..\\health",
      "http://h\\api/collection",
      "http://h/api/../health",
      "/api\\..\\health",
      "/api/pokemon/../../health",
    ])
      expect(inApiNamespace(target, origin), target).toBe(true);
    for (const target of ["/", "/auth/session", "http://h/health", "/apix"])
      expect(inApiNamespace(target, origin), target).toBe(false);
  });
});

describe("the shutdown", () => {
  function parts() {
    const events: string[] = [];
    let closeDone: () => void = () => {};
    const server = {
      close: (done: () => void) => {
        events.push("close");
        closeDone = done;
      },
      closeIdleConnections: () => events.push("idle"),
      closeAllConnections: () => events.push("all"),
    };
    const pool = {
      end: async () => {
        events.push("end");
      },
    };
    const exit = (code: number) => events.push(`exit${code}`);
    return { events, server, pool, exit, finish: () => closeDone() };
  }

  it("stops intake, drains, closes the pool once and exits once, however many signals arrive", async () => {
    const p = parts();
    const shutdown = createShutdown({
      server: p.server,
      pool: p.pool,
      exit: p.exit,
      drainMs: 1000,
    });
    const first = shutdown();
    shutdown();
    shutdown();
    await tick();
    expect(p.events).toEqual(["close", "idle"]);
    p.finish();
    await first;
    expect(p.events).toEqual(["close", "idle", "end", "exit0"]);
    await shutdown();
    expect(p.events.filter((e) => e === "end")).toHaveLength(1);
  });

  it("drops the remaining connections when the drain deadline passes, then still ends the pool once", async () => {
    const p = parts();
    const shutdown = createShutdown({
      server: p.server,
      pool: p.pool,
      exit: p.exit,
      drainMs: 20,
    });
    const done = shutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(p.events).toEqual(["close", "idle", "all"]);
    p.finish();
    await done;
    expect(p.events).toEqual(["close", "idle", "all", "end", "exit0"]);
  });

  it("does not wait for a pool that never ends", async () => {
    const p = parts();
    const shutdown = createShutdown({
      server: p.server,
      pool: { end: () => new Promise(() => {}) },
      exit: p.exit,
      poolMs: 20,
    });
    const done = shutdown();
    p.finish();
    await done;
    expect(p.events.at(-1)).toBe("exit0");
  });
});
