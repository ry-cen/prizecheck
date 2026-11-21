// The decision logic behind the sanitized fake sign-in wait (web/tests/support/sign-in.ts). It is pure so a test can
// feed it inert marker URLs. Every message is fixed text: none carries a URL, code, state or nested error text.

export const FAKE_SIGN_IN_FAILED = "Fake sign-in did not complete";

export type FakeSignInProgress = "pending" | "done";

/**
 * Whether the browser has left the fake walk (consent page, /api/auth/ and /auth/ routes). Only the protocol and the
 * pathname are read; a blank, unparsable or non-http(s) address is still pending.
 */
export function fakeSignInProgress(url: string): FakeSignInProgress {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "pending";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return "pending";
  const path = parsed.pathname;
  return path !== "/auth/__fake-oauth/consent" &&
    !path.startsWith("/api/auth/") &&
    !path.startsWith("/auth/")
    ? "done"
    : "pending";
}

/** The outcome of one poll: keep waiting, finished, or failed with fixed text once the deadline has passed. */
export type FakeSignInPoll =
  { state: "pending" | "done" } | { state: "failed"; message: string };

export function pollFakeSignIn(
  url: string,
  elapsedMs: number,
  deadlineMs: number
): FakeSignInPoll {
  if (fakeSignInProgress(url) === "done") return { state: "done" };
  if (elapsedMs >= deadlineMs)
    return { state: "failed", message: FAKE_SIGN_IN_FAILED };
  return { state: "pending" };
}

/** The slice of Playwright's Page the sanitized walk uses, so a test can stand in a mock. */
export type FakeSignInPage = {
  goto(
    url: string,
    options: { waitUntil: "commit"; timeout: number }
  ): Promise<unknown>;
  evaluate(pageFunction: (href: string) => void, arg: string): Promise<unknown>;
  url(): string;
  waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
};

/** Page-side: schedule the navigation and return at once, so the call is never cut off by the document changing. */
export function startNavigationInPage(href: string): void {
  setTimeout(() => window.location.assign(href), 0);
}

export type FakeSignInClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Runs `fn` after `ms` unless the returned function cancels it first. */
  after(ms: number, fn: () => void): () => void;
};

const realClock: FakeSignInClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** Settles with `work`, or rejects with the fixed message once `ms` has passed; any rejection of `work` is fixed text too. */
async function within<T>(
  work: Promise<T>,
  ms: number,
  clock: FakeSignInClock
): Promise<T> {
  const failed = () => new Error(FAKE_SIGN_IN_FAILED);
  // Detach the loser of the race so a late rejection of `work` is never unhandled.
  const guarded = work.catch(() => {
    throw failed();
  });
  guarded.catch(() => undefined);
  if (ms <= 0) throw failed();
  let cancel = () => {};
  const expiry = new Promise<never>((_, reject) => {
    cancel = clock.after(ms, () => reject(failed()));
  });
  try {
    return await Promise.race([guarded, expiry]);
  } finally {
    cancel();
  }
}

/**
 * The sanitized fake sign-in walk. The credential-bearing navigation is started from inside the page (an evaluate whose
 * only argument is the start address, which carries the identity and `next`, never a code or state), not by
 * page.goto: goto's interrupted-navigation error interpolates the winning document's URL
 * (playwright-core/lib/coreBundle.js:23626), and the runner records that message as a step error before any catch runs.
 * Every Playwright call here has fixed parameters or only the start address; the walk then reads page.url(), a local
 * read. One deadline covers initiation, polling and the load wait; every failure is the same fixed text.
 */
export async function walkFakeSignInSanitized(
  page: FakeSignInPage,
  startHref: string,
  deadlineMs: number,
  clock: FakeSignInClock = realClock
): Promise<void> {
  const began = clock.now();
  const remaining = () => deadlineMs - (clock.now() - began);
  // Start from a blank page, so a leftover app address is never read as "the walk has finished".
  await within(
    page.goto("about:blank", {
      waitUntil: "commit",
      timeout: Math.max(1, remaining()),
    }),
    remaining(),
    clock
  );
  await within(
    page.evaluate(startNavigationInPage, startHref),
    remaining(),
    clock
  );
  for (;;) {
    const poll = pollFakeSignIn(page.url(), clock.now() - began, deadlineMs);
    if (poll.state === "failed") throw new Error(poll.message);
    if (poll.state === "done") break;
    await clock.sleep(100);
  }
  // The load wait's own timeout message names no URL; it is replaced anyway.
  await within(
    page.waitForLoadState("load", { timeout: Math.max(1, remaining()) }),
    remaining(),
    clock
  );
}
