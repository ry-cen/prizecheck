import { vi } from "vitest";
import { VOID_PATH, type LoanPorts } from "../loanIntents";
export function sharedStorage(
  options: {
    throwOn?: (op: "get" | "set" | "remove", key: string) => boolean;
  } = {}
) {
  const data = new Map<string, string>();
  const tabs: Set<
    (e: { key: string | null; newValue: string | null }) => void
  >[] = [];
  return {
    data,
    tab() {
      const listeners = new Set<
        (e: { key: string | null; newValue: string | null }) => void
      >();
      tabs.push(listeners);
      function event(key: string, newValue: string | null) {
        for (const tab of tabs)
          if (tab !== listeners) for (const fn of tab) fn({ key, newValue });
      }
      function fail(op: "get" | "set" | "remove", key: string) {
        if (options.throwOn?.(op, key)) throw new Error("storage refused");
      }
      const storage: Storage = {
        get length() {
          return data.size;
        },
        key: (i) => [...data.keys()][i] ?? null,
        getItem(key) {
          fail("get", key);
          return data.get(key) ?? null;
        },
        setItem(key, value) {
          fail("set", key);
          const old = data.get(key);
          data.set(key, value);
          if (old !== value) event(key, value);
        },
        removeItem(key) {
          fail("remove", key);
          const had = data.delete(key);
          if (had) event(key, null);
        },
        clear() {
          for (const key of [...data.keys()]) this.removeItem(key);
        },
      };
      return {
        storage,
        onStorage: (
          fn: (e: { key: string | null; newValue: string | null }) => void
        ) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      };
    },
  };
}
export function sharedLocks(): Pick<LockManager, "request"> {
  const held = new Set<string>();
  async function request<T>(
    name: string,
    callback: LockGrantedCallback<T>
  ): Promise<T>;
  async function request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>
  ): Promise<T>;
  async function request<T>(
    name: string,
    options: LockOptions | LockGrantedCallback<T>,
    supplied?: LockGrantedCallback<T>
  ): Promise<T> {
    const callback = typeof options === "function" ? options : supplied!;
    if (held.has(name)) return callback(null);
    held.add(name);
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      held.delete(name);
    }
  }
  return { request };
}
export type Profile = "s1" | "dev-pre-d3" | "stack-pre-d3";
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export const reply = (status: number, json: unknown) =>
  new Response(JSON.stringify(json), { status });
export function fakeServer(initial: Profile = "s1") {
  let profile = initial;
  const server = {
    cookie: "A" as string | null,
    receipts: new Map<string, { digest: string; response: unknown } | "void">(),
    effects: new Map<string, number>(),
    loseNextAnswer: false,
    beforeAnswer: (_path: string): void => {},
    gate: (_path: string): Promise<void> | undefined => undefined,
    setProfile(value: Profile) {
      profile = value;
    },
    fetchImpl: vi.fn<typeof fetch>(),
  };
  server.fetchImpl.mockImplementation(async (input, init) => {
    const path = String(input),
      cookie = server.cookie;
    const payload = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    let response: Response;
    if (path === "/auth/session")
      response = reply(200, { signedIn: cookie !== null, userId: cookie });
    else if (cookie === null) response = reply(401, {});
    else if (path === VOID_PATH && profile !== "s1") response = reply(404, {});
    else if (profile === "s1" && payload.account_id !== cookie)
      response = reply(409, { detail: { code: "ACCOUNT_CHANGED" } });
    else if (path === VOID_PATH) {
      const key = `${cookie}:${payload.idempotency_key}`,
        receipt = server.receipts.get(key);
      if (!receipt) server.receipts.set(key, "void");
      response = reply(200, {
        outcome: receipt && receipt !== "void" ? "applied" : "void",
        account_id: cookie,
      });
    } else if (
      profile === "stack-pre-d3" &&
      path !== "/api/loans/offers" &&
      path !== "/api/loans/borrowed/move"
    )
      response = reply(422, {});
    else {
      const key = `${cookie}:${payload.idempotency_key}`,
        receipt = server.receipts.get(key),
        digest = String(init?.body);
      if (receipt === "void")
        response = reply(409, { detail: { code: "IDEMPOTENCY_KEY_VOID" } });
      else if (receipt && receipt.digest !== digest)
        response = reply(409, { detail: { code: "IDEMPOTENCY_KEY_REUSED" } });
      else {
        const result = receipt?.response ?? {
          id: "00000000-0000-4000-8000-000000000001",
        };
        if (!receipt) {
          server.receipts.set(key, { digest, response: result });
          server.effects.set(cookie, (server.effects.get(cookie) ?? 0) + 1);
        }
        response = reply(201, result);
      }
    }
    server.beforeAnswer(path);
    const gate = server.gate(path);
    if (gate)
      await new Promise<void>((resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        else {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
          gate.then(resolve, reject);
        }
      });
    if (
      path !== "/auth/session" &&
      path !== VOID_PATH &&
      server.loseNextAnswer
    ) {
      server.loseNextAnswer = false;
      throw new Error("lost answer");
    }
    return response;
  });
  return server;
}
export function fixture() {
  const shared = sharedStorage(),
    storage = shared.tab(),
    server = fakeServer();
  let sequence = 0;
  const ports: LoanPorts = {
    ...storage,
    locks: sharedLocks(),
    fetchImpl: server.fetchImpl,
    now: () => 1,
    uuid: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
  return { shared, server, ports };
}
