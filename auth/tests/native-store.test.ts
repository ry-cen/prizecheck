import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { createNative, inApiNamespace } from "../src/native.js";
import {
  createNativeStore,
  NativeUnavailable,
  NATIVE_IN_FLIGHT_LIMIT,
} from "../src/nativeStore.js";

// The credential operations' own admission cap and timeout, with fake pools: no database is involved.
const TOKEN = "A".repeat(43);
const unused = () => {
  throw new Error("the shared web-auth pool must not be used");
};
const webPool = { query: unused, connect: unused } as never;

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

function native(query: (text: string, values: unknown[]) => Promise<unknown>) {
  const calls: string[] = [];
  const fake = {
    query: (text: string, values: unknown[]) => {
      calls.push(text);
      return query(text, values);
    },
  };
  return {
    calls,
    native: createNative({
      pool: webPool,
      credentials: createNativeStore(fake as never, 3, 50),
      origin: "http://localhost",
      internalSecret: "s",
      providers: [],
      rateLimits: {} as never,
      getSession: async () => null,
      clientIp: () => "127.0.0.1",
    }),
  };
}

const never = () => new Promise<never>(() => {});

describe("the credential store", () => {
  it("refuses the excess with zero further queries, and keeps the web-auth pool out of it", async () => {
    const { native: n, calls } = native(never);
    const held = [1, 2, 3].map(() => n.bearerUser(request()));
    held.forEach((promise) => promise.catch(() => {}));
    expect(calls).toHaveLength(3);
    for (let at = 0; at < 5; at++)
      await expect(n.bearerUser(request())).rejects.toBeInstanceOf(
        NativeUnavailable
      );
    expect(calls).toHaveLength(3);
  });

  it("times out a query that never answers, as unavailable, and gives the slot back", async () => {
    const { native: n, calls } = native(never);
    for (let at = 0; at < 6; at++)
      await expect(n.bearerUser(request())).rejects.toBeInstanceOf(
        NativeUnavailable
      );
    // Six sequential timeouts on a cap of three: every one reached the pool, so every slot was released.
    expect(calls).toHaveLength(6);
  });

  it("releases the slot after an error, and again after a success", async () => {
    let fail = true;
    const { native: n, calls } = native(async () => {
      if (fail) throw new Error("connection lost");
      return { rows: [{ user_id: "u1" }] };
    });
    for (let at = 0; at < 5; at++)
      await expect(n.bearerUser(request())).rejects.toBeInstanceOf(
        NativeUnavailable
      );
    fail = false;
    for (let at = 0; at < 5; at++)
      expect(await n.bearerUser(request())).toBe("u1");
    expect(calls).toHaveLength(10);
  });

  it("does no database work for a malformed, duplicated, cookie-bearing, wrong-method or off-path request", async () => {
    const { native: n, calls } = native(never);
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

  it("releases exactly as many slots as it takes under a burst", async () => {
    let answer: (value: unknown) => void = () => {};
    const { native: n } = native(
      () => new Promise((resolve) => (answer = resolve))
    );
    const first = n.bearerUser(request());
    answer({ rows: [] });
    expect(await first).toBeNull();
    expect(NATIVE_IN_FLIGHT_LIMIT).toBeGreaterThan(2);
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
