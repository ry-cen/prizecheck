import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNative } from "../src/native.js";
import {
  createNativeStore,
  withNativeClient,
  type NativeDb,
} from "../src/nativeStore.js";
import { createNativeRateLimits } from "../src/nativeRateLimits.js";

// A connection that fails while a native operation holds its client, with mocked clients: no database is involved. A pooled
// client has no 'error' listener while checked out, so each mock counts an error that arrives with nobody listening as
// `unhandled` (a real one would crash the process).

type Script = (text: string, client: MockClient) => Promise<unknown> | unknown;

class MockClient extends EventEmitter {
  queries: string[] = [];
  releases: (Error | undefined)[] = [];
  unhandled: Error[] = [];
  listenersDuringQueries: number[] = [];
  constructor(private readonly script: Script) {
    super();
  }
  /** The connection drops now: delivered as the event pg emits, which crashes the process if nothing listens. */
  lose(error = new Error("connection terminated")) {
    if (this.listenerCount("error") === 0) this.unhandled.push(error);
    else this.emit("error", error);
    return error;
  }
  async query(text: string) {
    this.queries.push(text);
    this.listenersDuringQueries.push(this.listenerCount("error"));
    return this.script(text, this);
  }
  release(error?: Error) {
    // pg-pool throws on a second release.
    if (this.releases.length > 0) throw new Error("released twice");
    this.releases.push(error);
  }
}

function dbOf(...clients: MockClient[]) {
  const queue = [...clients];
  const db = {
    connect: async () => {
      const next = queue.shift();
      if (!next) throw new Error("no more clients");
      return next;
    },
    query: async () => ({ rows: [] }),
  } as unknown as NativeDb;
  return db;
}

/** The limiter's transaction: permitted. */
const limiterOk: Script = (text) =>
  /count\(\*\)/.test(text) ? { rows: [{ n: 0 }] } : { rows: [] };

/** The exchange's transaction: a matching grant, then an issued credential. */
const exchangeOk: Script = (text) => {
  if (/^DELETE FROM native_grant/.test(text))
    return { rowCount: 1, rows: [{ user_id: "u1" }] };
  if (/^INSERT INTO native_credential/.test(text))
    return { rows: [{ expires_at: new Date("2030-01-01T00:00:00Z") }] };
  return { rows: [] };
};

function withScript(base: Script, over: Script): Script {
  return (text, client) => {
    const own = over(text, client);
    return own === undefined ? base(text, client) : own;
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("withNativeClient", () => {
  it("listens for errors from before the work to after it, then lets go of the client once", async () => {
    const client = new MockClient(() => ({ rows: [] }));
    let during = -1;
    const value = await withNativeClient(dbOf(client), async (c) => {
      during = client.listenerCount("error");
      await c.query("SELECT 1");
      return 5;
    });
    expect(value).toBe(5);
    expect(during).toBe(1);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.releases).toEqual([undefined]);
  });

  it("returns the work's result but retires the client when the connection reports an error", async () => {
    const client = new MockClient(() => ({ rows: [] }));
    const lost = new Error("terminated");
    const value = await withNativeClient(dbOf(client), async () => {
      client.lose(lost);
      return "done";
    });
    expect(value).toBe("done");
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("never masks the work's own failure with a connection error, and releases with the failure", async () => {
    const client = new MockClient(() => ({ rows: [] }));
    const original = new Error("constraint violated");
    await expect(
      withNativeClient(dbOf(client), async () => {
        client.lose(new Error("terminated afterwards"));
        throw original;
      })
    ).rejects.toBe(original);
    expect(client.releases).toEqual([original]);
    expect(client.unhandled).toEqual([]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("wraps a thrown non-Error so the pool still discards the client", async () => {
    const client = new MockClient(() => ({ rows: [] }));
    await expect(
      withNativeClient(dbOf(client), async () => {
        throw "plain string";
      })
    ).rejects.toBe("plain string");
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBeInstanceOf(Error);
  });

  it("takes no listener and releases nothing when the checkout itself fails", async () => {
    const db = {
      connect: async () => {
        throw new Error("no connection");
      },
    } as unknown as NativeDb;
    await expect(withNativeClient(db, async () => 1)).rejects.toThrow(
      "no connection"
    );
  });
});

describe("the limiter's checkout", () => {
  const take = (client: MockClient) =>
    createNativeRateLimits().allowNativeToken(dbOf(client), "1.2.3.4");

  it("is unchanged on the happy path: one release, no error, listener gone", async () => {
    const client = new MockClient(limiterOk);
    expect(await take(client)).toBe(true);
    expect(client.queries.at(-1)).toBe("COMMIT");
    expect(client.releases).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
    expect(Math.min(...client.listenersDuringQueries)).toBe(1);
  });

  it("handles a lost connection before the COMMIT: the original failure comes out, the client is discarded", async () => {
    const lost = new Error("terminated before commit");
    const client = new MockClient(
      withScript(limiterOk, (text, c) => {
        if (/count\(\*\)/.test(text)) {
          c.lose(lost);
          throw lost;
        }
      })
    );
    await expect(take(client)).rejects.toBe(lost);
    expect(client.unhandled).toEqual([]);
    expect(client.queries).toContain("ROLLBACK");
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("handles a lost connection during the COMMIT", async () => {
    const lost = new Error("terminated during commit");
    const client = new MockClient(
      withScript(limiterOk, (text, c) => {
        if (text === "COMMIT") {
          c.lose(lost);
          throw lost;
        }
      })
    );
    await expect(take(client)).rejects.toBe(lost);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("handles a lost connection just after the COMMIT: the committed answer stands, the client is discarded", async () => {
    const lost = new Error("terminated after commit");
    const client = new MockClient(
      withScript(limiterOk, (text, c) => {
        if (text === "COMMIT") {
          c.lose(lost);
          return { rows: [] };
        }
      })
    );
    expect(await take(client)).toBe(true);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("handles a lost connection during the ROLLBACK without replacing the first failure", async () => {
    const first = new Error("statement failed");
    const client = new MockClient(
      withScript(limiterOk, (text, c) => {
        if (/count\(\*\)/.test(text)) throw first;
        if (text === "ROLLBACK") {
          c.lose(new Error("terminated during rollback"));
          throw new Error("rollback failed");
        }
      })
    );
    await expect(take(client)).rejects.toBe(first);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([first]);
    expect(client.listenerCount("error")).toBe(0);
  });
});

function tokenRequest(): IncomingMessage {
  const body = JSON.stringify({
    code: "A".repeat(43),
    verifier: "B".repeat(43),
  });
  return Object.assign(Readable.from([body]), {
    method: "POST",
    url: "/auth/native/token",
    headers: { "content-type": "application/json" },
    rawHeaders: [],
  }) as unknown as IncomingMessage;
}

function responseOf() {
  const out = { status: 0, body: "" };
  const response = {
    writeHead: (status: number) => (out.status = status),
    setHeader: () => {},
    end: (body?: string) => (out.body = body ?? ""),
  };
  return { out, response: response as unknown as ServerResponse };
}

describe("the code exchange's checkout", () => {
  /** Runs one exchange: the limiter on its client, then the swap on `exchange`. The exchange class holds one slot. */
  async function exchange(client: MockClient, deadlineMs = 1000) {
    const limiter = new MockClient(limiterOk);
    const db = dbOf(limiter, client);
    const store = createNativeStore(db, {
      deadlineMs,
      limits: {
        read: { held: 1, running: 1 },
        revoke: { held: 1, running: 1 },
        exchange: { held: 1, running: 1 },
        approve: { held: 1, running: 1 },
      },
    });
    const n = createNative({
      store,
      origin: "http://localhost",
      internalSecret: "s",
      providers: [],
      rateLimits: createNativeRateLimits(),
      getSession: async () => null,
      clientIp: () => "127.0.0.1",
    });
    const { out, response } = responseOf();
    await n.handle(tokenRequest(), response, "/auth/native/token");
    return { out, limiter, store };
  }

  /** The slot went back exactly once: one operation fits, a concurrent second is refused, never a negative count. */
  async function slotIsFreeOnce(store: ReturnType<typeof createNativeStore>) {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first = store.run("exchange", () => hold);
    first.catch(() => {});
    await tick();
    await expect(store.run("exchange", async () => 1)).rejects.toThrow(
      "native database unavailable"
    );
    release();
    await first;
    expect(await store.run("exchange", async () => 2)).toBe(2);
  }

  it("issues a credential on the happy path with the client released clean", async () => {
    const client = new MockClient(exchangeOk);
    const { out, store } = await exchange(client);
    expect(out.status).toBe(200);
    expect(client.queries).toEqual([
      "BEGIN",
      expect.stringMatching(/^DELETE FROM native_grant/),
      expect.stringMatching(/^DELETE FROM native_credential/),
      expect.stringMatching(/^INSERT INTO native_credential/),
      "COMMIT",
    ]);
    expect(client.releases).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
    expect(Math.min(...client.listenersDuringQueries)).toBe(1);
    await slotIsFreeOnce(store);
  });

  it("answers 503 and discards the client when the connection is lost before the COMMIT", async () => {
    const lost = new Error("terminated before commit");
    const client = new MockClient(
      withScript(exchangeOk, (text, c) => {
        if (/^INSERT INTO native_credential/.test(text)) {
          c.lose(lost);
          throw lost;
        }
      })
    );
    const { out, store } = await exchange(client);
    expect(out.status).toBe(503);
    expect(client.unhandled).toEqual([]);
    expect(client.queries).not.toContain("COMMIT");
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
    await slotIsFreeOnce(store);
  });

  it("answers 503 and discards the client when the connection is lost during the COMMIT", async () => {
    const lost = new Error("terminated during commit");
    const client = new MockClient(
      withScript(exchangeOk, (text, c) => {
        if (text === "COMMIT") {
          c.lose(lost);
          throw lost;
        }
      })
    );
    const { out, store } = await exchange(client);
    expect(out.status).toBe(503);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
    await slotIsFreeOnce(store);
  });

  it("keeps the committed answer when the connection is lost just after the COMMIT, and discards the client", async () => {
    const lost = new Error("terminated after commit");
    const client = new MockClient(
      withScript(exchangeOk, (text, c) => {
        if (text === "COMMIT") {
          c.lose(lost);
          return { rows: [] };
        }
      })
    );
    const { out, store } = await exchange(client);
    expect(out.status).toBe(200);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount("error")).toBe(0);
    await slotIsFreeOnce(store);
  });

  it("answers 503 and releases with the first failure when the connection is lost during the ROLLBACK", async () => {
    const first = new Error("insert failed");
    const client = new MockClient(
      withScript(exchangeOk, (text, c) => {
        if (/^INSERT INTO native_credential/.test(text)) throw first;
        if (text === "ROLLBACK") {
          c.lose(new Error("terminated during rollback"));
          throw new Error("rollback failed");
        }
      })
    );
    const { out, store } = await exchange(client);
    expect(out.status).toBe(503);
    expect(client.unhandled).toEqual([]);
    expect(client.releases).toEqual([first]);
    expect(client.listenerCount("error")).toBe(0);
    await slotIsFreeOnce(store);
  });

  it("answers 400 invalid_grant for a wrong verifier and keeps the client", async () => {
    const client = new MockClient(
      withScript(exchangeOk, (text) => {
        if (/^DELETE FROM native_grant/.test(text))
          return { rowCount: 0, rows: [] };
      })
    );
    const { out } = await exchange(client);
    expect(out.status).toBe(400);
    expect(client.queries).toEqual([
      "BEGIN",
      expect.stringMatching(/^DELETE FROM native_grant/),
      "ROLLBACK",
    ]);
    expect(client.releases).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
  });
});
