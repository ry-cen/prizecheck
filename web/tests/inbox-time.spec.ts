import { expect, test } from "@playwright/test";
import { inboxTime } from "../src/inbox/inboxTime";

// Owner's decision (2026-10-16): each inbox update says when it happened, "just now" to "6 days ago" under a week,
// then the day, with the year when it isn't this year. The instants are at midday UTC, so the calendar day is the same
// in any time zone the host runs in.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = "2026-10-03T12:00:00Z";
const after = (ms: number) => Date.parse(at) + ms;

test("an inbox update says how long ago it happened, in whole units, under a week", () => {
  expect(inboxTime(at, after(0))).toBe("just now");
  expect(inboxTime(at, after(MINUTE - 1))).toBe("just now");
  // A time a moment ahead, when the two clocks disagree.
  expect(inboxTime(at, after(-5 * MINUTE))).toBe("just now");
  expect(inboxTime(at, after(MINUTE))).toBe("1 minute ago");
  expect(inboxTime(at, after(HOUR - 1))).toBe("59 minutes ago");
  expect(inboxTime(at, after(HOUR))).toBe("1 hour ago");
  expect(inboxTime(at, after(3 * HOUR + 59 * MINUTE))).toBe("3 hours ago");
  expect(inboxTime(at, after(DAY - 1))).toBe("23 hours ago");
  expect(inboxTime(at, after(DAY))).toBe("1 day ago");
  expect(inboxTime(at, after(2 * DAY))).toBe("2 days ago");
  expect(inboxTime(at, after(7 * DAY - 1))).toBe("6 days ago");
});

test("from a week on an inbox update says the day, with the year only when it isn't this year", () => {
  expect(inboxTime(at, after(7 * DAY), "en-US")).toBe("Oct 3");
  expect(inboxTime(at, Date.parse("2026-12-30T12:00:00Z"), "en-US")).toBe(
    "Oct 3"
  );
  expect(inboxTime(at, Date.parse("2027-01-02T12:00:00Z"), "en-US")).toBe(
    "Oct 3, 2026"
  );
  // In the collector's own locale.
  expect(inboxTime(at, after(7 * DAY), "en-GB")).toBe("3 Oct");
});
