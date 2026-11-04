import { expect, it } from "vitest";
import type { Timeline, TimelineItem } from "../social_generated";
import { mergeTimeline } from "./timelineHistory";
const item = (n: number): TimelineItem => ({
  kind: "event",
  at: `2026-11-04T10:00:${String(n).padStart(2, "0")}Z`,
  cursor: `c${n}`,
  event: {
    id: `e${n}`,
    round_id: "private",
    at: "2026-11-04T10:00:00Z",
    actor: null,
    kind: "accepted",
  },
});
const page = (ids: number[], cursor: string | null): Timeline => ({
  you_are: "low",
  items: ids.map(item),
  next_before: cursor,
});
it("retains paged rows and their older cursor when a pulse overlaps the loaded head", () => {
  const old = mergeTimeline(page([4, 3], "c3"), page([2, 1], "c1"), false);
  const next = mergeTimeline(old, page([5, 4], "c4"), true);
  expect(next.items.map((i) => i.cursor)).toEqual([
    "c5",
    "c4",
    "c3",
    "c2",
    "c1",
  ]);
  expect(next.next_before).toBe("c1");
});
it("fills a burst's missing interval without losing already loaded history or skipping the tail", () => {
  let log = mergeTimeline(page([3, 2, 1], "c1"), page([8, 7], "c7"), true);
  expect(log.next_before).toBe("c7");
  log = mergeTimeline(log, page([6, 5], "c5"), false);
  log = mergeTimeline(log, page([4, 3], "c3"), false);
  log = mergeTimeline(log, page([2, 1], "c1"), false);
  log = mergeTimeline(log, page([0], null), false);
  expect(log.items.map((i) => i.cursor)).toEqual([
    "c8",
    "c7",
    "c6",
    "c5",
    "c4",
    "c3",
    "c2",
    "c1",
    "c0",
  ]);
  expect(log.next_before).toBeNull();
});
it("keeps equal timestamp ordering deterministic and replaces duplicate snapshots", () => {
  const old = item(1);
  const next = { ...item(2), at: old.at };
  const log = mergeTimeline(
    page([], null),
    {
      you_are: "low",
      items: [old, next, { ...old, event: { ...old.event!, kind: "swapped" } }],
    },
    false
  );
  expect(log.items.map((i) => i.cursor)).toEqual(["c2", "c1"]);
  expect(log.items[1].event?.kind).toBe("swapped");
});
