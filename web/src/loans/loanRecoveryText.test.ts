import { expect, test } from "vitest";
import { DURABLE_KINDS } from "./loanAttempt";
import {
  pendingHeadline,
  RECOVERY_TEXT,
  resultText,
  signInAs,
} from "./loanText";
test.each(DURABLE_KINDS)("%s has its headline", (kind) =>
  expect(pendingHeadline(kind)).toBe(RECOVERY_TEXT[kind])
);
test("resultText maps each outcome", () => {
  expect(resultText({ kind: "done", response: undefined })).toBe(
    "It was sent."
  );
  expect(
    resultText({ kind: "voided", refusal: null, otherAccount: false })
  ).toBe("It wasn't sent.");
  expect(
    resultText({ kind: "voided", refusal: null, otherAccount: true })
  ).toBe(RECOVERY_TEXT.otherAccount);
  for (const kind of [
    "busy",
    "not_saved",
    "no_locks",
    "settled_elsewhere",
  ] as const)
    expect(resultText({ kind })).toBe(RECOVERY_TEXT[kind]);
  expect(resultText({ kind: "stale" })).toBeNull();
  expect(resultText({ kind: "not_sent" })).toBe("It wasn't sent.");
  expect(signInAs(null)).toBe(RECOVERY_TEXT.signBackIn);
  expect(signInAs("Ana")).toBe("Sign in as Ana to finish this.");
});
test("no recovery copy contains an id, key, time or storage word", () => {
  for (const text of Object.values(RECOVERY_TEXT))
    expect(text).not.toMatch(
      /[0-9a-f]{8}-|key|storage|local|cache|epoch|\d{1,2}:\d{2}/i
    );
});
