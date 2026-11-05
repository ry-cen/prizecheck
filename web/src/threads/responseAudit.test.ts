import { EventEmitter } from "node:events";
import type { Frame, Page, Request, Response } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import {
  AUDIT_DRAIN_TIMEOUT_MS,
  DOCUMENT_REPLACED,
  auditPage,
  routeShape,
  responseAudit,
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

// Planner cases 18–28: public Playwright event pairing, using its EventEmitter fake.
function adapterFixture() {
  let url = "https://test/one";
  const main = { url: () => url } as Frame;
  const page = Object.assign(new EventEmitter(), { mainFrame: () => main });
  const seen = vi.fn();
  const audit = auditPage(
    page as unknown as Page,
    (value) => /\/api\/trades(?:[/?]|$)/.test(value),
    seen
  );
  const request = (
    value = info.url,
    options: {
      navigation?: boolean;
      frame?: Frame;
      throws?: boolean;
      method?: string;
      reason?: string;
    } = {}
  ) =>
    ({
      url: () => value,
      method: () => options.method ?? "GET",
      isNavigationRequest: () => options.navigation ?? false,
      frame: () => {
        if (options.throws) throw new Error("frame not yet known");
        return options.frame ?? main;
      },
      failure: () => (options.reason ? { errorText: options.reason } : null),
    }) as Request;
  const response = (req: Request, text: () => Promise<string>) =>
    ({ request: () => req, text, url: req.url }) as Response;
  const start = (req: Request) => {
    page.emit("request", req);
    return req;
  };
  const navigate = (value: string) =>
    start(request(value, { navigation: true }));
  const commit = (value: string, frame = main) => {
    url = value;
    page.emit("framenavigated", frame);
  };
  const loaded = () => page.emit("domcontentloaded");
  const body = (req: Request, value = "public terms") =>
    page.emit(
      "response",
      response(req, async () => value)
    );
  const prime = async (label = info) => {
    const req = start(request(label.url, { method: label.method }));
    body(req);
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    page,
    main,
    audit,
    seen,
    request,
    response,
    start,
    navigate,
    commit,
    loaded,
    body,
    prime,
  };
}

it("a committed main-frame navigation releases an unanswered request", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture();
  await f.prime();
  const req = f.start(f.request());
  f.navigate("https://test/two");
  f.commit("https://test/two");
  f.loaded();
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it("a request issued between navigation start and commit is released", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture(),
    label = { method: "POST", url: "https://test/api/trades/item/read" };
  await f.prime(label);
  f.navigate("https://test/two");
  const req = f.start(f.request(label.url, { method: "POST" }));
  f.commit("https://test/two");
  f.loaded();
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
});
it("a redirect chain commits on its final hop", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = adapterFixture();
  await f.prime();
  const req = f.start(f.request());
  f.navigate("https://test/redirect");
  f.navigate("https://test/final");
  f.commit("https://test/final");
  f.loaded();
  await expect(f.audit.finish()).resolves.toEqual(["public terms"]);
  expect(f.audit.abortedRequests).toEqual([
    { request: req, reason: DOCUMENT_REPLACED },
  ]);
});
it("a same-document navigation releases nothing", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  f.start(f.request());
  f.commit("https://test/one#fragment");
  const final = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting headers)");
});
it("a navigation that never commits releases nothing", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  f.start(f.request());
  f.navigate("https://test/two");
  f.commit("https://test/different");
  f.loaded();
  const final = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting headers)");
});
it("a same-URL pushState during a failed navigation releases nothing", async () => {
  vi.useFakeTimers();
  const f = adapterFixture(),
    req = f.start(f.request());
  const nav = f.navigate("https://test/nocontent");
  f.commit("https://test/nocontent");
  f.page.emit("requestfailed", nav);
  f.audit.stop();
  expect(vi.getTimerCount()).toBe(1);
  f.body(req, "private body in the still-live document");
  await expect(f.audit.finish()).resolves.toEqual([
    "private body in the still-live document",
  ]);
  expect(f.audit.abortedRequests).toEqual([]);
});
it.each([false, true])(
  "a subframe navigation releases nothing (unknown frame=%s)",
  async (unknown) => {
    vi.useFakeTimers();
    const f = adapterFixture();
    f.start(f.request());
    const child = { url: () => "https://test/child" } as Frame;
    f.start(
      f.request("https://test/child", {
        navigation: true,
        frame: child,
        throws: unknown,
      })
    );
    f.commit("https://test/child", unknown ? f.main : child);
    f.loaded();
    const final = f.audit.finish().catch((error) => error);
    await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
    expect(String(await final)).toContain("(awaiting headers)");
  }
);
it("a request admitted between commit and domcontentloaded stays owed", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  await f.prime();
  f.start(f.request());
  f.navigate("https://test/two");
  f.commit("https://test/two");
  f.start(f.request());
  f.loaded();
  const final = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting headers)");
});
it("a same-URL replaceState after the commit adds nothing to the snapshot", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  await f.prime();
  f.navigate("https://test/two");
  f.commit("https://test/two");
  f.start(f.request());
  f.commit("https://test/two");
  f.loaded();
  const final = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting headers)");
});
it("a new navigation discards an unconfirmed snapshot", async () => {
  vi.useFakeTimers();
  const f = adapterFixture();
  await f.prime();
  f.start(f.request());
  f.navigate("https://test/two");
  f.commit("https://test/two");
  f.navigate("https://test/three");
  f.loaded();
  const final = f.audit.finish().catch((error) => error);
  await vi.advanceTimersByTimeAsync(AUDIT_DRAIN_TIMEOUT_MS);
  expect(String(await final)).toContain("(awaiting headers)");
});
it.each(["finish", "dispose"] as const)(
  "the adapter removes every listener after %s",
  async (end) => {
    const f = adapterFixture();
    if (end === "finish") {
      await f.prime();
      await f.audit.finish();
    } else f.audit.dispose();
    for (const event of [
      "request",
      "response",
      "requestfailed",
      "framenavigated",
      "domcontentloaded",
    ])
      expect(f.page.listenerCount(event)).toBe(0);
  }
);
