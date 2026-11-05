import { afterEach, expect, it, vi } from "vitest";
import {
  AUDIT_DRAIN_TIMEOUT_MS,
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

it.each(["headers", "body"] as const)(
  "accounts an explicit application abort while awaiting %s",
  async (stage) => {
    vi.useFakeTimers();
    const { audit, events } = harness();
    const request = {};
    events.started(request, info);
    if (stage === "body")
      events.response(request, { text: () => new Promise(() => {}) });
    const drain = audit.finish();
    events.failed(request, "net::ERR_ABORTED");
    await expect(drain).resolves.toEqual([]);
    expect(audit.abortedRequests).toEqual([
      { request, reason: "net::ERR_ABORTED" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  }
);

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
