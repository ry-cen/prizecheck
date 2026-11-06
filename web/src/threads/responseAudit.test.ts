import { EventEmitter } from "node:events";
import type { CDPSession, Page, Response } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import {
  AUDIT_DRAIN_TIMEOUT_MS,
  DOCUMENT_REPLACED,
  auditPage,
  routeShape,
  responseAudit,
  AUDIT_BODY_BUFFER_BYTES,
} from "../../tests/support/responseAudit";

afterEach(() => vi.useRealTimers());
const info = { method: "GET", url: "https://test/api/trades/item" };

function harness() {
  let events!: Parameters<Parameters<typeof responseAudit>[0]>[0];
  const detach = vi.fn();
  const audit = responseAudit((listener) => {
    events = listener;
    return detach;
  });
  return { audit, events, detach };
}

it("includes already-started journey responses arriving during final drain, and excludes teardown requests", async () => {
  const { audit, events, detach } = harness();
  const first = {},
    held = {},
    teardown = {};
  events.started(first, info);
  events.started(held, info);
  let release!: (body: string) => void;
  events.response(first, {
    text: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const completed = audit.finish();
  expect(detach).not.toHaveBeenCalled();
  const late = vi.fn(async () => "counterpart private Deck name");
  events.response(held, { text: late });
  events.started(teardown, info);
  const teardownBody = vi.fn(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  events.response(teardown, { text: teardownBody });
  expect(teardownBody).not.toHaveBeenCalled();
  release("ordinary public terms");
  await expect(completed).resolves.toEqual([
    "ordinary public terms",
    "counterpart private Deck name",
  ]);
  expect(late).toHaveBeenCalledTimes(1);
  expect(detach).toHaveBeenCalledTimes(1);
  audit.dispose();
  expect(detach).toHaveBeenCalledTimes(1);
});

it("still fails every unexpected captured body error, including context closure", async () => {
  const { audit, events } = harness();
  const request = {};
  events.started(request, info);
  const error = new Error("Target page, context or browser has been closed");
  events.response(request, {
    text: async () => {
      throw error;
    },
  });
  await Promise.resolve();
  await expect(audit.finish()).rejects.toBe(error);
});

it("keeps valid bodies non-vacuous and explicitly accounts for navigation-discarded bodies", async () => {
  const { audit, events } = harness();
  const valid = {},
    discarded = {};
  events.started(valid, info);
  events.started(discarded, info);
  events.response(valid, { text: async () => '{"public":"cards"}' });
  events.response(discarded, {
    text: async () => {
      throw new Error(
        "Response unavailable: navigated away from this document"
      );
    },
  });
  await expect(audit.finish()).resolves.toEqual(['{"public":"cards"}']);
  expect(audit.abortedRequests).toEqual([
    { request: discarded, reason: "application navigation discarded response" },
  ]);
});

it("waits for a tracked pre-header application abort and records its exact identity", async () => {
  const { audit, events, detach } = harness();
  const request = {};
  events.started(request, info);
  const completed = audit.finish();
  expect(detach).not.toHaveBeenCalled();
  events.failed(request, "net::ERR_ABORTED");
  await expect(completed).resolves.toEqual([]);
  expect(audit.abortedRequests).toEqual([
    { request, reason: "net::ERR_ABORTED" },
  ]);
  expect(detach).toHaveBeenCalledTimes(1);
});

it("does not disguise an unexpected request failure as an application abort", async () => {
  const { audit, events } = harness();
  const request = {};
  events.started(request, info);
  events.failed(request, "net::ERR_FAILED");
  await expect(audit.finish()).rejects.toThrow(
    "Unexpected audited request failure: net::ERR_FAILED"
  );
});

it("failed-journey disposal detaches but can never satisfy a later privacy proof", async () => {
  const { audit, events, detach } = harness();
  events.started({}, info);
  audit.stop();
  audit.dispose();
  await expect(audit.finish()).rejects.toThrow("Privacy audit was abandoned");
  expect(detach).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "external disposal cannot pass an unfinished final proof with already-settled inputs (empty=%s)",
  async (empty) => {
    const { audit, events, detach } = harness();
    if (!empty) {
      const request = {};
      events.started(request, info);
      events.response(request, { text: async () => "public terms" });
      await Promise.resolve();
      await Promise.resolve();
    }
    const final = audit.finish();
    audit.dispose();
    await expect(final).rejects.toThrow(
      "Privacy audit disposed before completion"
    );
    await expect(audit.finish()).rejects.toThrow();
    expect(detach).toHaveBeenCalledTimes(1);
  }
);

it.each(["headers", "body"] as const)(
  "bounds an admitted request that never completes its %s, naming method and URL",
  async (stage) => {
    vi.useFakeTimers();
    const { audit, events, detach } = harness();
    const request = {},
      label = { method: "POST", url: "https://test/api/trades/item/read" };
    events.started(request, label);
    if (stage === "body")
      events.response(request, { text: () => new Promise(() => {}) });
    let settled = false;
    const result = audit.finish().then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    expect(audit.phase).toBe("draining");
    await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      `${label.method} ${label.url} (awaiting ${stage})`
    );
    expect(audit.phase).toBe("finished");
    expect(detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(audit.finish()).rejects.toBe(error);
  }
);

it("sealing starts one deadline even before finish begins draining", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  events.started({}, info);
  expect(audit.phase).toBe("open");
  audit.stop();
  audit.stop();
  expect(audit.phase).toBe("sealed");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  await expect(audit.finish()).rejects.toThrow(
    `${info.method} ${info.url} (awaiting headers)`
  );
  expect(audit.phase).toBe("finished");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["open", "sealed", "draining"] as const)(
  "disposal abandons %s and late callbacks cannot revive it",
  async (phase) => {
    vi.useFakeTimers();
    const { audit, events, detach } = harness();
    const request = {};
    events.started(request, info);
    if (phase === "sealed") audit.stop();
    const drain =
      phase === "draining" ? audit.finish().catch((error) => error) : null;
    expect(audit.phase).toBe(phase);
    audit.dispose();
    audit.dispose();
    audit.stop();
    expect(audit.phase).toBe("disposed");
    const text = vi.fn(async () => "late public terms");
    events.response(request, { text });
    events.failed(request, "net::ERR_ABORTED");
    events.started({}, info);
    expect(text).not.toHaveBeenCalled();
    await expect(audit.finish()).rejects.toThrow("Privacy audit was abandoned");
    if (drain)
      expect(String(await drain)).toContain(
        "Privacy audit disposed before completion"
      );
    expect(detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it.each([false, true])(
  "successful finish is immutable and idempotent (seal first=%s)",
  async (seal) => {
    vi.useFakeTimers();
    const { audit, events, detach } = harness();
    const request = {};
    events.started(request, info);
    let deliver!: (body: string) => void;
    events.response(request, {
      text: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    });
    if (seal) {
      audit.stop();
      expect(audit.phase).toBe("sealed");
    }
    const drain = audit.finish();
    expect(audit.finish()).toBe(drain);
    expect(audit.phase).toBe("draining");
    deliver("public terms");
    await expect(drain).resolves.toEqual(["public terms"]);
    expect(audit.phase).toBe("finished");
    audit.dispose();
    audit.stop();
    expect(audit.phase).toBe("finished");
    expect(audit.finish()).toBe(drain);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it("accounts an explicit application abort while awaiting headers", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  const request = {};
  events.started(request, info);
  const drain = audit.finish();
  events.failed(request, "net::ERR_ABORTED");
  await expect(drain).resolves.toEqual([]);
  expect(audit.abortedRequests).toEqual([
    { request, reason: "net::ERR_ABORTED" },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("a later abort cannot replace an already observed unexpected body error", async () => {
  const { audit, events } = harness();
  const request = {},
    error = new Error("Target page, context or browser has been closed");
  events.started(request, info);
  events.response(request, {
    text: async () => {
      throw error;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  events.failed(request, "net::ERR_ABORTED");
  await expect(audit.finish()).rejects.toBe(error);
  expect(audit.abortedRequests).toEqual([]);
});

it("deadline diagnostics preserve unexpected errors from other admitted requests", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  const broken = {},
    missing = {};
  const error = new Error("unexpected captured body failure");
  events.started(broken, info);
  events.started(missing, {
    method: "GET",
    url: "https://test/api/trades?group=done",
  });
  events.response(broken, {
    text: async () => {
      throw error;
    },
  });
  const drain = audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  const failure = await drain;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(String(failure)).toContain(error.message);
  expect(String(failure)).toContain(
    "GET https://test/api/trades?group=done (awaiting headers)"
  );
});

// Planner cases 1–17: request evidence and document liveness.
afterEach(() => vi.restoreAllMocks());
type AuditEvents = Parameters<Parameters<typeof responseAudit>[0]>[0];
const replace = (events: AuditEvents) =>
  events.documentReplaced(events.awaitingHeaders());
function heldRead() {
  let resolve!: (body: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function inspected(events: AuditEvents, label = info) {
  const request = {};
  events.started(request, label);
  events.response(request, { text: async () => "public terms" });
  await Promise.resolve();
  await Promise.resolve();
  return request;
}

it("an abort during a held read still inspects the body that arrives", async () => {
  const { audit, events } = harness();
  const req = {},
    text = heldRead();
  events.started(req, info);
  events.response(req, { text: () => text.promise });
  const final = audit.finish();
  events.failed(req, "net::ERR_ABORTED");
  text.resolve("counterpart private Location");
  await expect(final).resolves.toEqual(["counterpart private Location"]);
  expect(audit.abortedRequests).toEqual([]);
});
it("an abort during a held read keeps an unexpected read error", async () => {
  const { audit, events } = harness();
  const req = {},
    text = heldRead();
  events.started(req, info);
  events.response(req, { text: () => text.promise });
  const final = audit.finish();
  events.failed(req, "net::ERR_ABORTED");
  const error = new Error("unexpected body error");
  text.reject(error);
  await expect(final).rejects.toBe(error);
  expect(audit.abortedRequests).toEqual([]);
});
it("an abort during a held read accounts a navigation-discarded body", async () => {
  const { audit, events } = harness();
  const req = {},
    text = heldRead();
  events.started(req, info);
  events.response(req, { text: () => text.promise });
  const final = audit.finish();
  events.failed(req, "net::ERR_ABORTED");
  text.reject(
    new Error("Response unavailable: navigated away from this document")
  );
  await expect(final).resolves.toEqual([]);
  expect(audit.abortedRequests).toEqual([
    { request: req, reason: "application navigation discarded response" },
  ]);
});
it("an abort during a read that never settles fails at the deadline", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  const req = {};
  events.started(req, info);
  events.response(req, { text: () => new Promise(() => {}) });
  const final = audit.finish().catch((error) => error);
  events.failed(req, "net::ERR_ABORTED");
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting body)");
  expect(audit.abortedRequests).toEqual([]);
});
it("an unexpected failure during a held read fails even when the body arrives", async () => {
  const { audit, events } = harness();
  const req = {},
    text = heldRead();
  events.started(req, info);
  events.response(req, { text: () => text.promise });
  const final = audit.finish();
  events.failed(req, "net::ERR_FAILED");
  text.resolve("public terms");
  await expect(final).rejects.toThrow(
    "Unexpected audited request failure: net::ERR_FAILED"
  );
});
it("a document replacement releases a request with no response, without waiting", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const { audit, events } = harness();
  await inspected(events);
  const req = {};
  events.started(req, info);
  replace(events);
  const at = Date.now();
  await expect(audit.finish()).resolves.toEqual(["public terms"]);
  expect(Date.now()).toBe(at);
  expect(vi.getTimerCount()).toBe(0);
  expect(audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `privacy audit excluded 1 undelivered request(s): ${info.method} ${info.url}`
  );
});
it.each([false, true])(
  "a document replacement leaves a read in progress owed (never=%s)",
  async (never) => {
    vi.useFakeTimers();
    const { audit, events } = harness();
    const req = {},
      text = heldRead();
    events.started(req, info);
    events.response(req, { text: () => text.promise });
    replace(events);
    const final = audit.finish();
    const result = final.catch((error) => error);
    expect(vi.getTimerCount()).toBe(1);
    if (never) {
      await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
      expect(String(await result)).toContain("(awaiting body)");
    } else {
      text.resolve("private value delivered to this viewer");
      await expect(final).resolves.toEqual([
        "private value delivered to this viewer",
      ]);
    }
    expect(audit.abortedRequests).toEqual([]);
  }
);
it.each(["before seal", "sealed", "draining"] as const)(
  "a late response after a replacement is inspected (%s)",
  async (order) => {
    const { audit, events } = harness();
    const req = {},
      anchor = {},
      held = heldRead();
    events.started(req, info);
    replace(events);
    if (order === "draining") {
      events.started(anchor, info);
      events.response(anchor, { text: () => held.promise });
    }
    if (order === "sealed") audit.stop();
    const running = order === "draining" ? audit.finish() : undefined;
    events.response(req, { text: async () => "counterpart private Location" });
    held.resolve("public terms");
    const bodies = await (running ?? audit.finish());
    expect(bodies).toContain("counterpart private Location");
    expect(audit.abortedRequests).toEqual([]);
  }
);
it("a late response after everything drained is still bounded", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  const req = {};
  events.started(req, info);
  replace(events);
  audit.stop();
  expect(vi.getTimerCount()).toBe(0);
  events.response(req, { text: () => new Promise(() => {}) });
  expect(vi.getTimerCount()).toBe(1);
  const final = audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting body)");
});
it.each(["net::ERR_ABORTED", "net::ERR_FAILED"])(
  "a late failure after a replacement is honoured (%s)",
  async (reason) => {
    const { audit, events } = harness();
    const req = {};
    events.started(req, info);
    replace(events);
    events.failed(req, reason);
    if (reason === "net::ERR_ABORTED") {
      await expect(audit.finish()).resolves.toEqual([]);
      expect(audit.abortedRequests).toEqual([{ request: req, reason }]);
    } else
      await expect(audit.finish()).rejects.toThrow(
        "Unexpected audited request failure"
      );
  }
);
it("a request admitted after a replacement stays owed", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { audit, events } = harness();
  await inspected(events);
  events.started({}, info);
  replace(events);
  const live = { method: "GET", url: "https://test/api/trades/new" };
  events.started({}, live);
  let done = false;
  const final = audit.finish().catch((error) => {
    done = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS - 1);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(String(await final)).toContain(
    `${live.method} ${live.url} (awaiting headers)`
  );
});
it.each([
  [undefined, info],
  [
    { method: "GET", url: "https://test/api/trades?group=open" },
    { method: "GET", url: "https://test/api/trades?group=done" },
  ],
  [info, { ...info, method: "POST" }],
])(
  "an excluded request with no same-route body fails the proof (%j)",
  async (body, orphan) => {
    const { audit, events } = harness();
    if (body) await inspected(events, body);
    events.started({}, orphan);
    replace(events);
    await expect(audit.finish()).rejects.toThrow(
      `Privacy audit excluded a request with no inspected response on its route: ${orphan.method} ${orphan.url}`
    );
  }
);
it("the same route covers an excluded request across different ids", async () => {
  const { audit, events } = harness();
  vi.spyOn(console, "info").mockImplementation(() => {});
  await inspected(events, {
    method: "GET",
    url: "https://test/api/trades/11111111-1111-4111-8111-111111111111",
  });
  events.started(
    {},
    {
      method: "GET",
      url: "https://test/api/trades/22222222-2222-4222-8222-222222222222",
    }
  );
  replace(events);
  await expect(audit.finish()).resolves.toEqual(["public terms"]);
});
it("disposal abandons a proof holding only orphaned requests", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  events.started({}, info);
  replace(events);
  const final = audit.finish();
  audit.dispose();
  await expect(final).rejects.toThrow(
    "Privacy audit disposed before completion"
  );
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  [
    {
      method: "GET",
      url: "https://test/api/trades/11111111-1111-4111-8111-111111111111",
    },
    "GET /api/trades/:id",
  ],
  [
    {
      method: "POST",
      url: "https://test/api/trades/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/read",
    },
    "POST /api/trades/:id/read",
  ],
  [
    { method: "GET", url: "https://test/api/trades?group=open" },
    "GET /api/trades?group=open",
  ],
  [
    { method: "GET", url: "https://test/api/trades?group=done" },
    "GET /api/trades?group=done",
  ],
  [
    { method: "POST", url: "https://test/api/trades/item" },
    "POST /api/trades/item",
  ],
  [
    {
      method: "GET",
      url: "https://test/api/trades/11111111-1111-4111-8111-111111111111?other=22222222-2222-4222-8222-222222222222",
    },
    "GET /api/trades/:id?other=:id",
  ],
])(
  "routeShape keeps method and query and replaces every UUID (%j)",
  (label, shape) => {
    expect(routeShape(label)).toBe(shape);
  }
);
it("a late response in the same tick the drain completes is inspected", async () => {
  const { audit, events } = harness();
  const req = {};
  events.started(req, info);
  replace(events);
  const final = audit.finish();
  events.response(req, { text: async () => "late private value" });
  await expect(final).resolves.toEqual(["late private value"]);
  expect(audit.abortedRequests).toEqual([]);
});
it("a replacement only touches the identities it was given", async () => {
  vi.useFakeTimers();
  const { audit, events } = harness();
  await inspected(events);
  events.started({}, info);
  const snapshot = events.awaitingHeaders();
  events.started({}, info);
  events.documentReplaced(snapshot);
  const final = audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain(
    `${info.method} ${info.url} (awaiting headers)`
  );
});

// WP-3: identity, bytes and completion all belong to one Network session.
const flushIdentity = async () => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};
type Tree = { frame: { loaderId: string }; childFrames?: Tree[] };
async function adapterFixture(
  options: {
    tree?: () => Promise<{ frameTree: Tree }>;
    sessionFails?: boolean;
    enableFails?: boolean;
    enabling?: (cdp: EventEmitter) => void;
  } = {}
) {
  const bodies = new Map<
    string,
    string | Error | { body: string; base64Encoded: boolean }
  >();
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string, params?: { requestId?: string }) => {
      if (method === "Network.enable") {
        options.enabling?.(cdp);
        if (options.enableFails) throw new Error("enable failed");
        return;
      }
      if (method === "Page.getFrameTree")
        return options.tree
          ? options.tree()
          : { frameTree: { frame: { loaderId: "live" } } };
      if (method === "Network.getResponseBody") {
        const value = bodies.get(params?.requestId ?? "") ?? "public terms";
        if (value instanceof Error) throw value;
        return typeof value === "string"
          ? { body: value, base64Encoded: false }
          : value;
      }
      throw new Error(`Unexpected CDP command: ${method}`);
    }),
    detach: vi.fn(async () => {
      cdp.emit("close");
    }),
  });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({
      newCDPSession: async () => {
        if (options.sessionFails) throw new Error("session failed");
        return cdp as unknown as CDPSession;
      },
    }),
  });
  const seen = vi.fn();
  let audit: Awaited<ReturnType<typeof auditPage>>;
  try {
    audit = await auditPage(
      page as unknown as Page,
      (url) => url.includes("/api/trades"),
      seen
    );
  } catch (error) {
    expect(page.eventNames()).toEqual([]);
    expect(cdp.eventNames()).toEqual([]);
    expect(cdp.detach).toHaveBeenCalledTimes(options.sessionFails ? 0 : 1);
    throw error;
  }
  const begin = (
    id: string,
    loaderId = "live",
    url = info.url,
    method = "GET"
  ) =>
    cdp.emit("Network.requestWillBeSent", {
      requestId: id,
      loaderId,
      request: { url, method },
    });
  const respond = (id: string, url = info.url, loaderId = "live") =>
    cdp.emit("Network.responseReceived", {
      requestId: id,
      loaderId,
      response: { url },
    });
  const data = (id: string, length: number) =>
    cdp.emit("Network.dataReceived", { requestId: id, dataLength: length });
  const finished = (id: string) =>
    cdp.emit("Network.loadingFinished", { requestId: id });
  const failed = (
    id: string,
    text = "net::ERR_ABORTED",
    blockedReason?: string
  ) =>
    cdp.emit("Network.loadingFailed", {
      requestId: id,
      errorText: text,
      blockedReason,
    });
  const playwrightSaw = (url = info.url) =>
    page.emit("response", { url: () => url } as Response);
  const prime = async () => {
    begin("prime");
    respond("prime");
    finished("prime");
    await flushIdentity();
  };
  return {
    cdp,
    page,
    bodies,
    audit,
    seen,
    begin,
    respond,
    data,
    finished,
    failed,
    playwrightSaw,
    prime,
  };
}
it("a dead loader releases an unanswered request at seal", async () => {
  const f = await adapterFixture();
  await f.prime();
  f.begin("dead", "dead");
  expect(await f.audit.finish()).toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    {
      request: expect.objectContaining({ requestId: "dead" }),
      reason: DOCUMENT_REPLACED,
    },
  ]);
});
it("an unchanged loader keeps its request owed", async () => {
  vi.useFakeTimers();
  const f = await adapterFixture();
  f.begin("live");
  const proof = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await proof)).toContain(`GET ${info.url} (awaiting headers)`);
  expect(f.audit.abortedRequests).toEqual([]);
});
it.each(["respond first", "failed first"])(
  "WR-06: a live twin stays owed beside a dead one, %s",
  async (order) => {
    const f = await adapterFixture();
    await f.prime();
    f.begin("live");
    f.begin("dead", "dead");
    f.begin("failed", "dead");
    const proof = f.audit.finish();
    let settled = false;
    void proof.then(() => {
      settled = true;
    });
    await flushIdentity();
    if (order === "respond first") {
      f.respond("live");
      f.failed("failed");
    } else {
      f.failed("failed");
      f.respond("live");
    }
    await flushIdentity();
    expect(settled).toBe(false);
    f.bodies.set("live", "live private Location");
    f.data("live", 21);
    f.finished("live");
    expect(await proof).toEqual(["public terms", "live private Location"]);
    expect(f.audit.abortedRequests).toContainEqual({
      request: expect.objectContaining({ requestId: "dead" }),
      reason: DOCUMENT_REPLACED,
    });
    expect(f.audit.abortedRequests).not.toContainEqual({
      request: expect.objectContaining({ requestId: "live" }),
      reason: DOCUMENT_REPLACED,
    });
  }
);
it("WR-07: a request event just before the tree ack is judged by its own loader", async () => {
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await f.prime();
  const proof = f.audit.finish();
  await flushIdentity();
  // Preserve the reviewer's order: event arrives during the pending tree read.
  f.begin("late", "dead");
  release({ frameTree: { frame: { loaderId: "live" } } });
  expect(await proof).toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    {
      request: expect.objectContaining({ requestId: "late" }),
      reason: DOCUMENT_REPLACED,
    },
  ]);
});
it("WR-08: a closed session fails the proof and excludes nothing", async () => {
  const f = await adapterFixture();
  await f.prime();
  f.begin("dead", "dead");
  f.begin("live");
  f.respond("live");
  const proof = f.audit.finish().catch((error) => error);
  await flushIdentity();
  f.cdp.emit("close");
  expect(String(await proof)).toContain(
    "Privacy audit CDP session closed before the proof finished"
  );
  expect(f.audit.abortedRequests).toEqual([]);
});
it.each(["finish", "dispose"] as const)(
  "cleanup does not invalidate the proof: %s",
  async (end) => {
    const f = await adapterFixture();
    await f.prime();
    if (end === "finish")
      expect(await f.audit.finish()).toEqual(["public terms"]);
    else f.audit.dispose();
    await flushIdentity();
    f.cdp.emit("close");
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    expect(f.page.listenerCount("response")).toBe(0);
    expect(f.cdp.eventNames()).toEqual([]);
    expect(f.audit.phase).toBe(end === "finish" ? "finished" : "disposed");
    if (end === "finish")
      expect(await f.audit.finish()).toEqual(["public terms"]);
    else await expect(f.audit.finish()).rejects.toThrow("abandoned");
  }
);
it("a rejected tree read fails the proof", async () => {
  const f = await adapterFixture({
    tree: async () => {
      throw new Error("tree failed");
    },
  });
  await f.prime();
  await expect(f.audit.finish()).rejects.toThrow("tree failed");
  expect(f.audit.abortedRequests).toEqual([]);
});
it("a hung tree read fails at the deadline", async () => {
  vi.useFakeTimers();
  const f = await adapterFixture({ tree: () => new Promise(() => {}) });
  await f.prime();
  const proof = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await proof)).toContain("CDP seal evidence (awaiting body)");
});
it.each(["child", ""])(
  "a child-frame loader is live or an empty loader stays owed: %s",
  async (loaderId) => {
    const f = await adapterFixture({
      tree: async () => ({
        frameTree: {
          frame: { loaderId: "live" },
          childFrames: [{ frame: { loaderId: "child" } }],
        },
      }),
    });
    f.begin("live", loaderId);
    let settled = false;
    const proof = f.audit.finish().then((bodies) => {
      settled = true;
      return bodies;
    });
    await flushIdentity();
    expect(settled).toBe(false);
    f.bodies.set("live", "surviving private body");
    f.respond("live");
    f.finished("live");
    expect(await proof).toEqual(["surviving private body"]);
    expect(f.audit.abortedRequests).toEqual([]);
  }
);
it.each([
  {
    name: "finished readable with zero observed bytes",
    end: "finished",
    bytes: 0,
    readable: true,
    body: "read body",
  },
  {
    name: "failed readable with zero observed bytes",
    end: "failed",
    bytes: 0,
    readable: true,
    body: "read body",
  },
  {
    name: "cut readable with zero observed bytes",
    end: "cut",
    bytes: 0,
    readable: true,
    body: "read body",
  },
  {
    name: "finished readable empty",
    end: "finished",
    bytes: 0,
    readable: true,
    body: "",
  },
  {
    name: "finished readable delivered",
    end: "finished",
    bytes: 5,
    readable: true,
    body: "read body",
  },
  {
    name: "failed readable delivered",
    end: "failed",
    bytes: 5,
    readable: true,
    body: "read body",
  },
  {
    name: "cut readable delivered",
    end: "cut",
    bytes: 5,
    readable: true,
    body: "read body",
  },
  {
    name: "finished unreadable zero bytes",
    end: "finished",
    bytes: 0,
    readable: false,
    body: "",
  },
  {
    name: "failed unreadable zero bytes",
    end: "failed",
    bytes: 0,
    readable: false,
    discard: true,
  },
  {
    name: "cut unreadable zero bytes",
    end: "cut",
    bytes: 0,
    readable: false,
    discard: true,
  },
  {
    name: "finished unreadable delivered",
    end: "finished",
    bytes: 5,
    readable: false,
    error: true,
  },
  {
    name: "failed unreadable delivered",
    end: "failed",
    bytes: 5,
    readable: false,
    error: true,
  },
  {
    name: "cut unreadable delivered",
    end: "cut",
    bytes: 5,
    readable: false,
    error: true,
  },
  {
    name: "live without terminal",
    end: "none",
    bytes: 5,
    readable: true,
    pending: true,
  },
])("read rule: $name", async (row) => {
  vi.useFakeTimers();
  const f = await adapterFixture();
  f.begin("read", row.end === "cut" ? "dead" : "live");
  f.respond("read");
  f.data("read", row.bytes);
  f.bodies.set(
    "read",
    row.readable ? (row.body ?? "read body") : new Error("body unavailable")
  );
  if (row.end === "finished") f.finished("read");
  if (row.end === "failed") f.failed("read");
  const proof = f.audit.finish().catch((error) => error);
  if (row.pending) await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  const result = await proof;
  if (row.error)
    expect(String(result)).toContain(
      `could not read a delivered body: GET ${info.url}: Error: body unavailable`
    );
  else if (row.pending) expect(String(result)).toContain("(awaiting body)");
  else if (row.discard) {
    expect(result).toEqual([]);
    expect(f.audit.abortedRequests).toEqual([
      {
        request: expect.objectContaining({ requestId: "read" }),
        reason: "application navigation discarded response",
      },
    ]);
  } else {
    expect(result).toEqual([row.body]);
    expect(f.audit.abortedRequests).toEqual([]);
  }
});
it("the read waits for the end of the hop", async () => {
  const f = await adapterFixture();
  f.begin("read");
  f.respond("read");
  await flushIdentity();
  expect(
    f.cdp.send.mock.calls.filter(
      ([method]) => method === "Network.getResponseBody"
    )
  ).toHaveLength(0);
  f.finished("read");
  expect(await f.audit.finish()).toEqual(["public terms"]);
  expect(
    f.cdp.send.mock.calls.filter(
      ([method]) => method === "Network.getResponseBody"
    )
  ).toHaveLength(1);
});
it("a base64 body is decoded", async () => {
  const f = await adapterFixture();
  f.bodies.set("read", {
    body: Buffer.from("private café").toString("base64"),
    base64Encoded: true,
  });
  f.begin("read");
  f.respond("read");
  f.finished("read");
  expect(await f.audit.finish()).toEqual(["private café"]);
});
it("onBody receives the URL after the read", async () => {
  const f = await adapterFixture();
  f.begin("read");
  f.respond("read");
  await flushIdentity();
  expect(f.seen).not.toHaveBeenCalled();
  f.finished("read");
  await f.audit.finish();
  expect(f.seen).toHaveBeenCalledTimes(1);
  expect(f.seen.mock.calls[0][0].url()).toBe(info.url);
});
it("floor: a response the session never saw fails", async () => {
  const f = await adapterFixture();
  await f.prime();
  f.playwrightSaw();
  f.playwrightSaw();
  await expect(f.audit.finish()).rejects.toThrow(
    `Privacy audit floor: Playwright saw 2 response(s) the session did not: ${info.url}`
  );
});
it("floor: equal counts pass, including WR-09 fragment metadata", async () => {
  const f = await adapterFixture();
  f.cdp.emit("Network.requestWillBeSent", {
    requestId: "fragment",
    loaderId: "live",
    request: { method: "GET", url: info.url, urlFragment: "#x" },
  });
  f.respond("fragment");
  f.finished("fragment");
  f.playwrightSaw();
  expect(await f.audit.finish()).toEqual(["public terms"]);
});
it("floor: a redirect response counts", async () => {
  const f = await adapterFixture();
  f.cdp.emit("Network.requestWillBeSent", {
    requestId: "redirect",
    loaderId: "live",
    request: { method: "GET", url: "https://test/outside" },
    redirectResponse: { url: info.url },
  });
  f.playwrightSaw();
  expect(await f.audit.finish()).toEqual([]);
});
it("a redirect hop fails as it does today", async () => {
  const f = await adapterFixture();
  f.begin("redirect");
  f.cdp.emit("Network.requestWillBeSent", {
    requestId: "redirect",
    loaderId: "live",
    redirectResponse: { url: info.url },
    request: { method: "GET", url: "https://test/outside" },
  });
  await expect(f.audit.finish()).rejects.toThrow(
    `Response body is unavailable for redirect responses: ${info.url}`
  );
});
it("a request first seen at its response is admitted and read", async () => {
  const f = await adapterFixture();
  f.respond("early");
  f.finished("early");
  expect(await f.audit.finish()).toEqual(["public terms"]);
});
it.each(["session", "enable"])(
  "auditPage rejects when the %s fails",
  async (failure) => {
    await expect(
      adapterFixture({
        sessionFails: failure === "session",
        enableFails: failure === "enable",
      })
    ).rejects.toThrow(`${failure} failed`);
  }
);
it("Network.enable carries the durable configuration", async () => {
  const f = await adapterFixture();
  expect(f.cdp.send).toHaveBeenCalledWith("Network.enable", {
    maxTotalBufferSize: AUDIT_BODY_BUFFER_BYTES,
    enableDurableMessages: true,
  });
  f.audit.dispose();
});
it("a request during Network.enable is admitted", async () => {
  const f = await adapterFixture({
    enabling: (cdp) =>
      cdp.emit("Network.requestWillBeSent", {
        requestId: "early",
        loaderId: "live",
        request: { method: "GET", url: info.url },
      }),
  });
  f.respond("early");
  f.finished("early");
  expect(await f.audit.finish()).toEqual(["public terms"]);
});
it("invalidated proofs preserve aggregated errors but append no exclusions", async () => {
  const f = await adapterFixture();
  await f.prime();
  f.begin("dead", "dead");
  f.begin("error");
  f.respond("error");
  f.bodies.set("error", new Error("delivered private body unreadable"));
  f.data("error", 1);
  f.finished("error");
  await flushIdentity();
  f.cdp.emit("close");
  const result = await f.audit.finish().catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(String(result)).toContain("could not read a delivered body");
  expect(String(result)).toContain("CDP session closed");
  expect(f.audit.abortedRequests).toEqual([]);
});

it("WR-07 control: a live body delivered before the tree ack is inspected", async () => {
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await f.prime();
  const proof = f.audit.finish();
  await flushIdentity();
  f.begin("late-live", "live");
  f.bodies.set("late-live", "private Location delivered before tree ack");
  f.respond("late-live");
  f.playwrightSaw();
  f.data("late-live", 40);
  f.finished("late-live");
  release({ frameTree: { frame: { loaderId: "live" } } });
  expect(await proof).toContain("private Location delivered before tree ack");
});

it("a request issued after the tree acknowledgement stays excluded", async () => {
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await f.prime();
  f.begin("admitted");
  const proof = f.audit.finish();
  await flushIdentity();
  release({ frameTree: { frame: { loaderId: "live" } } });
  await flushIdentity();
  f.bodies.set("teardown", new Error("post-boundary body must not be read"));
  f.begin("teardown");
  f.respond("teardown");
  f.data("teardown", 50);
  f.finished("teardown");
  // An already-admitted id remains owed even when its response arrives later.
  f.bodies.set("admitted", "admitted late response");
  f.respond("admitted");
  f.finished("admitted");
  expect(await proof).toEqual(["public terms", "admitted late response"]);
  expect(
    f.cdp.send.mock.calls.filter(
      ([method, params]) =>
        method === "Network.getResponseBody" && params?.requestId === "teardown"
    )
  ).toHaveLength(0);
  expect(f.audit.abortedRequests).toEqual([]);
});
it("the body deadline starts at the tree acknowledgement", async () => {
  vi.useFakeTimers();
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  f.begin("admitted");
  const proof = f.audit.finish();
  let settled = false;
  void proof.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(4_000);
  release({ frameTree: { frame: { loaderId: "live" } } });
  await flushIdentity();
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  f.respond("admitted");
  f.finished("admitted");
  expect(await proof).toEqual(["public terms"]);
  expect(vi.getTimerCount()).toBe(0);
});
it("a non-abort transport failure still reads the body and fails by name", async () => {
  const f = await adapterFixture();
  f.begin("read");
  f.respond("read");
  f.data("read", 1);
  f.failed("read", "net::ERR_FAILED");
  await expect(f.audit.finish()).rejects.toThrow(
    `Unexpected audited request failure: net::ERR_FAILED (GET ${info.url})`
  );
  expect(f.seen).toHaveBeenCalledTimes(1);
  expect(f.audit.abortedRequests).toEqual([]);
});
it("a blocked reason is retained when errorText is empty", async () => {
  const f = await adapterFixture();
  f.bodies.set("read", new Error("blocked body"));
  f.begin("read");
  f.respond("read");
  f.failed("read", "", "inspector");
  await expect(f.audit.finish()).rejects.toThrow(
    `Unexpected audited request failure: inspector (GET ${info.url})`
  );
});

it("disposal while awaiting the tree cannot resume admission or pass a proof", async () => {
  vi.useFakeTimers();
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  f.begin("admitted");
  const proof = f.audit.finish().catch((error) => error);
  await flushIdentity();
  f.audit.dispose();
  release({ frameTree: { frame: { loaderId: "live" } } });
  await flushIdentity();
  f.begin("teardown");
  f.respond("teardown");
  f.finished("teardown");
  expect(String(await proof)).toContain("disposed before completion");
  expect(f.audit.phase).toBe("disposed");
  expect(f.audit.abortedRequests).toEqual([]);
  expect(f.cdp.detach).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("session close before the tree acknowledgement invalidates every exclusion", async () => {
  let release!: (value: { frameTree: Tree }) => void;
  const f = await adapterFixture({
    tree: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await f.prime();
  f.begin("dead", "dead");
  const proof = f.audit.finish().catch((error) => error);
  await flushIdentity();
  f.cdp.emit("close");
  expect(String(await proof)).toContain(
    "CDP session closed before the proof finished"
  );
  release({ frameTree: { frame: { loaderId: "live" } } });
  await flushIdentity();
  expect(f.audit.abortedRequests).toEqual([]);
});
