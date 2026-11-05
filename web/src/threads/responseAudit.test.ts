import { EventEmitter } from "node:events";
import type { CDPSession, Page, Request, Response } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import {
  AUDIT_DRAIN_TIMEOUT_MS,
  DOCUMENT_REPLACED,
  auditPage,
  routeShape,
  responseAudit,
  undelivered,
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

// WP-2 replaces navigation-event pairing with exact document-identity accounting.
it.each([
  {
    name: "all dead, exact count",
    waiting: ["x", "x"],
    tracked: [
      ["x", "dead"],
      ["x", "dead"],
    ],
    expected: [0, 1],
  },
  {
    name: "older live, newer dead",
    waiting: ["x", "x"],
    tracked: [
      ["x", "live"],
      ["x", "dead"],
    ],
    expected: [],
  },
  {
    name: "untracked waiting request",
    waiting: ["x", "x"],
    tracked: [["x", "dead"]],
    expected: [],
  },
  {
    name: "more tracked than waiting",
    waiting: ["x"],
    tracked: [
      ["x", "dead"],
      ["x", "dead"],
    ],
    expected: [],
  },
  {
    name: "unknown loader",
    waiting: ["x", "x"],
    tracked: [
      ["x", ""],
      ["x", "dead"],
    ],
    expected: [],
  },
  {
    name: "independent keys",
    waiting: ["x", "y"],
    tracked: [
      ["x", "dead"],
      ["y", "live"],
    ],
    expected: [0],
  },
])("undelivered: $name", ({ waiting, tracked, expected }) => {
  expect(
    undelivered(
      waiting.map((key, request) => ({ key, request })),
      tracked.map(([key, loaderId]) => ({ key, loaderId })),
      new Set(["live"])
    )
  ).toEqual(expected);
});

const flushIdentity = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};
type FrameTree = { frame: { loaderId: string }; childFrames?: FrameTree[] };
function adapterFixture(
  options: {
    rejectSession?: boolean;
    tree?: () => Promise<{ frameTree: FrameTree }>;
  } = {}
) {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string) => {
      if (method === "Page.getFrameTree")
        return options.tree
          ? options.tree()
          : { frameTree: { frame: { loaderId: "live" } } };
      return undefined;
    }),
    detach: vi.fn(async () => {}),
  });
  const newCDPSession = vi.fn(() =>
    options.rejectSession
      ? Promise.reject(new Error("CDP unavailable"))
      : Promise.resolve(cdp as unknown as CDPSession)
  );
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession }),
  });
  const seen = vi.fn();
  const audit = auditPage(
    page as unknown as Page,
    (value) => /\/api\/trades(?:[/?]|$)/.test(value),
    seen
  );
  let serial = 0;
  const ids = new Map<Request, string>();
  const request = (
    value = info.url,
    method = "GET",
    reason = "net::ERR_ABORTED"
  ) =>
    ({
      url: () => value,
      method: () => method,
      failure: () => ({ errorText: reason }),
    }) as Request;
  const track = (req: Request, loaderId: string, id = String(++serial)) => {
    ids.set(req, id);
    cdp.emit("Network.requestWillBeSent", {
      requestId: id,
      loaderId,
      request: { method: req.method(), url: req.url() },
    });
    return id;
  };
  const start = (req = request(), loaderId: string | null = "live") => {
    if (loaderId !== null) track(req, loaderId);
    page.emit("request", req);
    return req;
  };
  const body = (req: Request, value = "public terms") =>
    page.emit("response", {
      request: () => req,
      text: async () => value,
      url: req.url,
    } as Response);
  const end = (req: Request, failed = false) =>
    cdp.emit(failed ? "Network.loadingFailed" : "Network.responseReceived", {
      requestId: ids.get(req),
    });
  const prime = async (label = info) => {
    const req = start(request(label.url, label.method));
    end(req);
    body(req);
    await flushIdentity();
  };
  return {
    cdp,
    page,
    seen,
    audit,
    newCDPSession,
    request,
    track,
    start,
    body,
    end,
    prime,
  };
}

it("a dead loader releases an unanswered request at seal", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture();
  await f.audit.ready;
  await f.prime();
  const req = f.start(f.request(), "dead");
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
  expect(vi.getTimerCount()).toBe(0);
  expect(
    f.cdp.send.mock.calls.filter(([method]) => method === "Page.getFrameTree")
  ).toHaveLength(1);
});
it("a request issued after navigation began is released by its loader", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture();
  await f.audit.ready;
  const label = { method: "POST", url: "https://test/api/trades/item/read" };
  await f.prime(label);
  f.page.emit("request", f.request("https://test/two"));
  const req = f.start(f.request(label.url, label.method), "dead");
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
});
it("an unchanged loader keeps its request owed", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  await f.audit.ready;
  f.start();
  f.page.emit("framenavigated", {});
  f.page.emit("domcontentloaded");
  const proof = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await proof)).toContain("(awaiting headers)");
  expect(f.audit.abortedRequests).toEqual([]);
});
it.each(["before", "after", "iframe"])(
  "WR-05: %s old DOMContentLoaded keeps the surviving document's body owed",
  async (order) => {
    // Port of exclusion.test.ts: failed navigation on either side of the old
    // lifecycle event, plus the surviving child-document schedule.
    const f = adapterFixture(
      order === "iframe"
        ? {
            tree: async () => ({
              frameTree: {
                frame: { loaderId: "live" },
                childFrames: [{ frame: { loaderId: "child" } }],
              },
            }),
          }
        : {}
    );
    await f.audit.ready;
    await f.prime();
    const live = f.start(f.request(), order === "iframe" ? "child" : "live");
    const nav = f.request("https://test/nocontent");
    f.page.emit("request", nav);
    f.page.emit("framenavigated", { url: () => nav.url() });
    if (order !== "after") f.page.emit("requestfailed", nav);
    f.page.emit("domcontentloaded");
    if (order === "after") f.page.emit("requestfailed", nav);
    let settled = false;
    const proof = f.audit.finish().then((bodies) => {
      settled = true;
      return bodies;
    });
    await flushIdentity();
    expect(settled).toBe(false);
    f.end(live);
    f.body(live, "counterpart private Location after old DOMContentLoaded");
    expect(await proof).toEqual([
      "public terms",
      "counterpart private Location after old DOMContentLoaded",
    ]);
    expect(f.audit.abortedRequests).toEqual([]);
    expect(f.seen).toHaveBeenCalledTimes(2);
  }
);
it("a new document's request stays owed", async () => {
  const f = adapterFixture();
  await f.audit.ready;
  await f.prime();
  const old = f.start(f.request(), "dead"),
    live = f.start();
  f.page.emit("framenavigated", {});
  f.page.emit("domcontentloaded");
  let settled = false;
  const proof = f.audit.finish().then((bodies) => {
    settled = true;
    return bodies;
  });
  await flushIdentity();
  expect(settled).toBe(false);
  f.end(live);
  f.body(live, "new-document private body");
  expect(await proof).toEqual(["public terms", "new-document private body"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: old, reason: DOCUMENT_REPLACED },
  ]);
});
it.each(["CDP first", "Playwright first"])(
  "a dead and a live request on one key: %s",
  async (order) => {
    const f = adapterFixture();
    await f.audit.ready;
    await f.prime();
    const dead = f.start(f.request(), "dead"),
      live = f.start();
    let settled = false;
    const proof = f.audit.finish().then((bodies) => {
      settled = true;
      return bodies;
    });
    await flushIdentity();
    expect(settled).toBe(false);
    if (order === "CDP first") f.end(live);
    else f.body(live, "live private body");
    await flushIdentity();
    expect(settled).toBe(false);
    expect(f.audit.abortedRequests).toEqual([]);
    if (order === "CDP first") f.body(live, "live private body");
    else f.end(live);
    expect(await proof).toEqual(["public terms", "live private body"]);
    expect(f.audit.abortedRequests).toEqual([
      { request: dead, reason: DOCUMENT_REPLACED },
    ]);
  }
);
it.each(["deadline", "body"])(
  "a late failure on the dead twin leaves the live request owed: %s",
  async (outcome) => {
    vi.useFakeTimers();
    const f = adapterFixture();
    await f.audit.ready;
    await f.prime();
    const olderLive = f.start(),
      newerDead = f.start(f.request(), "dead");
    const proof = f.audit.finish().catch((error) => error);
    await flushIdentity();
    f.end(newerDead, true);
    f.page.emit("requestfailed", newerDead);
    await flushIdentity();
    expect(f.audit.phase).toBe("draining");
    if (outcome === "body") {
      f.end(olderLive);
      f.body(olderLive, "older live private body");
      expect(await proof).toEqual(["public terms", "older live private body"]);
      expect(f.audit.abortedRequests).toEqual([
        { request: newerDead, reason: "net::ERR_ABORTED" },
      ]);
    } else {
      await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
      expect(String(await proof)).toContain("(awaiting headers)");
      expect(f.audit.abortedRequests).toEqual([
        { request: newerDead, reason: "net::ERR_ABORTED" },
      ]);
    }
  }
);
it("no CDP session orphans nothing", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  log.mockClear();
  const f = adapterFixture({ rejectSession: true });
  f.start(f.request(), null);
  const proof = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await proof)).toContain("(awaiting headers)");
  expect(f.audit.abortedRequests).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("CDP unavailable"));
});
it.each(["reject", "hang"])(
  "an unreadable frame tree orphans nothing: %s",
  async (mode) => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const f = adapterFixture({
      tree: () =>
        mode === "reject"
          ? Promise.reject(new Error("tree unavailable"))
          : new Promise(() => {}),
    });
    await f.audit.ready;
    f.start(f.request(), "dead");
    const proof = f.audit.finish().catch((error) => error);
    await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
    expect(String(await proof)).toContain("(awaiting headers)");
    expect(f.audit.abortedRequests).toEqual([]);
  }
);
it("a request issued before tracking began stays owed", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  f.start(f.request(), null);
  await f.audit.ready;
  const proof = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await proof)).toContain("(awaiting headers)");
  expect(f.audit.abortedRequests).toEqual([]);
});
it("a redirect keeps one tracked entry", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture();
  await f.audit.ready;
  await f.prime();
  const req = f.start(f.request(), null);
  // CDP reuses requestId across redirect hops: update the same map slot.
  f.track(f.request("https://test/api/trades/redirect"), "dead", "redirect");
  f.track(req, "dead", "redirect");
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
});
it.each(["finish", "dispose"] as const)(
  "the identity adapter cleans up after %s",
  async (end) => {
    let release!: (tree: { frameTree: FrameTree }) => void;
    const f = adapterFixture({
      tree: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await f.audit.ready;
    if (end === "finish") {
      await f.prime();
      await f.audit.finish();
    } else {
      f.start(f.request(), "dead");
      f.audit.stop();
      await flushIdentity();
      f.audit.dispose();
    }
    await flushIdentity();
    for (const event of [
      "request",
      "response",
      "requestfailed",
      "framenavigated",
      "domcontentloaded",
    ])
      expect(f.page.listenerCount(event)).toBe(0);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    release({ frameTree: { frame: { loaderId: "live" } } });
    await flushIdentity();
    expect(f.audit.abortedRequests).toEqual([]);
    expect(f.audit.phase).toBe(end === "finish" ? "finished" : "disposed");
  }
);
