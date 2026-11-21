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
function fakeClock(): FakeSignInClock & { t: number; sleeps: number[] } {
  const clock = {
    t: 0,
    now: () => clock.t,
    wallNow: () => 1_000_000 + clock.t,
    sleeps: [] as number[],
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
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
    expect(evaluate?.args).toEqual([
      startNavigationInPage,
      { href: startHref, notAfterEpochMs: 1_000_000 + 30_000 },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/MARKER_|code=|state=/);
  });

  describe("the page-side navigation", () => {
    function inPage(nowMs: () => number) {
      const assigned: string[] = [];
      const scheduled: (() => void)[] = [];
      const g = globalThis as Record<string, unknown>;
      const saved = {
        window: g.window,
        setTimeout: g.setTimeout,
        Date: g.Date,
      };
      g.window = {
        location: { assign: (href: string) => assigned.push(href) },
      };
      g.setTimeout = (fn: () => void) => scheduled.push(fn);
      g.Date = { now: nowMs };
      return {
        assigned,
        scheduled,
        restore: () => {
          g.window = saved.window;
          g.setTimeout = saved.setTimeout;
          g.Date = saved.Date;
        },
      };
    }

    it("schedules the navigation and returns, then navigates while the cut-off has not passed", () => {
      let now = 100;
      const page = inPage(() => now);
      try {
        startNavigationInPage({ href: startHref, notAfterEpochMs: 200 });
        expect(page.assigned).toEqual([]);
        now = 199;
        page.scheduled[0]();
        expect(page.assigned).toEqual([startHref]);
      } finally {
        page.restore();
      }
    });

    it("never navigates when it starts after the cut-off, or when its scheduled step fires after it", () => {
      let now = 200;
      const page = inPage(() => now);
      try {
        startNavigationInPage({ href: startHref, notAfterEpochMs: 200 });
        expect(page.scheduled).toEqual([]);
        now = 100;
        startNavigationInPage({ href: startHref, notAfterEpochMs: 200 });
        now = 200;
        page.scheduled[0]();
        expect(page.assigned).toEqual([]);
      } finally {
        page.restore();
      }
    });
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

  it("dispatches nothing when the budget is zero", async () => {
    const { page, calls } = mockPage();
    const message = await messageOf(
      walkFakeSignInSanitized(page, startHref, 0, fakeClock())
    );
    expect(message).toBe(FAKE_SIGN_IN_FAILED);
    expect(calls).toEqual([]);
  });

  it("dispatches nothing further once the budget is spent by an earlier step", async () => {
    const clock = fakeClock();
    const { page, calls } = mockPage({
      goto: async (...args) => {
        calls.push({ method: "goto", args });
        clock.t += 1000;
      },
    });
    const message = await messageOf(
      walkFakeSignInSanitized(page, startHref, 1000, clock)
    );
    expect(message).toBe(FAKE_SIGN_IN_FAILED);
    expect(calls.map((c) => c.method)).toEqual(["goto"]);
  });

  it("never sleeps past the deadline", async () => {
    const clock = fakeClock();
    const { page } = mockPage({ urls: [consent] } as Partial<FakeSignInPage>);
    await messageOf(walkFakeSignInSanitized(page, startHref, 250, clock));
    expect(clock.sleeps).toEqual([100, 100, 50]);
    expect(clock.t).toBe(250);
  });

  it("hands a hung evaluate a cut-off, so a late evaluation cannot navigate after expiry", async () => {
    const clock = fakeClock();
    let late: (() => void) | undefined;
    const assigned: string[] = [];
    const { page } = mockPage({
      evaluate: (fn, arg) =>
        new Promise<never>(() => {
          // The page context arrives only after the walk has given up.
          late = () => {
            const g = globalThis as Record<string, unknown>;
            const saved = {
              window: g.window,
              setTimeout: g.setTimeout,
              Date: g.Date,
            };
            g.window = {
              location: { assign: (href: string) => assigned.push(href) },
            };
            g.setTimeout = (step: () => void) => step();
            g.Date = { now: () => clock.wallNow() };
            try {
              fn(arg);
            } finally {
              g.window = saved.window;
              g.setTimeout = saved.setTimeout;
              g.Date = saved.Date;
            }
          };
        }),
    });
    const message = await messageOf(
      walkFakeSignInSanitized(page, startHref, 1000, clock)
    );
    expect(message).toBe(FAKE_SIGN_IN_FAILED);
    clock.t += 5000; // the walk has expired
    late?.();
    expect(assigned).toEqual([]);
  });

  it("measures the deadline on the monotonic clock, not the wall clock", async () => {
    const clock = fakeClock();
    clock.wallNow = () => 0; // a wall clock jumping backwards must not extend the walk
    const { page } = mockPage({ urls: [consent] } as Partial<FakeSignInPage>);
    const message = await messageOf(
      walkFakeSignInSanitized(page, startHref, 300, clock)
    );
    expect(message).toBe(FAKE_SIGN_IN_FAILED);
    expect(clock.t).toBe(300);
  });
});
