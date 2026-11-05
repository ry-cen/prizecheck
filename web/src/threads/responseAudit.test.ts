import { expect, it, vi } from "vitest";
import { responseAudit } from "../../tests/support/responseAudit";

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
  events.started(first);
  events.started(held);
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
  events.started(teardown);
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
  events.started(request);
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
  events.started(valid);
  events.started(discarded);
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
  events.started(request);
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
  events.started(request);
  events.failed(request, "net::ERR_FAILED");
  await expect(audit.finish()).rejects.toThrow(
    "Unexpected audited request failure: net::ERR_FAILED"
  );
});

it("failed-journey disposal detaches but can never satisfy a later privacy proof", async () => {
  const { audit, events, detach } = harness();
  events.started({});
  audit.stop();
  audit.dispose();
  await expect(audit.finish()).rejects.toThrow("Privacy audit was abandoned");
  expect(detach).toHaveBeenCalledTimes(1);
});
