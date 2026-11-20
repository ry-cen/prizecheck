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
