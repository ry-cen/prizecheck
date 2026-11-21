import { describe, expect, it } from "vitest";
import {
  FAKE_SIGN_IN_FAILED,
  fakeSignInProgress,
  pollFakeSignIn,
  startNavigationInPage,
  walkFakeSignInSanitized,
  type FakeSignInClock,
  type FakeSignInPage,
} from "../../web/tests/support/fake-sign-in-wait";

// Inert markers: they stand for a callback's code and state and are checked never to reach a message.
const MARKERS = ["MARKER_CODE_123", "MARKER_STATE_456"];
const callback =
  "http://127.0.0.1:5999/auth/callback/google?code=MARKER_CODE_123&state=MARKER_STATE_456";
const consent =
  "http://127.0.0.1:5999/auth/__fake-oauth/consent?code=MARKER_CODE_123&state=MARKER_STATE_456";
const apiCallback =
  "http://127.0.0.1:5999/api/auth/callback/google?code=MARKER_CODE_123&state=MARKER_STATE_456";
const landed = "http://127.0.0.1:5999/collection";

function expectClean(text: string) {
  for (const marker of MARKERS) expect(text).not.toContain(marker);
  expect(text).not.toMatch(/code=|state=|https?:|127\.0\.0\.1/);
}

describe("the sanitized fake sign-in wait", () => {
  it("stays pending on the consent page and the auth routes, and finishes once the browser has left them", () => {
    expect(fakeSignInProgress(consent)).toBe("pending");
    expect(fakeSignInProgress(callback)).toBe("pending");
    expect(fakeSignInProgress(apiCallback)).toBe("pending");
    expect(fakeSignInProgress(landed)).toBe("done");
  });

  it("treats a blank, unparsable or non-web address as still pending", () => {
    for (const url of [
      "about:blank",
      "",
      "not a url",
      "chrome-error://chromewebdata/",
    ])
      expect(fakeSignInProgress(url)).toBe("pending");
  });

  it("never puts a URL, code or state in any message, before or after the deadline", () => {
    const outcomes = [
      consent,
      callback,
      apiCallback,
      landed,
      "about:blank",
    ].flatMap((url) => [
      pollFakeSignIn(url, 0, 1000),
      pollFakeSignIn(url, 1000, 1000),
      pollFakeSignIn(url, 5000, 1000),
    ]);
    for (const outcome of outcomes) expectClean(JSON.stringify(outcome));
    const failed = pollFakeSignIn(callback, 1000, 1000);
    expect(failed).toEqual({ state: "failed", message: FAKE_SIGN_IN_FAILED });
    expectClean(FAKE_SIGN_IN_FAILED);
  });

  it("reports a finished walk as done even after the deadline, and a pending one as pending before it", () => {
    expect(pollFakeSignIn(landed, 9999, 1000)).toEqual({ state: "done" });
    expect(pollFakeSignIn(consent, 10, 1000)).toEqual({ state: "pending" });
  });
});

const startHref =
  "http://127.0.0.1:5999/auth/sign-in/google?next=%2Fcollection&fake_identity=owner";
const leak = `Navigation is interrupted by another navigation to "${callback}" ${consent}`;

/** A fake clock whose sleep advances time, so deadlines run instantly. */
function fakeClock(): FakeSignInClock & { t: number } {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: (ms: number) => {
      clock.t += ms;
      return Promise.resolve();
    },
    // Fires on the next macrotask, after any settled work has won the race.
    after: (_ms: number, fn: () => void) => {
      const timer = setTimeout(fn, 0);
      return () => clearTimeout(timer);
    },
  };
  return clock;
}

function mockPage(over: Partial<FakeSignInPage> & { urls?: string[] } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const urls = over.urls ?? ["about:blank", consent, callback, landed];
  let reads = 0;
  const page: FakeSignInPage = {
    goto: async (...args) => {
      calls.push({ method: "goto", args });
    },
    evaluate: async (...args) => {
      calls.push({ method: "evaluate", args });
    },
    url: () => urls[Math.min(reads++, urls.length - 1)],
    waitForLoadState: async (...args) => {
      calls.push({ method: "waitForLoadState", args });
    },
    ...over,
  };
  return { page, calls };
}

async function messageOf(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the walk to fail");
}

describe("the sanitized fake sign-in walk", () => {
  it("starts the walk from inside the page and never calls goto with a credential-bearing address", async () => {
    const { page, calls } = mockPage();
    await walkFakeSignInSanitized(page, startHref, 30_000, fakeClock());
    const goto = calls.filter((c) => c.method === "goto");
    expect(goto.map((c) => c.args[0])).toEqual(["about:blank"]);
    const evaluate = calls.find((c) => c.method === "evaluate");
    expect(evaluate?.args).toEqual([startNavigationInPage, startHref]);
    expect(JSON.stringify(calls)).not.toMatch(/MARKER_|code=|state=/);
  });

  it("schedules the page-side navigation and returns", () => {
    const assigned: string[] = [];
    const scheduled: (() => void)[] = [];
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, setTimeout: g.setTimeout };
    g.window = { location: { assign: (href: string) => assigned.push(href) } };
    g.setTimeout = (fn: () => void) => scheduled.push(fn);
    try {
      startNavigationInPage(startHref);
      expect(assigned).toEqual([]);
      scheduled[0]();
      expect(assigned).toEqual([startHref]);
    } finally {
      g.window = saved.window;
      g.setTimeout = saved.setTimeout;
    }
  });

  it("turns every initiation, load and deadline failure into the fixed message", async () => {
    const rejecting = () => Promise.reject(new Error(leak));
    const cases: Partial<FakeSignInPage>[] = [
      { goto: rejecting },
      { evaluate: rejecting },
      { waitForLoadState: rejecting },
      { urls: [consent] } as Partial<FakeSignInPage>,
      { urls: [callback] } as Partial<FakeSignInPage>,
    ];
    for (const over of cases) {
      const { page } = mockPage(over);
      const message = await messageOf(
        walkFakeSignInSanitized(page, startHref, 1000, fakeClock())
      );
      expect(message).toBe(FAKE_SIGN_IN_FAILED);
      expectClean(message);
    }
  });

  it("bounds a hung initiation or load wait by the one shared deadline", async () => {
    const hang = () => new Promise<never>(() => undefined);
    for (const over of [
      { goto: hang },
      { evaluate: hang },
      { waitForLoadState: hang },
    ]) {
      const { page } = mockPage(over);
      const message = await messageOf(
        walkFakeSignInSanitized(page, startHref, 1000, fakeClock())
      );
      expect(message).toBe(FAKE_SIGN_IN_FAILED);
    }
  });

  it("gives later steps only the time the earlier ones left", async () => {
    const clock = fakeClock();
    const { page, calls } = mockPage({
      urls: [consent, consent, consent, landed],
    });
    await walkFakeSignInSanitized(page, startHref, 1000, clock);
    const timeouts = calls
      .filter((c) => c.method === "goto" || c.method === "waitForLoadState")
      .map((c) => (c.args.at(-1) as { timeout: number }).timeout);
    expect(timeouts[0]).toBe(1000);
    expect(timeouts[1]).toBe(700);
  });
});
