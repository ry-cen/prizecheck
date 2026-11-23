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

/**
 * What the in-page function gets: the start address and the age, on the blank document's own monotonic clock
 * (`performance.now()`), after which it must not navigate.
 */
export type StartNavigationArg = { href: string; notAfterDocMs: number };

/** The slice of Playwright's Page the sanitized walk uses, so a test can stand in a mock. */
export type FakeSignInPage = {
  goto(
    url: string,
    options: { waitUntil: "commit"; timeout: number }
  ): Promise<unknown>;
  evaluate(
    pageFunction: (arg: StartNavigationArg) => void,
    arg: StartNavigationArg
  ): Promise<unknown>;
  url(): string;
  waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
};

/**
 * Page-side: schedule the navigation and return at once, so the call is never cut off by the document changing.
 * A timed-out page.evaluate can stay active (Playwright gives evaluate no timeout, and it can wait for a frame context
 * that arrives late), so the function refuses to navigate once the blank document's age reaches `notAfterDocMs`, both
 * when it starts and when the scheduled step fires. The age is `performance.now()`, a monotonic clock tied to that
 * document, so a wall clock moving backwards cannot extend it, and a late start sees a large age. It must stay
 * self-contained: Playwright serializes it into the page.
 */
export function startNavigationInPage(arg: StartNavigationArg): void {
  if (performance.now() >= arg.notAfterDocMs) return;
  setTimeout(() => {
    if (performance.now() < arg.notAfterDocMs) window.location.assign(arg.href);
  }, 0);
}

export type FakeSignInClock = {
  /** Monotonic milliseconds: deadlines are measured on this. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Runs `fn` after `ms` unless the returned function cancels it first. */
  after(ms: number, fn: () => void): () => void;
};

const realClock: FakeSignInClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Starts `work` only if budget remains before the absolute monotonic `deadlineAt`, then settles with it or rejects with
 * the fixed message once the deadline passes; any rejection of `work` is fixed text too. With no budget nothing is
 * dispatched, and a result that settles after the deadline but before the expiry timer runs is refused.
 */
async function within<T>(
  work: () => Promise<T>,
  deadlineAt: number,
  clock: FakeSignInClock
): Promise<T> {
  const failed = () => new Error(FAKE_SIGN_IN_FAILED);
  const ms = deadlineAt - clock.now();
  if (ms <= 0) throw failed();
  // Detach the loser of the race so a late rejection of `work` is never unhandled.
  const guarded = work().catch(() => {
    throw failed();
  });
  guarded.catch(() => undefined);
  let cancel = () => {};
  const expiry = new Promise<never>((_, reject) => {
    cancel = clock.after(ms, () => reject(failed()));
  });
  try {
    const result = await Promise.race([guarded, expiry]);
    if (clock.now() >= deadlineAt) throw failed();
    return result;
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
 * read. One monotonic deadline covers initiation, polling and the load wait, and is checked before each dispatch; every failure is the same fixed text.
 */
export async function walkFakeSignInSanitized(
  page: FakeSignInPage,
  startHref: string,
  deadlineMs: number,
  clock: FakeSignInClock = realClock
): Promise<void> {
  const began = clock.now();
  const deadlineAt = began + deadlineMs;
  const remaining = () => deadlineAt - clock.now();
  // Start from a blank page, so a leftover app address is never read as "the walk has finished".
  await within(
    () =>
      page.goto("about:blank", {
        waitUntil: "commit",
        timeout: Math.max(1, remaining()),
      }),
    deadlineAt,
    clock
  );
  // The blank document was created when goto committed; its age is measured from here on its own monotonic clock.
  const blankAt = clock.now();
  await within(
    () => {
      // The cut-off is the blank document's age at which this walk's whole budget ends.
      const notAfterDocMs = clock.now() - blankAt + remaining();
      return page.evaluate(startNavigationInPage, {
        href: startHref,
        notAfterDocMs,
      });
    },
    deadlineAt,
    clock
  );
  for (;;) {
    const elapsed = clock.now() - began;
    const poll = pollFakeSignIn(page.url(), elapsed, deadlineMs);
    if (poll.state === "failed") throw new Error(poll.message);
    if (poll.state === "done") break;
    // Never sleep past the deadline.
    await clock.sleep(Math.min(100, deadlineMs - elapsed));
  }
  // The load wait's own timeout message names no URL; it is replaced anyway.
  await within(
    () => page.waitForLoadState("load", { timeout: Math.max(1, remaining()) }),
    deadlineAt,
    clock
  );
}
