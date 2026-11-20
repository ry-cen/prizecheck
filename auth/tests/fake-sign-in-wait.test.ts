import { describe, expect, it } from "vitest";
import {
  FAKE_SIGN_IN_FAILED,
  fakeSignInProgress,
  pollFakeSignIn,
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
